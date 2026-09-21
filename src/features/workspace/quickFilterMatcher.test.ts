import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuickFilter } from "./quickFilterMatcher";
import type { QuickFilterMode, QuickFilterRange, QuickFilterSyntax } from "./quickFilterTypes";

/** 编译并断言成功，返回程序。 */
function program(text: string, syntax: QuickFilterSyntax = "substring", mode: QuickFilterMode = "highlight") {
  const result = compileQuickFilter(text, syntax, mode);
  assert.equal(result.ok, true, `expected ${syntax}:${JSON.stringify(text)} to compile`);
  if (!result.ok) throw new Error("unreachable");
  return result.program;
}

function rangesOf(name: string, text: string, syntax: QuickFilterSyntax = "substring") {
  return program(text, syntax).ranges(name).map((range) => [range.start, range.end] as const);
}

function matches(name: string, text: string, syntax: QuickFilterSyntax = "substring") {
  return program(text, syntax).test(name);
}

/**
 * 用 code unit 把区间切出来，直接验证"半个代理对"一类问题：
 * 若实现按 code point 计算偏移却直接用于切片，这里会切出孤立代理项。
 */
function slices(name: string, text: string, syntax: QuickFilterSyntax = "substring") {
  return program(text, syntax).ranges(name).map((range) => name.slice(range.start, range.end));
}

function hasLoneSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// B1：匹配源只有 entry.name（本任务修复的 BUG 锚点）
// ---------------------------------------------------------------------------

test("B1: the match source is the entry name only, in all three syntaxes", () => {
  // 名称是 123456.txt，但完整路径是 E:\测试文件夹\A\A-TEST\123456.txt。
  // 名称本身不含 TEST / A-TEST / 测试文件夹，三种语法都必须不命中。
  for (const syntax of ["substring", "wildcard", "regex"] as const) {
    assert.equal(matches("123456.txt", "TEST", syntax), false, `${syntax} must not match TEST`);
    assert.equal(matches("123456.txt", "A-TEST", syntax), false, `${syntax} must not match A-TEST`);
    assert.equal(matches("123456.txt", "测试文件夹", syntax), false, `${syntax} must not match 测试文件夹`);
  }
  // 名称自身的匹配仍然成立（通配符按整名匹配，因此需要显式星号）。
  assert.equal(matches("123456.txt", "123456"), true);
  assert.equal(matches("123456.txt", "123456", "regex"), true);
  assert.equal(matches("123456.txt", "123456*", "wildcard"), true);
});

test("B1: a name containing the query still matches", () => {
  assert.equal(matches("my_project", "project"), true);
  assert.equal(matches("my_project", "PROJECT"), true, "matching is case-insensitive (D14)");
  assert.deepEqual(rangesOf("my_project", "project"), [[3, 10]]);
});

test("B1: path-like strings are only matched when they are the name", () => {
  // 名称里真的含 A-TEST 时必须命中——契约是"只看名称"，不是"屏蔽某些字串"。
  assert.equal(matches("A-TEST.txt", "A-TEST"), true);
});

// ---------------------------------------------------------------------------
// B2：三种语法
// ---------------------------------------------------------------------------

test("B2 substring: literal, case-insensitive, space is an ordinary character", () => {
  assert.equal(matches("Report Final.docx", "report"), true);
  assert.equal(matches("Report Final.docx", "final"), true);
  assert.deepEqual(rangesOf("Report Final.docx", " "), [[6, 7]]);
  assert.equal(matches("Report Final.docx", "report final"), true);
  assert.equal(matches("reportfinal", "report final"), false, "spaces are literal, not separators");
  assert.equal(matches("a*b", "*"), true, "* is a literal character in substring syntax");
  assert.deepEqual(rangesOf("a*b", "*"), [[1, 2]]);
});

test("B2 wildcard: * and ? with literal escaping, anchored to the whole name, case-insensitive", () => {
  assert.equal(matches("report.txt", "*.txt", "wildcard"), true);
  assert.equal(matches("report.txt", "rep?rt*", "wildcard"), true);
  assert.equal(matches("my_project", "*project*", "wildcard"), true);
  assert.equal(matches("my_project", "project*", "wildcard"), false, "anchored: the whole name must match");
  assert.equal(matches("my_project", "*project", "wildcard"), true);
  // 锚定的实际意义：不会误收更长后缀。
  assert.equal(matches("notes.txt.bak", "*.txt", "wildcard"), false);
  assert.equal(matches("report.txt", "*.TXT", "wildcard"), true);
  assert.equal(matches("a.b", "a.b", "wildcard"), true, "a literal dot must not act as a regex wildcard");
  assert.equal(matches("axb", "a.b", "wildcard"), false, "a literal dot must not match any character");
  assert.equal(matches("a+b", "a+b", "wildcard"), true, "regex metacharacters are escaped");
  assert.equal(matches("aab", "a+b", "wildcard"), false);
  assert.equal(matches("report.txt", "*", "wildcard"), true);
  assert.deepEqual(rangesOf("report.txt", "*.txt", "wildcard"), [[0, 10]]);
  assert.deepEqual(rangesOf("report.txt", "rep?rt*", "wildcard"), [[0, 10]]);
  assert.deepEqual(rangesOf("notes.txt.bak", "*.txt", "wildcard"), []);
});

