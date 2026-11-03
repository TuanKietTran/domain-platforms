import { DomainError, type ErrorCode } from '../core/errors.js';
import { Money } from './money.js';

const fail: (code: ErrorCode, message: string, details?: Record<string, unknown>) => never = (code, message, details) => {
  throw new DomainError(code, message, details);
};

const nonBlank = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) fail('VALIDATION', field + ' must be a non-blank string', { field });
  return value;
};

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface LedgerAccount {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly type: AccountType;
}

export interface PostingInput {
  readonly accountId: string;
  readonly debit?: Money;
  readonly credit?: Money;
}

export interface Posting {
  readonly accountId: string;
  readonly debit: Money | null;
  readonly credit: Money | null;
}

export interface JournalEntry {
  readonly id: string;
  readonly date: string;
  readonly memo: string;
  readonly postings: readonly Posting[];
  readonly reversalOf: string | null;
  readonly reversedBy: string | null;
}

export interface PostEntryInput {
  readonly id?: string;
  readonly date: string;
  readonly memo: string;
  readonly postings: readonly PostingInput[];
}

/**
 * Double-entry ledger. Entries are immutable once posted: a mistake is
 * fixed by a reversal entry that swaps debits and credits, never by an
 * edit. Every entry must balance per currency (total debits equal total
 * credits, in Money minor units), every posting targets a known account
 * in that account's currency, and entry/account ids are unique.
 */
export class Ledger {
  private readonly accounts = new Map<string, LedgerAccount>();
  private readonly entries = new Map<string, JournalEntry>();
  private sequence = 0;

  private nextEntryId(): string {
    let id = '';
    do { this.sequence += 1; id = 'je-' + this.sequence; } while (this.entries.has(id));
    return id;
  }

  addAccount(input: LedgerAccount): LedgerAccount {
    const id = nonBlank(input?.id, 'account id');
    const name = nonBlank(input?.name, 'account name');
    if (input?.type !== 'asset' && input?.type !== 'liability' && input?.type !== 'equity' && input?.type !== 'income' && input?.type !== 'expense') {
      fail('VALIDATION', 'account type is invalid', { type: String(input?.type) });
    }
    Money.zero(nonBlank(input?.currency, 'account currency'));
    if (this.accounts.has(id)) fail('CONFLICT', 'ledger account already exists', { accountId: id });
    const account: LedgerAccount = Object.freeze({ id, name, currency: input.currency, type: input.type });
    this.accounts.set(id, account);
    return account;
  }

  account(id: string): LedgerAccount {
    const found = this.accounts.get(id);
    if (!found) fail('NOT_FOUND', 'ledger account not found', { accountId: id });
    return found;
  }

  post(input: PostEntryInput): JournalEntry {
    return this.store(this.buildEntry(input, null));
  }

  private buildEntry(input: PostEntryInput, reversalOf: string | null): JournalEntry {
    const date = nonBlank(input?.date, 'entry date');
    if (Number.isNaN(Date.parse(date))) fail('VALIDATION', 'entry date must be a valid date string', { date });
    const memo = nonBlank(input?.memo, 'entry memo');
    if (!Array.isArray(input?.postings) || input.postings.length < 2) {
      fail('VALIDATION', 'a journal entry needs at least two postings', {});
    }
    const id = input.id === undefined ? this.nextEntryId() : nonBlank(input.id, 'entry id');
    if (this.entries.has(id)) fail('CONFLICT', 'journal entry already exists', { entryId: id });
    const totals = new Map<string, { debit: Money; credit: Money }>();
    const postings: Posting[] = input.postings.map((line) => {
      const account = this.account(nonBlank(line?.accountId, 'posting accountId'));
      const hasDebit = line.debit !== undefined && line.debit !== null;
      const hasCredit = line.credit !== undefined && line.credit !== null;
      if (hasDebit === hasCredit) fail('VALIDATION', 'each posting must have exactly one of debit or credit', { accountId: account.id });
      const amount = (hasDebit ? line.debit : line.credit) as Money;
      if (!(amount instanceof Money)) fail('VALIDATION', 'posting amounts must be Money', { accountId: account.id });
      if (!amount.isPositive()) fail('VALIDATION', 'posting amounts must be positive; use the other side instead of a negative', { accountId: account.id });
      if (amount.currency !== account.currency) {
        fail('MONEY_CURRENCY_MISMATCH', 'posting currency does not match the account currency', { accountId: account.id, accountCurrency: account.currency, postingCurrency: amount.currency });
      }
      const bucket = totals.get(amount.currency) ?? { debit: Money.zero(amount.currency), credit: Money.zero(amount.currency) };
      if (hasDebit) bucket.debit = bucket.debit.add(amount); else bucket.credit = bucket.credit.add(amount);
      totals.set(amount.currency, bucket);
      return Object.freeze({ accountId: account.id, debit: hasDebit ? amount : null, credit: hasCredit ? amount : null });
    });
    for (const [currency, bucket] of totals) {
      if (!bucket.debit.equals(bucket.credit)) {
        fail('LEDGER_UNBALANCED', 'journal entry does not balance in ' + currency, { currency, debits: bucket.debit.minorUnits.toString(), credits: bucket.credit.minorUnits.toString() });
      }
    }
    return Object.freeze({ id, date, memo, postings: Object.freeze(postings), reversalOf, reversedBy: null });
  }

  private store(entry: JournalEntry): JournalEntry {
    this.entries.set(entry.id, entry);
    return entry;
  }

  entry(id: string): JournalEntry {
    const found = this.entries.get(id);
    if (!found) fail('NOT_FOUND', 'journal entry not found', { entryId: id });
    return found;
  }

  listEntries(): readonly JournalEntry[] {
    return Object.freeze([...this.entries.values()]);
  }

  /** Signed balance: total debits minus total credits, in the account currency. */
  balance(accountId: string): Money {
    const account = this.account(accountId);
    let total = Money.zero(account.currency);
    for (const entry of this.entries.values()) {
      for (const posting of entry.postings) {
        if (posting.accountId !== accountId) continue;
        if (posting.debit) total = total.add(posting.debit);
        if (posting.credit) total = total.subtract(posting.credit);
      }
    }
    return total;
  }

  trialBalance(): ReadonlyMap<string, Money> {
    const result = new Map<string, Money>();
    for (const id of this.accounts.keys()) result.set(id, this.balance(id));
    return result;
  }

  /** Fix a posted entry by reversal, never by editing it. */
  reverse(entryId: string, input: { id?: string; date: string; memo?: string }): JournalEntry {
    const original = this.entry(entryId);
    if (original.reversedBy !== null) fail('CONFLICT', 'journal entry has already been reversed', { entryId, reversedBy: original.reversedBy });
    if (original.reversalOf !== null) fail('CONFLICT', 'a reversal entry cannot itself be reversed', { entryId, reversalOf: original.reversalOf });
    const reversal = this.buildEntry({
      id: input?.id,
      date: input?.date,
      memo: input?.memo === undefined ? 'Reversal of ' + original.id + ': ' + original.memo : input.memo,
      postings: original.postings.map((p) => p.debit ? { accountId: p.accountId, credit: p.debit } : { accountId: p.accountId, debit: p.credit as Money }),
    }, original.id);
    this.store(reversal);
    this.entries.set(original.id, Object.freeze({ ...original, reversedBy: reversal.id }));
    return reversal;
  }
}
