/**
 * Deterministic JSON serialisation used for hashing and audit verification.
 * Object keys are sorted, undefined members are dropped, and cycles are
 * rejected so that two logically equal values always hash identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value, new Set()));
}

function normalise(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Cannot canonicalise a non-finite number');
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Cannot canonicalise a cyclic structure');
    seen.add(value);
    const result = value.map((item) => normalise(item, seen));
    seen.delete(value);
    return result;
  }
  if (seen.has(value as object)) throw new TypeError('Cannot canonicalise a cyclic structure');
  seen.add(value as object);
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    result[key] = normalise(item, seen);
  }
  seen.delete(value as object);
  return result;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
