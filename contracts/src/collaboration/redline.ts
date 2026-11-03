export type ClauseChange = {
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
  clauseId: string;
  before?: string;
  after?: string;
  words?: { op: 'keep' | 'add' | 'del'; text: string }[];
};

type ClauseInput = { id: string; text: string };

type WordOp = { op: 'keep' | 'add' | 'del'; text: string };

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

function diffWords(before: string, after: string): WordOp[] {
  const a = splitWords(before);
  const b = splitWords(after);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = (dp[i - 1]?.[j - 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]?.[j] ?? 0, dp[i]?.[j - 1] ?? 0);
      }
    }
  }
  const reversed: WordOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const aWord = a[i - 1] as string;
    const bWord = b[j - 1] as string;
    if (aWord === bWord) {
      reversed.push({ op: 'keep', text: aWord });
      i--;
      j--;
    } else if ((dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0)) {
      reversed.push({ op: 'add', text: bWord });
      j--;
    } else {
      reversed.push({ op: 'del', text: aWord });
      i--;
    }
  }
  while (i > 0) {
    reversed.push({ op: 'del', text: a[i - 1] as string });
    i--;
  }
  while (j > 0) {
    reversed.push({ op: 'add', text: b[j - 1] as string });
    j--;
  }
  reversed.reverse();
  return reversed;
}

export function diffClauses(before: { id: string; text: string }[], after: { id: string; text: string }[]): ClauseChange[] {
  const beforeById = new Map<string, ClauseInput>();
  for (const clause of before) {
    if (!beforeById.has(clause.id)) {
      beforeById.set(clause.id, clause);
    }
  }
  const afterIds = new Set<string>();
  const result: ClauseChange[] = [];
  for (const clause of after) {
    afterIds.add(clause.id);
    const prev = beforeById.get(clause.id);
    if (prev === undefined) {
      result.push({ kind: 'added', clauseId: clause.id, after: clause.text });
    } else if (prev.text === clause.text) {
      result.push({ kind: 'unchanged', clauseId: clause.id, before: prev.text, after: clause.text });
    } else {
      result.push({ kind: 'changed', clauseId: clause.id, before: prev.text, after: clause.text, words: diffWords(prev.text, clause.text) });
    }
  }
  for (const clause of before) {
    if (!afterIds.has(clause.id)) {
      result.push({ kind: 'removed', clauseId: clause.id, before: clause.text });
    }
  }
  return result;
}
