export interface RenameDiffPart { text: string; changed: boolean }

function parts(characters: string[], stable: Set<number>): RenameDiffPart[] {
  const result: RenameDiffPart[] = [];
  characters.forEach((text, index) => {
    const changed = !stable.has(index);
    const previous = result.at(-1);
    if (previous?.changed === changed) previous.text += text;
    else result.push({ text, changed });
  });
  return result;
}

export function renameDiff(before: string, after: string): { before: RenameDiffPart[]; after: RenameDiffPart[] } {
  const a = Array.from(before), b = Array.from(after);
  const stableA = new Set<number>(), stableB = new Set<number>();
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) {
    stableA.add(prefix); stableB.add(prefix); prefix++;
  }
  while (suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]) {
    stableA.add(a.length - suffix - 1); stableB.add(b.length - suffix - 1); suffix++;
  }
  const m = a.length - prefix - suffix, n = b.length - prefix - suffix;
  // Valid Windows names are short; diagnostics can contain much larger failed output.
  if (m > 0 && n > 0 && m <= 512 && n <= 512) {
    const width = n + 1;
    const lengths = new Uint16Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lengths[i * width + j] = a[prefix + i] === b[prefix + j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[prefix + i] !== b[prefix + j]) {
        if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++; else j++;
        continue;
      }
      const startI = i, startJ = j;
      while (i < m && j < n && a[prefix + i] === b[prefix + j]) { i++; j++; }
      // A coincidental single letter/digit inside a replacement is shown with its
      // surrounding change, e.g. Test1 -> NEW_2026-09-12, rather than isolated "1".
      if (i - startI > 1 || !/^[a-z0-9]$/i.test(a[prefix + startI])) {
        for (let k = 0; k < i - startI; k++) {
          stableA.add(prefix + startI + k); stableB.add(prefix + startJ + k);
        }
      }
    }
  }
  return { before: parts(a, stableA), after: parts(b, stableB) };
}
