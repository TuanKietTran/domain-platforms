import { DomainError } from '../core/errors.js';
import { compareMoney, formatMoney, type Money } from '../core/types.js';

export type FactValue = number | string | boolean | null | readonly string[] | Money;

export type FactBag = Readonly<Record<string, FactValue>>;

export type Comparator =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'not_in'
  | 'contains_any'
  | 'contains_all'
  | 'matches'
  | 'exists'
  | 'not_exists';

export type RuleCondition =
  | { readonly kind: 'compare'; readonly fact: string; readonly op: Comparator; readonly value?: FactValue }
  | { readonly kind: 'all'; readonly conditions: readonly RuleCondition[] }
  | { readonly kind: 'any'; readonly conditions: readonly RuleCondition[] }
  | { readonly kind: 'none'; readonly conditions: readonly RuleCondition[] };

export type ConditionTrace =
  | {
      readonly kind: 'compare';
      readonly fact: string;
      readonly op: Comparator;
      readonly expected?: FactValue;
      readonly actual?: FactValue;
      readonly present: boolean;
      readonly result: boolean;
      readonly explanation: string;
    }
  | { readonly kind: 'group'; readonly op: 'all' | 'any' | 'none'; readonly result: boolean; readonly children: readonly ConditionTrace[]; readonly explanation: string };

function describe(value: FactValue | undefined): string {
  if (value === undefined) return 'not provided';
  if (value === null) return 'null';
  if (typeof value === 'object' && 'amountMinor' in value) return formatMoney(value);
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

function asMoney(value: FactValue): Money | undefined {
  return typeof value === 'object' && value !== null && 'amountMinor' in value ? value : undefined;
}

function compare(fact: FactValue | undefined, op: Comparator, expected: FactValue | undefined): boolean {
  const present = fact !== undefined;
  if (op === 'exists') return present && fact !== null;
  if (op === 'not_exists') return !present || fact === null;
  if (!present || fact === null) return false;

  if (op === 'contains_any' || op === 'contains_all') {
    const actual = Array.isArray(fact) ? fact : [String(fact)];
    const wanted = Array.isArray(expected) ? expected : [String(expected ?? '')];
    return op === 'contains_any'
      ? wanted.some((item) => actual.includes(item))
      : wanted.every((item) => actual.includes(item));
  }

  if (op === 'in' || op === 'not_in') {
    const list = Array.isArray(expected) ? expected : [String(expected ?? '')];
    const hit = list.some((item) => item === fact);
    return op === 'in' ? hit : !hit;
  }

  if (op === 'matches') {
    if (typeof fact !== 'string') return false;
    const pattern = String(expected ?? '');
    let regex: RegExp;
    try {
      regex = new RegExp(`^(?:${pattern})$`);
    } catch {
      throw new DomainError('RULE_INVALID', 'Invalid regular expression in policy rule', { pattern });
    }
    return regex.test(fact);
  }

  if (op === 'eq') return Array.isArray(fact) && Array.isArray(expected) ? String(fact) === String(expected) : fact === expected;
  if (op === 'neq') return !(fact === expected);

  const leftMoney = asMoney(fact);
  const rightMoney = expected === undefined ? undefined : asMoney(expected);
  let left: number;
  let right: number;
  if (leftMoney && rightMoney) {
    const cmp = compareMoney(leftMoney, rightMoney);
    if (cmp === 0) return op === 'lte' || op === 'gte';
    return applyOrder(cmp === -1 ? 'lt' : 'gt', op);
  }
  if (leftMoney || rightMoney) {
    throw new DomainError('RULE_INVALID', 'Cannot order money against a non-money value', { fact, expected });
  }
  if (typeof fact !== 'number' || typeof expected !== 'number') {
    throw new DomainError('RULE_INVALID', 'Ordering comparisons require numbers or money', { fact, expected });
  }
  left = fact;
  right = expected;
  if (left === right) return op === 'lte' || op === 'gte';
  return applyOrder(left < right ? 'lt' : 'gt', op);
}

function applyOrder(cmp: 'lt' | 'gt', op: Comparator): boolean {
  switch (op) {
    case 'lt':
      return cmp === 'lt';
    case 'lte':
      return cmp === 'lt';
    case 'gt':
      return cmp === 'gt';
    case 'gte':
      return cmp === 'gt';
    default:
      return false;
  }
}

const OP_LABEL: Record<Comparator, string> = {
  eq: '=',
  neq: '!=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  in: 'in',
  not_in: 'not in',
  contains_any: 'contains any of',
  contains_all: 'contains all of',
  matches: 'matches',
  exists: 'is present',
  not_exists: 'is absent',
};

/** Evaluate a condition and return both the boolean and an explainable trace. */
export function evaluateCondition(condition: RuleCondition, facts: FactBag): ConditionTrace {
  if (condition.kind === 'compare') {
    const actual = facts[condition.fact];
    const present = actual !== undefined;
    const result = compare(actual, condition.op, condition.value);
    const expectation =
      condition.op === 'exists' || condition.op === 'not_exists' ? '' : ` ${describe(condition.value ?? null)}`;
    return {
      kind: 'compare',
      fact: condition.fact,
      op: condition.op,
      ...(condition.value !== undefined ? { expected: condition.value } : {}),
      ...(actual !== undefined ? { actual } : {}),
      present,
      result,
      explanation: `${condition.fact} (${describe(actual)}) ${OP_LABEL[condition.op]}${expectation}`,
    };
  }
  const children = condition.conditions.map((child) => evaluateCondition(child, facts));
  const result =
    condition.kind === 'all'
      ? children.every((child) => child.result)
      : condition.kind === 'any'
        ? children.some((child) => child.result)
        : children.every((child) => !child.result);
  const joiner = condition.kind === 'all' ? ' AND ' : condition.kind === 'any' ? ' OR ' : ' AND NOT ';
  return {
    kind: 'group',
    op: condition.kind,
    result,
    children,
    explanation: `(${children.map((child) => child.explanation).join(joiner)})`,
  };
}

export function flattenFacts(trace: ConditionTrace, into: Set<string> = new Set()): ReadonlySet<string> {
  if (trace.kind === 'compare') {
    into.add(trace.fact);
  } else {
    for (const child of trace.children) flattenFacts(child, into);
  }
  return into;
}

export function conditionFacts(condition: RuleCondition, into: Set<string> = new Set()): ReadonlySet<string> {
  if (condition.kind === 'compare') {
    into.add(condition.fact);
  } else {
    for (const child of condition.conditions) conditionFacts(child, into);
  }
  return into;
}
