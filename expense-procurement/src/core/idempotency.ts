import { createHash } from 'node:crypto';
import { canonicalJson, deepClone, deepFreeze } from './canonical.js';
import { DomainError } from './errors.js';
import type { TenantId } from './types.js';

export interface IdempotencyRecord<T = unknown> {
  readonly key: string;
  readonly tenantId: TenantId;
  readonly operation: string;
  readonly requestHash: string;
  readonly result: T;
  readonly recordedAt: string;
}

export interface IdempotentCommand<T = unknown> {
  readonly tenantId: TenantId;
  readonly key: string;
  readonly operation: string;
  readonly request: unknown;
}

export interface IdempotencyRegistryOptions {
  readonly now?: () => Date;
  /** Maximum retained records; oldest are evicted first. Default 10000. */
  readonly maxRecords?: number;
  /** Optional record lifetime; expired records may be applied again. */
  readonly ttlMs?: number;
}

function fail(code: 'VALIDATION' | 'UNSUPPORTED' | 'CONFLICT', message: string, details: Record<string, unknown> = {}): never {
  throw new DomainError(code, message, details);
}

function requireField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('VALIDATION', `${field} is required`, { field });
  return (value as string).trim();
}

/** Type-tagged encoding: values that canonicalJson collapsed (Map vs {}, Date vs its ISO string, [undefined] vs [null], {a:undefined} vs {}) hash differently here, and non-plain requests are rejected instead of silently colliding. */
function encodeRequest(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'undefined') return 'undefined';
  if (t === 'boolean') return `bool:${value}`;
  if (t === 'string') return `str:${JSON.stringify(value)}`;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) fail('VALIDATION', 'Request must not contain non-finite numbers');
    return `num:${Object.is(value, -0) ? '-0' : String(value)}`;
  }
  if (t === 'bigint') return `bigint:${value}`;
  if (t !== 'object') fail('VALIDATION', `Request must be plain data, got ${t}`);
  const obj = value as object;
  if (seen.has(obj)) fail('VALIDATION', 'Request must not be cyclic');
  if (obj instanceof Date) {
    if (Number.isNaN(obj.getTime())) fail('VALIDATION', 'Request must not contain an invalid Date');
    return `date:${obj.toISOString()}`;
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `arr:[${obj.map((item) => encodeRequest(item, seen)).join(',')}]`;
    if (obj instanceof Map) {
      const parts = [...obj.entries()].map(([k, v]) => `${encodeRequest(k, seen)}=>${encodeRequest(v, seen)}`).sort();
      return `map:{${parts.join(',')}}`;
    }
    if (obj instanceof Set) {
      const parts = [...obj.values()].map((v) => encodeRequest(v, seen)).sort();
      return `set:{${parts.join(',')}}`;
    }
    const proto = Object.getPrototypeOf(obj) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      fail('VALIDATION', 'Request must be plain data: only plain objects, arrays, Map, Set and Date are supported', { type: (obj as { constructor?: { name?: string } }).constructor?.name });
    }
    const keys = Object.keys(obj).sort();
    return `obj:{${keys.map((k) => `${JSON.stringify(k)}:${encodeRequest((obj as Record<string, unknown>)[k], seen)}`).join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

function fingerprint(request: unknown): string {
  try {
    return createHash('sha256').update(encodeRequest(request, new Set())).digest('hex');
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('VALIDATION', 'Request cannot be fingerprinted', { reason: String((error as Error)?.message ?? error) });
  }
}

function isThenable(value: unknown): boolean {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';
}

function validateResultValue(value: unknown, seen: Set<object>): void {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean' || t === 'bigint') return;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) fail('UNSUPPORTED', 'Result must not contain non-finite numbers');
    return;
  }
  if (t !== 'object') fail('UNSUPPORTED', `Result must be plain cloneable data, got ${t}`);
  if (isThenable(value)) fail('UNSUPPORTED', 'Async result: use executeAsync for asynchronous commands');
  const obj = value as object;
  if (seen.has(obj)) fail('UNSUPPORTED', 'Result must not be cyclic');
  if (obj instanceof Date) {
    if (Number.isNaN(obj.getTime())) fail('UNSUPPORTED', 'Result must not contain an invalid Date');
    return;
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) { for (const item of obj) validateResultValue(item, seen); return; }
    if (obj instanceof Map) { for (const [k, v] of obj.entries()) { validateResultValue(k, seen); validateResultValue(v, seen); } return; }
    if (obj instanceof Set) { for (const v of obj.values()) validateResultValue(v, seen); return; }
    const proto = Object.getPrototypeOf(obj) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      fail('UNSUPPORTED', 'Result must be plain cloneable data: class instances lose their prototype when cloned', { type: (obj as { constructor?: { name?: string } }).constructor?.name });
    }
    for (const v of Object.values(obj as Record<string, unknown>)) validateResultValue(v, seen);
  } finally {
    seen.delete(obj);
  }
}

/** Clone + deep-freeze what will be stored, so neither the caller's original nor any handed-out copy can mutate the recorded result, and replay returns the same shape as the first call. */
function prepareResult<T>(result: T): T {
  if (isThenable(result)) fail('UNSUPPORTED', 'Async result: use executeAsync for asynchronous commands');
  validateResultValue(result, new Set());
  try {
    return deepFreeze(deepClone(result));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('UNSUPPORTED', 'Result could not be cloned', { reason: String((error as Error)?.message ?? error) });
  }
}

interface ValidatedCommand {
  readonly tenantId: TenantId;
  readonly operation: string;
  readonly key: string;
  readonly storageKey: string;
  readonly requestHash: string;
}

function validateCommand(command: IdempotentCommand<unknown>): ValidatedCommand {
  if (!command || typeof command !== 'object') fail('VALIDATION', 'Command is required');
  const tenantId = requireField(command.tenantId, 'Tenant id') as TenantId;
  const operation = requireField(command.operation, 'Operation');
  const key = requireField(command.key, 'Idempotency key');
  return { tenantId, operation, key, storageKey: canonicalJson([tenantId, operation, key]), requestHash: fingerprint(command.request) };
}

function validateLookup(tenantId: unknown, operation: unknown, key: unknown): { tenantId: TenantId; operation: string; key: string; storageKey: string } {
  const tenant = requireField(tenantId, 'Tenant id') as TenantId;
  const op = requireField(operation, 'Operation');
  const k = requireField(key, 'Idempotency key');
  return { tenantId: tenant, operation: op, key: k, storageKey: canonicalJson([tenant, op, k]) };
}
/**
 * Replay-safe command registry (in-process scope).
 *
 * The same key with the same request returns the original result instead of
 * applying a financial or approval mutation twice. The same key with a
 * different request is a hard conflict rather than a silent overwrite.
 * Storage keys are the canonical JSON of [tenantId, operation, key], so
 * delimiter characters inside any component cannot collide with another
 * combination. Records are bounded (maxRecords, oldest evicted) and may be
 * given a TTL; persistence across processes is out of scope for this class.
 */
export class IdempotencyRegistry {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly inFlight = new Map<string, { readonly requestHash: string; readonly promise: Promise<IdempotencyRecord> }>();
  private readonly nowFn: () => Date;
  private readonly maxRecords: number;
  private readonly ttlMs?: number;

  constructor(nowOrOptions: (() => Date) | IdempotencyRegistryOptions = {}) {
    const options: IdempotencyRegistryOptions = typeof nowOrOptions === 'function' ? { now: nowOrOptions } : nowOrOptions;
    this.nowFn = options.now ?? (() => new Date());
    this.maxRecords = options.maxRecords ?? 10_000;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1) fail('VALIDATION', 'maxRecords must be a positive integer', { maxRecords: this.maxRecords });
    this.ttlMs = options.ttlMs;
    if (this.ttlMs !== undefined && (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0)) fail('VALIDATION', 'ttlMs must be a positive number', { ttlMs: this.ttlMs });
  }

  private currentTime(): Date {
    const date = this.nowFn();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) fail('VALIDATION', 'Clock returned an invalid date');
    return new Date(date.getTime());
  }

  private mismatch(cmd: ValidatedCommand): never {
    throw new DomainError('IDEMPOTENCY_MISMATCH', 'Idempotency key reused with a different request', { operation: cmd.operation, key: cmd.key });
  }

  private liveRecord(storageKey: string, nowMs: number): IdempotencyRecord | undefined {
    const record = this.records.get(storageKey);
    if (!record) return undefined;
    if (this.ttlMs !== undefined && nowMs - Date.parse(record.recordedAt) >= this.ttlMs) {
      this.records.delete(storageKey);
      return undefined;
    }
    return record;
  }

  private checkExisting(cmd: ValidatedCommand, nowMs: number): IdempotencyRecord | undefined {
    const existing = this.liveRecord(cmd.storageKey, nowMs);
    if (existing && existing.requestHash !== cmd.requestHash) this.mismatch(cmd);
    return existing;
  }

  private prune(nowMs: number): void {
    if (this.ttlMs !== undefined) {
      for (const [storageKey, record] of this.records) {
        if (nowMs - Date.parse(record.recordedAt) >= this.ttlMs) this.records.delete(storageKey);
      }
    }
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  private store<T>(cmd: ValidatedCommand, storedResult: T, recordedAt: string, nowMs: number): IdempotencyRecord<T> {
    const record: IdempotencyRecord<T> = Object.freeze({
      key: cmd.key,
      tenantId: cmd.tenantId,
      operation: cmd.operation,
      requestHash: cmd.requestHash,
      result: storedResult,
      recordedAt,
    });
    this.records.set(cmd.storageKey, record as IdempotencyRecord);
    this.prune(nowMs);
    return record;
  }

  execute<T>(command: IdempotentCommand<T>, apply: () => T): T {
    const cmd = validateCommand(command);
    const now = this.currentTime();
    const existing = this.checkExisting(cmd, now.getTime());
    if (existing) return deepClone(existing.result) as T;
    const flight = this.inFlight.get(cmd.storageKey);
    if (flight) {
      if (flight.requestHash !== cmd.requestHash) this.mismatch(cmd);
      fail('CONFLICT', 'Command is already in progress', { operation: cmd.operation, key: cmd.key });
    }
    const result = apply();
    const stored = prepareResult(result);
    this.store(cmd, stored, now.toISOString(), now.getTime());
    return deepClone(stored) as T;
  }

  async executeAsync<T>(command: IdempotentCommand<T>, apply: () => Promise<T> | T): Promise<T> {
    const cmd = validateCommand(command);
    const now = this.currentTime();
    const existing = this.checkExisting(cmd, now.getTime());
    if (existing) return deepClone(existing.result) as T;
    const flight = this.inFlight.get(cmd.storageKey);
    if (flight) {
      if (flight.requestHash !== cmd.requestHash) this.mismatch(cmd);
      const record = await flight.promise;
      return deepClone(record.result) as T;
    }
    const task = (async (): Promise<IdempotencyRecord> => {
      const result = await apply();
      const stored = prepareResult(result);
      return this.store(cmd, stored, now.toISOString(), now.getTime()) as IdempotencyRecord;
    })();
    const entry = { requestHash: cmd.requestHash, promise: task };
    this.inFlight.set(cmd.storageKey, entry);
    try {
      const record = await task;
      return deepClone(record.result) as T;
    } finally {
      if (this.inFlight.get(cmd.storageKey) === entry) this.inFlight.delete(cmd.storageKey);
    }
  }

  has(tenantId: TenantId, operation: string, key: string): boolean {
    const { storageKey } = validateLookup(tenantId, operation, key);
    return this.liveRecord(storageKey, this.currentTime().getTime()) !== undefined;
  }

  get<T>(tenantId: TenantId, operation: string, key: string): IdempotencyRecord<T> | undefined {
    const { storageKey } = validateLookup(tenantId, operation, key);
    const record = this.liveRecord(storageKey, this.currentTime().getTime());
    return record ? (deepFreeze(deepClone(record)) as IdempotencyRecord<T>) : undefined;
  }

  size(): number {
    this.prune(this.currentTime().getTime());
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }
}