test("B2 wildcard is linear and cannot hang on adversarial star runs", () => {
  // 经典灾难性回溯用例：若用 RegExp(".*a.*a..." ) 实现，这里会指数级卡死。
  const name = "a".repeat(64);
  const pattern = `${"*a".repeat(12)}*`;
  const started = Date.now();
  assert.equal(matches(name, pattern, "wildcard"), true);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `wildcard matching must stay fast, took ${elapsed}ms`);
});

test("B2 regex: gi flags, non-anchored, zero-length safe", () => {
  assert.equal(matches("report-2024.txt", "^\\d+", "regex"), false, "not anchored at the start of the name");
  assert.equal(matches("report-2024.txt", "\\d+", "regex"), true);
  assert.equal(matches("report-2024.txt", "REPORT", "regex"), true, "i flag is implied");
  assert.equal(matches("project.docx", "(pro|doc)x?", "regex"), true);
  assert.deepEqual(rangesOf("report-2024.txt", "\\d+", "regex"), [[7, 11]]);
  // 零长度模式必须终止，并且不产生区间。
  const zeroLength = program("(?=a)", "regex");
  assert.doesNotThrow(() => zeroLength.ranges("aaa"));
  assert.deepEqual(zeroLength.ranges("aaa"), []);
  const anchored = program("^", "regex");
  assert.doesNotThrow(() => anchored.ranges("aaa"));
  assert.deepEqual(anchored.ranges("aaa"), []);
});

test("B2 regex: patterns that match both non-empty and empty stays non-overlapping", () => {
  // `a*` 是贪婪的，因此整段 "aaa" 一次吃掉；末尾的空匹配不产生区间。
  assert.deepEqual(rangesOf("aaa", "a*", "regex"), [[0, 3]]);
  assert.deepEqual(rangesOf("aabaa", "a*", "regex"), [[0, 2], [3, 5]]);
});

test("B2 regex: invalid patterns report an error instead of throwing", () => {
  const result = compileQuickFilter("a(1", "regex", "highlight");
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.message.length > 0);
  const bad = compileQuickFilter("[z-a]", "regex", "highlight");
  assert.equal(bad.ok, false);
});

