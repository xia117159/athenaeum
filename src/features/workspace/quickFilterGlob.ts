const LITERAL = 0, ANY = 1, STAR = 2;
export interface GlobProgram { kinds: number[]; chars: string[]; minimumPoints: number }

/** Consecutive stars are equivalent, so input length never multiplies matching
 * work merely because a user pasted redundant wildcards. */
export function compileGlob(pattern: string): GlobProgram {
  const kinds: number[] = [], chars: string[] = [];
  let minimumPoints = 0;
  for (const point of pattern.normalize("NFC")) {
    if (point === "*" && kinds.at(-1) === STAR) continue;
    const kind = point === "*" ? STAR : point === "?" ? ANY : LITERAL;
    kinds.push(kind); chars.push(kind === LITERAL ? point.toLowerCase() : "");
    if (kind !== STAR) minimumPoints++;
  }
  return { kinds, chars, minimumPoints };
}

/** Full-name glob matching. Retry only the most recent star: an earlier star
 * need not grow once the literal run leading to a later star has matched.
 * The first viable placement of each literal run preserves earliest-star
 * allocation. Captured positions roll back with the retry checkpoint.
 * Space is O(name length + pattern length), with no product-sized state graph. */
export function matchGlob(points: string[], glob: GlobProgram, capture = false): number[] | null {
  if (glob.minimumPoints > points.length) return null;
  const literals: number[] = [];
  let name = 0, pattern = 0, star = -1, starEnd = 0, checkpoint = 0;
  while (name < points.length) {
    const kind = glob.kinds[pattern];
    if (kind === STAR) {
      star = pattern++; starEnd = name; checkpoint = literals.length;
    } else if (kind === ANY || kind === LITERAL && glob.chars[pattern] === points[name]) {
      if (capture && kind === LITERAL) literals.push(name);
      name++; pattern++;
    } else if (star >= 0) {
      name = ++starEnd; pattern = star + 1; literals.length = checkpoint;
    } else return null;
  }
  while (glob.kinds[pattern] === STAR) pattern++;
  return pattern === glob.kinds.length ? literals : null;
}
