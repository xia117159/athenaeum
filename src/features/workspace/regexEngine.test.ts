import assert from "node:assert/strict";
import { test } from "node:test";
import { compileLinearRegex } from "./regexEngine";
import { assertMedianDurationWithin } from "./timingTestSupport";
import type { QuickFilterRange } from "./quickFilterTypes";

/**
 * 线性正则引擎的契约测试（spec §3.2/§3.3）。
 *
 * 本文件是"先红后绿"的 Red 端：引擎必须做到
 * 1. 支持日常正则子集，且**不误拒**合法模式（原启发式误拒 8/26）；
 * 2. 对任意输入都不得病态回溯（原实现在 255 字符名称上可冻结 >12s）；
 * 3. `test` 的存在性判定与 `new RegExp(src, "gi")` **逐例一致**；
 * 4. 拒绝时给出可读诊断，而不是含糊的"过于复杂"。
 */

function compile(source: string) {
  const result = compileLinearRegex(source);
  assert.equal(result.ok, true, `expected ${JSON.stringify(source)} to compile: ${result.ok ? "" : result.message}`);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function reason(source: string) {
  const result = compileLinearRegex(source);
  assert.equal(result.ok, false, `expected ${JSON.stringify(source)} to be rejected`);
  if (result.ok) throw new Error("unreachable");
  return result.message;
}

/** 参考实现：与既有 `regexRanges` 同语义的非重叠、从左到右全局扫描。 */
function referenceRanges(source: string, name: string): QuickFilterRange[] {
  const regex = new RegExp(source, "gi");
  const ranges: QuickFilterRange[] = [];
  let iterations = 0;
  let match = regex.exec(name);
  while (match && iterations < 10000) {
    iterations += 1;
    if (match[0].length > 0) ranges.push({ start: match.index, end: match.index + match[0].length });
    else regex.lastIndex = match.index + 1;
    if (regex.lastIndex > name.length) break;
    match = regex.exec(name);
  }
  return ranges;
}

function pairs(ranges: QuickFilterRange[]) {
  return ranges.map((range) => [range.start, range.end]);
}

// ---------------------------------------------------------------------------
// 1. 支持子集：日常正则必须全部接受（原启发式误拒 8/26）
// ---------------------------------------------------------------------------

test("linear regex accepts the everyday patterns the heuristic falsely rejected", () => {
  // 这 8 个模式在原实现下被"过于复杂"拒绝，但都能被 new RegExp 正常编译。
  for (const source of [
    "^\\d+\\.\\d+\\.\\d+\\.\\d+$",
    "(\\d+\\.){3}\\d+",
    "^v?\\d+(\\.\\d+){1,3}$",
    "\\w+\\s\\w+\\s\\w+\\s\\w+",
    "^(\\w+-)+\\w+$",
    "(\\d+_)+",
    "(\\w+_){2,}",
    "^(\\w+_)+\\w+$"
  ]) {
    assert.doesNotThrow(() => compile(source));
  }
});

test("linear regex accepts the supported subset construct by construct", () => {
  const supported = [
    "abc", "a.c", "a\\.c", "^abc$", "\\bword\\b", "\\Bmid",
    "\\d+", "\\D", "\\w+", "\\W", "\\s", "\\S",
    "[abc]", "[a-z]", "[^abc]", "[^a-z]", "[a-zA-Z0-9_]", "[]", "[^]", "[]]",
    "[\\d]", "[\\w-]", "[a-]", "[-a]", "[a^]", "[\\-]", "[\\.]",
    "(a)", "(?:a)", "(?<name>a)", "(a|b)", "(a|b|c)", "(a(b(c)))",
    "a*", "a+", "a?", "a{2}", "a{2,}", "a{2,4}", "a{0,4}",
    "colou?r", "^\\d{4}-\\d{2}-\\d{2}$", "IMG_\\d{4}\\.(jpg|png)",
    "\\.(txt|md|json)$", "^[^.]+$", "(.*)", "(.+)", "(.)*",
    "\\x41", "\\u0041", "\\cA", "\\t\\n\\r", "\\q", "\\A", "\\-" , "\\/"
  ];
  for (const source of supported) {
    assert.doesNotThrow(() => compile(source));
  }
  // Annex B：不构成量词的 `{` 是字面量。
  for (const source of ["a{", "a{2", "a{x", "a{,2}", "a{ 2}"]) {
    assert.doesNotThrow(() => compile(source));
  }
});

test("linear regex rejects unsupported constructs with a readable diagnosis", () => {
  const lookahead = reason("(?=a)");
  assert.match(lookahead, /环视|前瞻|后顾/, "lookaround must be named in the diagnosis");
  const backref = reason("(a)\\1");
  assert.match(backref, /反向引用/, "backreferences must be named in the diagnosis");
  assert.match(reason("(?<!a)"), /环视|前瞻|后顾/);
  assert.match(reason("\\k<n>"), /反向引用/);
  assert.match(reason("(?i)a"), /标志|扩展|分组/);
});

test("linear regex reports syntax errors instead of throwing", () => {
  for (const source of ["(", ")", "[", "a)", "(a", "a**", "*a", "+a", "?a", "{2}", "a{2,1}", "[z-a]", "\\", "a|*"]) {
    assert.doesNotThrow(() => compileLinearRegex(source), `${JSON.stringify(source)} must not throw`);
    const result = compileLinearRegex(source);
    assert.equal(result.ok, false, `${JSON.stringify(source)} must be rejected`);
    if (!result.ok) assert.ok(result.message.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 2. 匹配语义：test 的存在性必须与原生 RegExp 逐例一致
// ---------------------------------------------------------------------------

const DIFFERENTIAL_PATTERNS = [
  "\\d+", "\\d+", "^\\d+", "\\d+$", "^\\d+$", "[a-z]+", "[A-Z]+", "a", "A",
  "abc", "ABC", "a.c", "^.$", "\\w+", "\\w+\\.\\w+", "\\.txt$", "^\\.", "\\.$",
  "\\bfoo\\b", "\\bfoo", "foo\\b", "\\Bfoo", "o\\Bo",
  "a*", "a+", "a?", "a{2}", "a{2,}", "a{2,4}", "a{0,}", "b*",
  "(a|b)", "(ab|cd)", "(a|b)c", "x(y|z)w", "re(port|view)",
  "^\\d{4}-\\d{2}-\\d{2}$", "^v?\\d+(\\.\\d+){1,3}$", "(\\d+\\.){3}\\d+",
  "[^aeiou]+", "[^a-z]", "[]", "[^]", "a\\sb", "\\s", "\\S+",
  "(a+)+", "(a|aa)+", "(.*a){3}", "([a-z]{1,10}){1,10}", "(a{1,20}){1,20}",
  "(a+)(a+)(a+)(a+)(a+)(a+)$", "(\\w|\\w\\w)+$", ".*a.*a.*a.*",
  "\\u0041", "\\x41", "\\cA", "\\t", "a{", "a{2", "\\-", "\\/", "\\q"
];

const DIFFERENTIAL_NAMES = [
  "", "a", "A", "b", "aa", "aaa", "ab", "abab", "abc", "ABC", "a1b2",
  "report-2024.txt", "REPORT-2024.TXT", "project.docx", "IMG_0001.jpg",
  "192.168.0.1", "v1.2.3", "v10.20.30", "2024-06-15", "readme", "README.md",
  "someordinaryfilenamewithoutspaces.txt", "applicationmanifestdocumentation.md",
  "a-b.c d_e", "1_2_3", "foo_bar_baz", "  spaced  ", "tab\there",
  "\u0001control", "\u00e9clair", "\u00c9CLAIR", "caf\u00e9.txt",
  "\u4e2d\u6587\u540d\u79f0.txt", "\ud83d\ude00emoji", "a\ud83d\ude00b",
  "x".repeat(40), "a".repeat(64), "ab".repeat(30)
];

test("test() agrees with the native engine on every supported pattern/name pair", () => {
  let checked = 0;
  const mismatches: string[] = [];
  for (const source of DIFFERENTIAL_PATTERNS) {
    const engine = compile(source);
    const native = new RegExp(source, "gi");
    for (const name of DIFFERENTIAL_NAMES) {
      native.lastIndex = 0;
      const expected = native.test(name);
      const actual = engine.test(name);
      checked += 1;
      if (actual !== expected) mismatches.push(`${JSON.stringify(source)} on ${JSON.stringify(name)}: ${actual} != ${expected}`);
    }
  }
  assert.ok(checked > 2000, `expected a broad corpus, only checked ${checked}`);
  assert.deepEqual(mismatches, [], "existence of a match must match the native engine exactly");
});

test("non-ASCII case folding is reproduced exactly (no `u` flag semantics)", () => {
  // 非 ASCII 一律不做特殊折叠：U+017F/U+212A 在无 u 标志下不等于 s/k（实测）。
  assert.equal(compile("\u017f").test("s"), false);
  assert.equal(compile("\u212a").test("k"), false);
  assert.equal(compile("[a-z]").test("\u017f"), false);
  // 但真正的成对折叠要成立。
  assert.equal(compile("\u00e9").test("\u00c9"), true);
  assert.equal(compile("\u00c9").test("\u00e9"), true);
  assert.equal(compile("[\u00e0-\u00ff]").test("\u00c9"), true);
  assert.equal(compile("[^a-z]").test("\u00c9"), true);
  // 三/四元等价类（U+03A3/U+03C2/U+03C3）必须整体可比。
  assert.equal(compile("\u03c2").test("\u03a3"), true);
  assert.equal(compile("\u03a3").test("\u03c3"), true);
  assert.equal(compile("[\u03c2]").test("\u03a3"), true);
  assert.equal(compile("\u03a3").test("\u03c2"), true);
  // U+0130 / U+00DF 不成对：只与自身相等。
  assert.equal(compile("\u0130").test("i"), false);
  assert.equal(compile("\u0130").test("I"), false);
  assert.equal(compile("\u00df").test("ss"), false);
});

test("`.` excludes exactly LF, CR, LS and PS", () => {
  const dot = compile("^.$");
  assert.equal(dot.test("a"), true);
  assert.equal(dot.test("\n"), false);
  assert.equal(dot.test("\r"), false);
  assert.equal(dot.test("\u2028"), false);
  assert.equal(dot.test("\u2029"), false);
  assert.equal(dot.test("\u000b"), true, "vertical tab is not a line terminator for `.`");
  assert.equal(dot.test("\u000c"), true);
  assert.equal(dot.test("\u0085"), true);
  // 无 u 标志：`.` 只吃一个 code unit。
  assert.equal(dot.test("\ud83d\ude00"), false);
});

test("`^` and `$` are string anchors, never line anchors", () => {
  assert.equal(compile("^b").test("a\nb"), false);
  assert.equal(compile("a$").test("a\nb"), false);
  assert.equal(compile("a$").test("a\n"), false);
  assert.equal(compile("a^b").test("a^b"), false, "a mid-pattern `^` is still an anchor");
  assert.equal(compile("\\ba").test("ab"), true);
  // 两个词字符之间不是边界，因此 `a\b` 在 "ab" 上不匹配，在 "a b" 上匹配。
  assert.equal(compile("a\\b").test("ab"), false);
  assert.equal(compile("a\\b").test("a b"), true);
  assert.equal(compile("\\Ba").test("ab"), false);
  // `\B` 在 "ba" 的 1 号位成立（两侧都是词字符）。
  assert.equal(compile("\\Ba").test("ba"), true);
});

// ---------------------------------------------------------------------------
// 3. ranges：非重叠、从左到右、零长度不产生区间
// ---------------------------------------------------------------------------

test("ranges match the native reference for unambiguous patterns", () => {
  const cases: Array<[string, string]> = [
    ["\\d+", "report-2024.txt"],
    ["a*", "aaa"],
    ["a*", "aabaa"],
    ["a*", "baaab"],
    ["\\w+", "a-b c_d"],
    ["[a-z]+", "ABcdEFgh"],
    ["\\.", "a.b.c"],
    ["\\.\\w+", "a.txtb.md"],
    ["\\d{2}", "1 22 333 4444"],
    ["o", "foo boo"],
    ["^\\w+", "hello world"],
    ["\\w+$", "hello world"],
    ["\\b\\w+", "one two three"],
    ["\\d", "a1b2c3"],
    ["[^a-z]+", "ab12cd34"],
    ["\\s+", "a  b\tc"],
    ["(\\d)", "a1b2"],
    ["A+", "aaAAaa"],
    ["\\.(txt|md)$", "notes.txt"]
  ];
  for (const [source, name] of cases) {
    const actual = pairs(compile(source).matchRanges(name));
    const expected = pairs(referenceRanges(source, name));
    assert.deepEqual(actual, expected, `${JSON.stringify(source)} on ${JSON.stringify(name)}`);
  }
});

test("ranges are non-overlapping, ascending and non-empty", () => {
  const names = ["aabaa", "a1b22c333", "report-2024-06-15.txt", "a".repeat(50)];
  const sources = ["\\d+", "a*", "[a-z]+", "\\w", "a", "\\d", "\\w+"];
  for (const source of sources) {
    const engine = compile(source);
    for (const name of names) {
      const ranges = engine.matchRanges(name);
      let previousEnd = -1;
      for (const range of ranges) {
        assert.ok(range.end > range.start, `${JSON.stringify(source)} on ${JSON.stringify(name)}: empty range`);
        assert.ok(range.start >= previousEnd, `${JSON.stringify(source)} on ${JSON.stringify(name)}: overlap`);
        assert.ok(range.start >= 0 && range.end <= name.length, "range must stay inside the name");
        previousEnd = range.end;
      }
    }
  }
});

test("zero-length-capable patterns terminate and produce no range", () => {
  for (const source of ["^", "$", "a*", "a?", "\\b", "\\B", "b*"]) {
    const engine = compile(source);
    assert.doesNotThrow(() => engine.matchRanges("aaa"));
    for (const range of engine.matchRanges("aaa")) {
      assert.ok(range.end > range.start, `${JSON.stringify(source)} must not emit an empty range`);
    }
  }
  assert.deepEqual(pairs(compile("^").matchRanges("aaa")), []);
  assert.deepEqual(pairs(compile("\\b").matchRanges("abc")), []);
});

test("repeated calls are stable and independent (no shared mutable state)", () => {
  const engine = compile("\\d+");
  const first = pairs(engine.matchRanges("a1b2c3"));
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(pairs(engine.matchRanges("a1b2c3")), first);
    assert.equal(engine.test("a1b2c3"), true);
  }
  // 交错调用两个不同名称不得互相污染。
  assert.deepEqual(pairs(engine.matchRanges("x9")), [[1, 2]]);
  assert.deepEqual(pairs(engine.matchRanges("a1b2c3")), first);
});

// ---------------------------------------------------------------------------
// 4. 对抗性：不得病态回溯（原实现在 255 字符名称上冻结 >12s）
// ---------------------------------------------------------------------------

const ADVERSARIAL_PATTERNS = [
  "(a+)+$",
  "((a+))*$",
  "(a|aa)+$",
  "(a|a?)+$",
  "(.*a){3}$",
  "(.*a){7,6,5,4}$",
  ".*a.*a.*a.*a.*a.*a.*a.*a.*a.*a.*",
  "([a-z]{1,10}){1,10}$",
  "(a{1,20}){1,20}$",
  "(a+)(a+)(a+)(a+)(a+)(a+)$",
  "(\\w|\\w\\w)+$",
  "(\\d+)+$",
  "^(([a-z])+.)+[A-Z]([a-z])+$",
  "(x+x+)+y",
  "(a*)*b",
  "(.*)*$"
];

const ADVERSARIAL_NAMES = [
  "a".repeat(255),
  "x".repeat(255),
  "someordinaryfilenamewithoutspaces.txt",
  "applicationmanifestdocumentation.md",
  "a".repeat(127) + "b",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
];

test("adversarial patterns stay fast on long names (no catastrophic backtracking)", () => {
  // IR1：`test` 与 `matchRanges` 的代价相差**两个数量级**（实测同一模式同一名称上
  // `test` 0.74ms / `matchRanges` 30.4ms，因为后者要为每个起点求最长匹配端点）。
  // 若把两者放进同一个 50ms 预算，实际被测的是 `matchRanges`，`test` 只剩约 67× 余量
  // 被浪费，而整块的余量只有 1.57× —— 全量并行跑时容易抖动误报（曾观测到 1.3×）。
  // 因此**分开计时**：各自用同一预算，任一超限都能独立定位到具体操作。
  for (const source of ADVERSARIAL_PATTERNS) {
    const engine = compile(source);
    for (const name of ADVERSARIAL_NAMES) {
      // 预热 + 中位数：全量 `npm test` 并行跑时单次采样会被调度抖动污染（见 timingTestSupport）。
      assertMedianDurationWithin(() => { engine.test(name); }, 50,
        `test: ${JSON.stringify(source)} on a ${name.length}-char name`);
      assertMedianDurationWithin(() => { engine.test(`${name}!`); }, 50,
        `test(negated): ${JSON.stringify(source)} on a ${name.length}-char name`);
      assertMedianDurationWithin(() => { engine.matchRanges(name); }, 50,
        `matchRanges: ${JSON.stringify(source)} on a ${name.length}-char name`);
    }
  }
});

test("ordinary long names with adversarial patterns stay fast", () => {
  // 评审实测：原实现在这 4 个普通名称上冻结 >12s，而它们完全合法且常见。
  const names = [
    "applicationmanifestdocumentation.md",
    "someordinaryfilenamewithoutspaces.txt",
    "a".repeat(40),
    "a".repeat(42)
  ];
  const sources = ["([a-z]{1,10}){1,10}$", "(a+)(a+)(a+)(a+)(a+)(a+)$", "(.*a){3}$", "(\\w|\\w\\w)+$"];
  for (const source of sources) {
    const engine = compile(source);
    for (const name of names) {
      assertMedianDurationWithin(() => {
        engine.test(name);
        engine.matchRanges(name);
      }, 50, `${JSON.stringify(source)} on ${JSON.stringify(name.slice(0, 24))}…`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. 文档化的语义偏离（不得被误认为与原生引擎完全一致）
// ---------------------------------------------------------------------------

test("documented divergence: lazy quantifiers are treated as greedy", () => {
  // 原生 `/a*?/` 优先匹配空串；本引擎不实现惰性语义，按贪婪处理。
  // 这只影响 highlight 区间（test 的存在性不受影响），且已在 spec §3.2 记录。
  assert.deepEqual(pairs(compile("a*?").matchRanges("aaa")), [[0, 3]]);
  assert.equal(compile("a*?").test("aaa"), new RegExp("a*?", "gi").test("aaa"));
});

test("documented divergence: alternation picks the longest branch, not the first", () => {
  // 原生 `/a|ab/` 在 "ab" 上回传 "a"；本引擎是 NFA 状态集合模拟，取最长 "ab"。
  // 存在性判定仍与原生一致，因此过滤结果不受影响。
  assert.equal(compile("a|ab").test("ab"), true);
  assert.equal(new RegExp("a|ab", "gi").test("ab"), true);
  assert.deepEqual(pairs(compile("a|ab").matchRanges("ab")), [[0, 2]]);
});

// ---------------------------------------------------------------------------
// 6. 输入规模守卫（确定性拒绝，不是回溯风险启发式）
// ---------------------------------------------------------------------------

test("absurdly long patterns and quantifier bounds are rejected deterministically", () => {
  const tooLong = compileLinearRegex("a".repeat(5000));
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.ok(tooLong.message.length > 0);

  const hugeBound = compileLinearRegex("a{100000}");
  assert.equal(hugeBound.ok, false);
  if (!hugeBound.ok) assert.ok(hugeBound.message.length > 0);

  // 合理规模必须继续接受。
  assert.equal(compileLinearRegex("a{500}").ok, true);
  assert.equal(compileLinearRegex("\\w+".repeat(50)).ok, true);
});

test("source is preserved for diagnostics", () => {
  assert.equal(compile("^\\d+$").source, "^\\d+$");
});