test("substring and wildcard syntaxes never fail to compile", () => {
  for (const value of ["", "(", "[", "\\", "*", "?", "a.b+", "((("]) {
    assert.equal(compileQuickFilter(value, "substring", "highlight").ok, true, `substring ${JSON.stringify(value)}`);
    assert.equal(compileQuickFilter(value, "wildcard", "highlight").ok, true, `wildcard ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// B3：拼音（仅在 substring 语法下叠加）
// ---------------------------------------------------------------------------

test("B3 substring adds pinyin: initials, full pinyin and literal CJK", () => {
  assert.equal(matches("时间", "sj"), true);
  assert.equal(matches("世界地图", "sj"), true);
  assert.equal(matches("时间", "shijian"), true);
  assert.equal(matches("时间", "时间"), true);
  assert.equal(matches("中文拼音", "zwp"), true);
  assert.equal(matches("中文拼音", "zhongwen"), true);
  assert.equal(matches("项目A计划", "xm"), true, "initials work across a mixed ASCII name");
});

test("B3 pinyin does not create false positives", () => {
  assert.equal(matches("readme", "sj"), false);
  assert.equal(matches("123456.txt", "sj"), false);
  assert.equal(matches("世界地图", "sjtu"), false);
});

test("B3 pinyin is only layered onto substring syntax (D3)", () => {
  assert.equal(matches("时间", "sj", "wildcard"), false);
  assert.equal(matches("时间", "sj", "regex"), false);
  // 字面写法在三种语法下都仍然有效。
  assert.equal(matches("时间", "时间", "wildcard"), true);
  assert.equal(matches("时间", "时间", "regex"), true);
});

test("B3 pinyin highlighting covers the matched CJK run, not the whole name", () => {
  assert.deepEqual(slices("世界地图", "sj"), ["世界"]);
  assert.deepEqual(slices("时间", "sj"), ["时间"]);
  assert.deepEqual(slices("时间时间", "sj"), ["时间", "时间"]);
  assert.deepEqual(slices("中文拼音", "zwp"), ["中文拼"]);
});

test("B3 mixed ASCII and CJK names produce exact, non-overlapping ranges (spec §8 分片1)", () => {
  assert.deepEqual(rangesOf("时间project", "sj"), [[0, 2]]);
  assert.deepEqual(rangesOf("时间project", "project"), [[2, 9]]);
  assert.deepEqual(rangesOf("时间project", "sjproject"), [[0, 9]]);
  assert.deepEqual(slices("时间project", "sjproject"), ["时间project"]);
});

test("B4 ranges are ascending, non-overlapping and cover repeated hits", () => {
  assert.deepEqual(rangesOf("aaa", "a"), [[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual(rangesOf("aaaa", "aa"), [[0, 2], [2, 4]]);
  assert.deepEqual(rangesOf("my_project/my_project", "project"), [[3, 10], [14, 21]]);
  const ranges: QuickFilterRange[] = program("sj").ranges("时间时间时间");
  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index].start >= ranges[index - 1].end, "ranges must not overlap");
  }
});

test("B4 a name without matches yields no ranges", () => {
  assert.deepEqual(rangesOf("readme", "project"), []);
  assert.deepEqual(rangesOf("世界地图", "sjtu"), []);
});

test("B4 non-BMP names never produce a lone surrogate in a range", () => {
  const name = "𠀀𠀀时间";
  assert.deepEqual(rangesOf(name, "sj"), [[4, 6]]);
  assert.deepEqual(slices(name, "sj"), ["时间"]);
  for (const slice of slices(name, "sj")) assert.equal(hasLoneSurrogate(slice), false);
  // 字面匹配 astral 字符本身也要整对返回。
  assert.deepEqual(slices(name, "𠀀"), ["𠀀", "𠀀"]);
  for (const slice of slices(name, "𠀀")) assert.equal(hasLoneSurrogate(slice), false);
});

// ---------------------------------------------------------------------------
// B5 / B7：错误与空文本
// ---------------------------------------------------------------------------

test("B5 nested unbounded quantifiers are rejected deterministically", () => {
  // 结构性检测：判定只依赖模式文本，不依赖机器负载，也绝不会因为"探测本身"而挂起。
  for (const pattern of ["(a+)+$", "(a*)*", "(\\d+)+b", "(?:\\w+)+", "(ab+)+", "(a{2,})+", "((a+))*"]) {
    const result = compileQuickFilter(pattern, "regex", "highlight");
    assert.equal(result.ok, false, `${pattern} must be rejected`);
    if (!result.ok) assert.match(result.message, /复杂/);
  }
});

test("B5 the structural check does not reject ordinary regexes", () => {
  for (const pattern of ["(ab)+", "(a|b)+", "a+b", "a{2,4}", "a{2}", "[+]+", "\\++", "(?:ab)+c", "^\\d+$", "(a)(b)"]) {
    assert.equal(compileQuickFilter(pattern, "regex", "highlight").ok, true, `${pattern} must be accepted`);
  }
});

test("IRA-01 sequential unbounded quantifiers are rejected before reaching native RegExp", () => {
  // §6.2:498 点名的灾难性形态：同一层多个可匹配同一段文本的无界量词。
  // 实测修复前 `(.*a){7}$` 对 41 字符名称单次 ranges() 耗时 5726ms（逐行调用即假死）。
  // 阈值 UNSAFE_QUANTIFIER_WEIGHT = 3：权重 >3 判危，因此 {4} 及以上、以及 4 个以上
  // 同层无界量词都被拒绝。
  for (const pattern of [
    "(.*a){7}$", "(.*a){6}$", "(.*a){5}$", "(.*a){4}$",
    ".*a.*a.*a.*a.*a.*a.*a.*a.*a.*a.*",
    ".*a.*a.*a.*a.*",
    "(.*){4}$"
  ]) {
    const result = compileQuickFilter(pattern, "regex", "highlight");
    assert.equal(result.ok, false, `${pattern} must be rejected as too complex`);
    if (!result.ok) assert.match(result.message, /复杂/);
  }
});

test("IRA-01 the guard's boundary is the documented weight limit of 3", () => {
  // 权重恰好为 3 的形态仍在可控范围（255 字符名称下约 255^3 ≈ 1.7×10⁷ 步），
  // 因此放行；这条断言把边界钉住，避免将来无意放宽/收紧而无人察觉。
  for (const pattern of ["(.*a){3}$", "(a*){3}b", ".*a.*a.*"]) {
    assert.equal(compileQuickFilter(pattern, "regex", "highlight").ok, true,
      `${pattern} sits exactly at the safe weight and must be accepted`);
  }
});

test("IRA-01 the guard stays fast and never rejects bounded or literal patterns", () => {
  // 判定必须只依赖模式文本，且不得误伤正常写法。
  for (const pattern of [
    "a{2,4}", "a{2}", "(ab){3}", "^\\d{4}$", "\\*\\*\\*", "[*]{3}", "a?b?c?",
    "(a|b){2}", ".*\\.txt$", "^notes", "report.*"
  ]) {
    assert.equal(compileQuickFilter(pattern, "regex", "highlight").ok, true, `${pattern} must be accepted`);
  }
});

test("IRA-02 regex ranges never split a surrogate pair", () => {
  // 正则带 gi 不带 u（§6.3），匹配可能停在代理对中间；区间必须对齐到 code point 边界。
  const emoji = "😀x";
  const dot = program(".", "regex");
  const ranges = dot.ranges(emoji);
  for (const range of ranges) {
    assert.equal(hasLoneSurrogate(emoji.slice(range.start, range.end)), false,
      `range ${range.start}-${range.end} must not slice a surrogate pair`);
  }
  assert.deepEqual(ranges, [{ start: 0, end: 2 }, { start: 2, end: 3 }],
    "the astral char must be one range, not two halves");
});

test("IRA-02 astral characters are highlighted whole in regex mode", () => {
  const name = "a😀b";
  const ranges = program(".", "regex").ranges(name);
  for (const range of ranges) {
    assert.equal(hasLoneSurrogate(name.slice(range.start, range.end)), false);
  }
  // 区间仍保持升序且不重叠。
  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index].start >= ranges[index - 1].end, "ranges must not overlap");
  }
  assert.deepEqual(ranges, [{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }]);
});

test("B7 empty text means no filtering and no error in all three syntaxes", () => {
  for (const syntax of ["substring", "wildcard", "regex"] as const) {
    const empty = program("", syntax);
    assert.equal(empty.test("anything"), true, `${syntax} empty text matches everything`);
    assert.equal(empty.test(""), true);
    assert.deepEqual(empty.ranges("anything"), [], `${syntax} empty text yields no ranges`);
  }
});

test("B7 an empty pattern is not an invalid regex", () => {
  const result = compileQuickFilter("", "regex", "highlight");
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// 编译缓存与调用契约
// ---------------------------------------------------------------------------

test("compile results are cached per (text, syntax, mode) and stay equivalent", () => {
  const first = program("project", "substring");
  const second = program("project", "substring");
  assert.equal(first, second, "an identical compile request returns the cached program");
  assert.equal(first.mode, "highlight");
  const include = program("project", "substring", "include");
  assert.equal(include.mode, "include");
  assert.notEqual(include, first, "mode is part of the program");
});

test("program.text preserves the original text and mode is carried through", () => {
  const value = program("Project", "substring", "exclude");
  assert.equal(value.text, "Project");
  assert.equal(value.mode, "exclude");
  assert.equal(value.test("my_project"), true);
});

// ---------------------------------------------------------------------------
// 用户报告的 BUG 回归：匹配源必须是名称，而不是完整路径
// ---------------------------------------------------------------------------

test("BUG: the match source is the entry name, never the full path", () => {
  // 用户复现：`E:\测试文件夹\A\A-TEST\123456.txt` 以完整路径为匹配源时，
  // 输入 `TEST` 会命中路径中的 `A-TEST` 段；以名称为匹配源时必须**不**命中。
  const name = "123456.txt";
  const fullPath = "E:\\测试文件夹\\A\\A-TEST\\123456.txt";

  assert.equal(program("TEST").test(name), false,
    "输入 TEST 不应命中名称 123456.txt");
  assert.deepEqual(program("TEST").ranges(name), [],
    "不命中时不得产生任何高亮区间");

  // 反证：若匹配源被误换成完整路径，同一输入会命中 —— 用名称的父目录名验证该差异确实存在。
  assert.equal(program("TEST").test("A-TEST"), true,
    "TEST 应当命中名称 A-TEST，说明断言本身有鉴别力");
  assert.notEqual(program("TEST").test(name), program("TEST").test(fullPath),
    "名称与完整路径对同一输入必须给出不同结果，证明匹配源是名称");

  // 中文父目录名同样不得让英文过滤词命中。
  assert.equal(program("test").test("测试文件夹"), false);
  assert.equal(program("A").test(name), false, "名称中不含 A");
});
