import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuickFilter } from "./quickFilterMatcher";
import { renderEntryNameText } from "./entryNameHighlight";

function glob(pattern: string) {
  const compiled = compileQuickFilter(pattern, "wildcard", "highlight");
  assert.ok(compiled.ok); return compiled.program;
}

test("redundant stars and overlong required literals do not block filename rendering", () => {
  const program = glob("*".repeat(10000) + ".txt");
  const started = performance.now();
  for (let index = 0; index < 30; index++) {
    const name = "a".repeat(229) + index + ".txt";
    assert.equal(program.test(name), true);
    assert.deepEqual(program.ranges(name), [{ start: name.length - 4, end: name.length }]);
    renderEntryNameText(name, program);
  }
  assert.ok(performance.now() - started < 1500, "30 filenames with a pattern equivalent to *.txt must finish well below a multi-second stall");
  const impossible = glob("a".repeat(100000));
  assert.equal(impossible.test("a".repeat(240)), false);
  assert.deepEqual(impossible.ranges("a".repeat(240)), []);
});

test("wildcard literals follow the earliest viable star allocation", () => {
  // Exhaustive allocation oracle, independent from the production matching algorithm.
  function oracle(name: string, pattern: string, n = 0, p = 0, hits: number[] = []): number[] | null {
    if (p === pattern.length) return n === name.length ? hits : null;
    if (pattern[p] === "*") {
      for (let end = n; end <= name.length; end++) {
        const result = oracle(name, pattern, end, p + 1, hits);
        if (result) return result;
      }
      return null;
    }
    if (n === name.length || pattern[p] !== "?" && pattern[p] !== name[n]) return null;
    return oracle(name, pattern, n + 1, p + 1, pattern[p] === "?" ? hits : [...hits, n]);
  }
  function words(alphabet: string, max: number): string[] {
    let layer = [""]; const all = [...layer];
    for (let n = 0; n < max; n++) { layer = layer.flatMap(word => [...alphabet].map(char => word + char)); all.push(...layer); }
    return all;
  }
  for (const pattern of words("ab?*", 4).filter(Boolean)) {
    const program = glob(pattern);
    for (const name of words("ab", 4)) {
      const expected = oracle(name, pattern);
      assert.equal(program.test(name), expected !== null, `${pattern} / ${name}`);
      const actual = program.ranges(name).flatMap(range => Array.from({ length: range.end - range.start }, (_, i) => range.start + i));
      assert.deepEqual(actual, expected ?? [], `${pattern} / ${name}`);
    }
  }
});

test("recently read compile entries survive LRU eviction", () => {
  const compile = (text: string) => compileQuickFilter(text, "substring", "highlight");
  const hot = compile("resource-hot");
  for (let i = 0; i < 127; i++) compile(`resource-cold-${i}`);
  assert.equal(compile("resource-hot"), hot);
  compile("resource-new");
  assert.equal(compile("resource-hot"), hot);
});
