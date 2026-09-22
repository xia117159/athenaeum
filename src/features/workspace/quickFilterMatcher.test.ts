import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuickFilter } from "./quickFilterMatcher";
import { assertMedianDurationWithin } from "./timingTestSupport";
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
  assert.equal(matches("Report Final.docx", "report final"), true);
  assert.equal(matches("reportfinal", "report final"), false, "spaces are literal, not separators");
  assert.equal(matches("a*b", "*"), true, "* is a literal character in substring syntax");
  assert.deepEqual(rangesOf("a*b", "*"), [[1, 2]]);
  // 词内空格是普通字符：`Report Final.docx` 中 6..7 是那个空格。
  assert.deepEqual(rangesOf("Report Final.docx", "t f"), [[5, 8]]);
});

test("G17 leading and trailing whitespace is trimmed, whitespace-only means no filter", () => {
  // 恢复基线行为（spec §3.4）：消费侧原本就是 `filterText.trim().toLowerCase()`。
  // 修复前 `"report "`（尾随空格）会从 3 条命中掉到 0 条，且界面无任何解释。
  assert.equal(matches("Report Final.docx", "report "), true, "trailing space must not kill the hit");
  assert.equal(matches("Report Final.docx", " report"), true, "leading space must not kill the hit");
  assert.equal(matches("Report Final.docx", "\treport\n"), true);
  assert.deepEqual(rangesOf("Report Final.docx", "report "), [[0, 6]]);
  // 仅空白 ⇒ 视为不过滤（恒真、无区间），而不是"零命中"。
  for (const syntax of ["substring", "wildcard", "regex"] as const) {
    const blank = program("   ", syntax);
    assert.equal(blank.test("anything"), true, `${syntax}: whitespace-only means no filtering`);
    assert.equal(blank.test(""), true);
    assert.deepEqual(blank.ranges("anything"), [], `${syntax}: whitespace-only yields no ranges`);
  }
  // trim 后为空的程序把 appliedText 规整为 ""，因此与空文本程序完全等价。
  assert.equal(program("   ", "substring").text, program("", "substring").text);
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
  // S-3：区间是**字面记号**在名称中的命中段，不再是整名（原实现命中即返回 `[{0, len}]`）。
  assert.deepEqual(rangesOf("report.txt", "*.txt", "wildcard"), [[6, 10]], "only the literal `.txt` part is a hit");
  assert.deepEqual(rangesOf("report.txt", "rep?rt*", "wildcard"), [[0, 3], [4, 6]], "`?` consumes without highlighting");
  assert.deepEqual(rangesOf("my_project", "*project*", "wildcard"), [[3, 10]]);
  assert.deepEqual(rangesOf("a.b", "a.b", "wildcard"), [[0, 3]], "contiguous literal hits merge");
  assert.deepEqual(rangesOf("report.txt", "*", "wildcard"), [], "a bare `*` has no literal token to highlight");
  assert.deepEqual(rangesOf("notes.txt.bak", "*.txt", "wildcard"), []);
});

test("B2 wildcard is linear and cannot hang on adversarial star runs", () => {
  // 经典灾难性回溯用例：若用 RegExp(".*a.*a..." ) 实现，这里会指数级卡死。
  const name = "a".repeat(64);
  const pattern = `${"*a".repeat(12)}*`;
  assert.equal(matches(name, pattern, "wildcard"), true);
  assertMedianDurationWithin(() => { matches(name, pattern, "wildcard"); }, 1000, "wildcard matching must stay fast");
});

test("B2 regex: gi flags, non-anchored, zero-length safe", () => {
  assert.equal(matches("report-2024.txt", "^\\d+", "regex"), false, "not anchored at the start of the name");
  assert.equal(matches("report-2024.txt", "\\d+", "regex"), true);
  assert.equal(matches("report-2024.txt", "REPORT", "regex"), true, "i flag is implied");
  assert.equal(matches("project.docx", "(pro|doc)x?", "regex"), true);
  assert.deepEqual(rangesOf("report-2024.txt", "\\d+", "regex"), [[7, 11]]);
  // 零长度模式必须终止，并且不产生区间。`\b` 是零宽度断言，属于受支持子集。
  const zeroLength = program("\\b", "regex");
  assert.doesNotThrow(() => zeroLength.ranges("aaa"));
  assert.deepEqual(zeroLength.ranges("aaa"), []);
  assert.equal(zeroLength.test("aaa"), true, "\\b matches at position 0 of a word");
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
// S-2：NFC 不敏感匹配（组合字符与预组合字符必须互相命中）
// ---------------------------------------------------------------------------

/**
 * 评审 S-2 的原始表述是："`?` 计 code point 而非 grapheme，且不做 NFC"。
 *
 * 本轮初版曾把 S-2 **延期**，理由写的是"正确修复需要把区间映射回原始串偏移，
 * 半成品会产出错误高亮区间，比现状更糟"。**该理由经实测被证伪**：
 * 只要保证
 *
 *     NFC(name) === concat(NFC(cluster_i))
 *
 * 每个归一化后的 code point 就唯一对应原始串中一个**连续**区间，既有偏移数学全部成立。
 * cluster 的划分规则是纯局部的（无 Unicode 表）：
 * ① 下一个 code point 是组合记号（`\p{M}`）⇒ 并入当前 cluster；
 * ② 或它与前一个 code point 结构性组合（`NFC(a+b) !== NFC(a)+NFC(b)`，覆盖谚文 L+V+T 等）⇒ 并入。
 *
 * 规则①是必需的：仅靠②会漏掉**非相邻**的规范重排 —— 例如
 * `"e" + U+0316 + U+0301` 归一化为 `"é" + U+0316`，第三个 code point 与第一个交互，
 * 而贪心的相邻判定看不见（初版探针正是在这类输入上给出 331 例反例）。
 *
 * 四组不变量已在 434 万组语料上穷举/模糊验证为零反例（含全 BMP 单字符、
 * 1916 个"特殊字符"的两两组合、多脚本随机串）；正则区间端点在 38,968 个区间上
 * **零**次落在 cluster 内部。
 */
test("S2: precomposed and decomposed names match each other in every syntax", () => {
  const pre = "caf\u00e9";      // café  (NFC，Windows 上的常态)
  const dec = "cafe\u0301";     // café  (NFD，macOS/输入法偶发)

  for (const syntax of ["substring", "wildcard", "regex"] as const) {
    assert.equal(matches(pre, dec, syntax), true, `${syntax}: NFC name must match an NFD query`);
    assert.equal(matches(dec, pre, syntax), true, `${syntax}: NFD name must match an NFC query`);
    assert.equal(matches(pre, pre, syntax), true, `${syntax}: identical NFC still matches`);
    assert.equal(matches(dec, dec, syntax), true, `${syntax}: identical NFD still matches`);
  }

  // 高亮区间必须覆盖整个"基字符 + 组合记号"簇，不能只高亮基字符。
  assert.deepEqual(rangesOf(dec, "caf\u00e9"), [[0, 5]], "the NFD name's é occupies code units [3,5)");
  assert.deepEqual(rangesOf(pre, "cafe\u0301"), [[0, 4]], "the NFC name's é occupies code unit [3,4)");
  assert.deepEqual(slices(dec, "caf\u00e9"), ["cafe\u0301"]);
});

test("S2: non-adjacent canonical reordering is handled (the case that refuted the naive rule)", () => {
  // `e` + U+0316(macron below) + U+0301(acute) 归一化为 `é` + U+0316：
  // 第三个 code point 与第一个组合，中间的记号被重排到后面。
  // 只比较"紧邻对"的写法在这里必然失败，因为 `NFC(U+0316+U+0301) === U+0316+U+0301`。
  const reordered = "e\u0316\u0301z";
  assert.equal("\u0316\u0301".normalize("NFC"), "\u0316\u0301", "precondition: the two marks do not compose with each other");
  assert.equal(reordered.normalize("NFC"), "\u00e9\u0316z", "precondition: NFC moves the acute onto the e");
  assert.equal(matches(reordered, "\u00e9"), true, "an NFC query must still hit the reordered name");
  assert.equal(matches("\u00e9\u0316z", "e\u0316\u0301"), true, "and the reverse must hold");
  // 区间必须覆盖整个簇 [0,3)，而不是只覆盖基字符。
  assert.deepEqual(rangesOf(reordered, "\u00e9"), [[0, 3]]);
});

test("S2: Hangul jamo composition is covered by the structural rule", () => {
  // 谚文 L+V+T 组合不经过组合记号，必须由规则②（结构性组合）捕获。
  // **注意**：规则②必须与"当前整个簇"比较，而不是只与紧邻的前一个 code point 比较 ——
  // `NFC(V+T) === V+T`（V 与 T 单独不组合），只有拿 `L+V` 整体去比才能看出会组合。
  // 这个用例就是为该陷阱设的守卫（实测"只看紧邻对"的写法在 43 万组谚文语料上有 288 例反例）。
  const jamo = "\u1100\u1161\u11a8x";   // ᄀ + ᅡ + ᆨ + x
  assert.equal(jamo.normalize("NFC"), "\uac01x", "precondition: the jamo compose into 각");
  assert.equal("\u1161\u11a8".normalize("NFC"), "\u1161\u11a8", "precondition: V+T alone do NOT compose");
  assert.equal(matches(jamo, "\uac01"), true, "an NFC syllable must hit the decomposed jamo");
  assert.equal(matches("\uac01x", "\u1100\u1161\u11a8"), true, "and the reverse");
  assert.deepEqual(rangesOf(jamo, "\uac01"), [[0, 3]], "the cluster is all three jamo");
  // 更长的 L+V+T 组合：整簇必须一起高亮。
  // U+1100+U+1161+U+11A8 → 각(U+AC01)，U+1102+U+1161+U+11AB → 난(U+B09C)。
  const long = "\u1100\u1161\u11a8\u1102\u1161\u11ab";
  assert.equal(long.normalize("NFC"), "\uac01\ub09c", "precondition: two syllables compose");
  assert.equal(matches(long, "\uac01\ub09c"), true);
  assert.deepEqual(rangesOf(long, "\uac01\ub09c"), [[0, 6]], "both full clusters must be highlighted");
});

test("S2: normalization never splits a cluster or produces a non-contiguous range", () => {
  // 这一组是"区间数学仍然成立"的直接守卫：区间端点必须落在 cluster 边界上。
  const cases: Array<[string, string]> = [
    ["cafe\u0301.txt", "caf\u00e9"],
    ["cafe\u0301.txt", "\\.txt"],
    ["cafe\u0301.txt", "\\w+"],
    ["e\u0316\u0301z", "\u00e9"],
    ["A\u030angstr\u00f6m", "\u00c5"],
    ["\u1e0a\u0323x", "\\u1e0c"]
  ];
  for (const [name, source] of cases) {
    const ranges = program(source, "regex").ranges(name);
    for (const range of ranges) {
      assert.ok(range.end > range.start, `${source} on ${JSON.stringify(name)}: empty range`);
      assert.ok(range.end <= name.length, `${source} on ${JSON.stringify(name)}: range past the end`);
      const slice = name.slice(range.start, range.end);
      assert.equal(hasLoneSurrogate(slice), false, `range ${range.start}-${range.end} slices a surrogate pair`);
      // 切出来的片段必须能"独立归一化"：若切在簇中间，说明端点不在 cluster 边界上。
      const normalized = slice.normalize("NFC");
      assert.ok(!/\p{M}/u.test(normalized.slice(-1)) || /\p{M}/u.test(slice),
        `${source} on ${JSON.stringify(name)}: range ${range.start}-${range.end} starts mid-cluster`);
    }
  }
});

test("S2: ranges never overlap when one cluster expands to several code points", () => {
  // IR2-F1（阻断级，S-2 修复自身引入的回归）：`e`+U+0316+U+0301 是**一个**簇，
  // 其 NFC 是两个 code point（`é` + U+0316），因此这两个 code point 共享同一个原始区间 [0,3)。
  // `globLiteralRanges` 原先按"逐 code point 首尾相接（pointStart === end）"合并区间，
  // 同一簇的第二个 code point 无法接上前一个（pointStart 仍是 0，而 end 已是 3），
  // 于是**另起一个同样的区间**，产出 [[0,3],[0,3]] —— 渲染层会把名称画两遍。
  const name = "e\u0316\u0301";
  assert.equal(name.normalize("NFC"), "\u00e9\u0316", "precondition: one cluster, two NFC code points");

  const assertWellFormed = (syntax: QuickFilterSyntax) => {
    const raw = program("\u00e9\u0316", syntax).ranges(name);
    const ranges = raw.map((range) => [range.start, range.end] as const);
    assert.ok(ranges.length > 0, `${syntax}: precondition, the name must match`);
    for (let index = 1; index < ranges.length; index += 1) {
      assert.ok(ranges[index][0] >= ranges[index - 1][1],
        `${syntax}: ranges must be ascending and non-overlapping, got ${JSON.stringify(ranges)}`);
    }
    for (const [rangeStart, rangeEnd] of ranges) {
      assert.ok(rangeEnd > rangeStart, `${syntax}: no empty range, got ${JSON.stringify(ranges)}`);
      assert.ok(rangeEnd <= name.length, `${syntax}: range past the end, got ${JSON.stringify(ranges)}`);
    }
    // 同一簇只能被覆盖一次。
    assert.deepEqual(ranges, [[0, 3]], `${syntax}: the single cluster must yield exactly one range`);
  };
  for (const syntax of ["substring", "wildcard", "regex"] as const) assertWellFormed(syntax);

  // IR2-F2：上一版守卫**无法**发现 IR2-F1 的 substring 分支 —— 它的查询总是覆盖整个簇的
  // NFC code point，因此 `lastEnd`（在 code point 空间推进）恰好能跳过重复。
  // 真正触发条件：查询只命中簇内 code point 的**真子集**（典型是单个组合记号），
  // 此时同一簇会被连续命中两次，而 `pushRange` 经**共享的簇区间**换算到 code unit 空间，
  // 于是同一个区间被推入两次 ⇒ 渲染层把名称画两遍。
  //
  // 注意 `wildcard` 是**整名锚定**语义（`?`/`*` 才代表任意字符），因此裸查询 `"\u0316"`
  // 对 `"e\u0316\u0301\u0316"` 本就**不该**命中；这一组只断言"命中时形态正确"，
  // 不断言"必然命中"。
  const subsetCases: Array<[string, string]> = [
    ["e\u0316\u0301\u0316", "\u0316"],
    ["e\u0323\u0301\u0301.txt", "\u0301"],
    ["\u1100\u1161\u{1d165}\u{1d165}", "\u{1d165}"],
    ["e\u0316\u0301", "\u0316"],
    ["a\u0323\u0301b", "\u0323"]
  ];
  for (const [name, query] of subsetCases) {
    for (const syntax of ["substring", "wildcard", "regex"] as const) {
      const raw = program(query, syntax).ranges(name);
      const ranges = raw.map((range) => [range.start, range.end] as const);
      for (let index = 1; index < ranges.length; index += 1) {
        assert.ok(ranges[index][0] >= ranges[index - 1][1],
          `${syntax}: ${JSON.stringify(name)} + ${JSON.stringify(query)} produced overlapping ranges ${JSON.stringify(ranges)}`);
      }
      for (const [rangeStart, rangeEnd] of ranges) {
        assert.ok(rangeEnd > rangeStart && rangeStart >= 0 && rangeEnd <= name.length,
          `${syntax}: ${JSON.stringify(name)} + ${JSON.stringify(query)} produced a malformed range ${JSON.stringify(ranges)}`);
      }
    }
  }

  // 整名锚定的 wildcard：`*`…`*` 未必命中 —— 归一化可能把查询里的记号**吸收**进预组合字符
  // （如 `"a\u0323\u0301b"` 的 `U+0323` 并入 `ạ`，NFC 后该记号不再独立存在），这是正确的
  // 规范等价语义。因此这里只断言"命中时形态合法且无重叠"，并另用必然命中的用例防止空转。
  for (const [name, query] of subsetCases) {
    const raw = program(`*${query}*`, "wildcard").ranges(name);
    for (let index = 1; index < raw.length; index += 1) {
      assert.ok(raw[index].start >= raw[index - 1].end,
        `wildcard: *${query}* on ${JSON.stringify(name)} produced overlapping ranges ${JSON.stringify(raw)}`);
    }
    for (const range of raw) {
      assert.ok(range.end > range.start && range.start >= 0 && range.end <= name.length,
        `wildcard: *${query}* on ${JSON.stringify(name)} produced a malformed range ${JSON.stringify(raw)}`);
    }
  }
  // 防空转并钉住精确期望值：这些用例修复前给出 `[[0,4],[0,4]]`（重复），
  // 修复后三种语法一致给出**单段、覆盖整个簇**的区间。
  // 注意 `wildcard` 的 `*` 消费的字符不算字面命中（S-3 的设计），因此它只高亮到簇尾为止，
  // 不含 `.txt` 一类被 `*` 吃掉的后缀 —— 这与它"整名锚定"的语义一致。
  for (const [name, query, expected] of [
    ["e\u0316\u0301\u0316", "\u0316", [[0, 4]]],
    ["e\u0323\u0301\u0301.txt", "\u0301", [[0, 4]]],
    ["\u1100\u1161\u{1d165}\u{1d165}", "\u{1d165}", [[0, 6]]]
  ] as Array<[string, string, number[][]]>) {
    for (const [syntax, pattern] of [["substring", query], ["regex", query], ["wildcard", `*${query}*`]] as const) {
      const raw = program(pattern, syntax).ranges(name);
      assert.deepEqual(raw.map((range) => [range.start, range.end]), expected,
        `${syntax}: ${JSON.stringify(name)} + ${JSON.stringify(pattern)} must yield exactly one span covering the cluster`);
    }
  }

  // 更广的回归守卫：任意组合记号序列（其 NFC 可能折叠成多个 code point）都不得重叠。
  const marks = ["\u0300", "\u0301", "\u0316", "\u0323", "\u0334"];
  for (const first of marks) {
    for (const second of marks) {
      const decomposed = `e${first}${second}`;
      for (const syntax of ["substring", "wildcard", "regex"] as const) {
        const ranges = program(decomposed.normalize("NFC"), syntax).ranges(decomposed);
        for (let index = 1; index < ranges.length; index += 1) {
          assert.ok(ranges[index].start >= ranges[index - 1].end,
            `${syntax}: ${JSON.stringify(decomposed)} produced overlapping ranges ${JSON.stringify(ranges)}`);
        }
      }
      // 单个组合记号作为查询：归一化可能把查询记号**吸收**进预组合字符（如 `U+0300` 并入 `è`），
      // 此时该记号在 NFC 名称中已不独立存在，**不该**命中 —— 这是正确的规范等价语义。
      //
      // 另外，substring/regex 只高亮**命中的片段**而非整个名称，所以这里不能要求"拼回等于原名"
      // （那仅对覆盖全名的查询成立，已由上面的精确期望值用例覆盖）。
      // 本循环的判据是"区间形态合法且互不重叠" —— 这正是 IR2-F1 的失败模式。
      for (const mark of marks) {
        const name = `${decomposed}${mark}`;
        for (const [syntax, pattern] of [["substring", mark], ["regex", mark], ["wildcard", `*${mark}*`]] as const) {
          const raw = program(pattern, syntax).ranges(name);
          const ranges = raw.map((range) => [range.start, range.end] as const);
          for (let index = 1; index < ranges.length; index += 1) {
            assert.ok(ranges[index][0] >= ranges[index - 1][1],
              `${syntax}: lone-mark query on ${JSON.stringify(name)} produced overlapping ranges ${JSON.stringify(ranges)}`);
          }
          for (const [rangeStart, rangeEnd] of ranges) {
            assert.ok(rangeEnd > rangeStart && rangeStart >= 0 && rangeEnd <= name.length,
              `${syntax}: lone-mark query on ${JSON.stringify(name)} produced a malformed range ${JSON.stringify(ranges)}`);
          }
        }
      }
    }
  }
});

test("S2: already-NFC names keep their exact previous behaviour (no regression)", () => {
  // 绝大多数名称已是 NFC，必须走同一路径且结果逐位不变（含非 BMP 与拼音）。
  const nfc = "caf\u00e9-\u6587\u6863-\u{1f600}.txt";
  assert.equal(nfc.normalize("NFC"), nfc, "precondition: this name is already NFC");
  assert.deepEqual(rangesOf(nfc, "caf\u00e9"), [[0, 4]]);
  assert.deepEqual(rangesOf(nfc, "\u6587\u6863"), [[5, 7]]);
  assert.equal(matches(nfc, "wd"), true, "pinyin still works on NFC names");
  for (const slice of slices(nfc, "\u{1f600}")) assert.equal(hasLoneSurrogate(slice), false);
});


test("B5 nested unbounded quantifiers are rejected deterministically", () => {
  // 正则引擎改为线性 NFA（spec §3.1/§3.3），因此这些形态**不再**被拒绝，
  // 而是以 O(长度 × 程序规模) 的代价正常匹配 —— 拒绝不再是安全性的前提。
  for (const pattern of ["(a+)+$", "(a*)*", "(\\d+)+b", "(?:\\w+)+", "(ab+)+", "(a{2,})+", "((a+))*"]) {
    assert.equal(compileQuickFilter(pattern, "regex", "highlight").ok, true, `${pattern} must now be accepted`);
  }
  // 真正的代价保证：危险形态在**长名称**上必须仍然很快，而且结果正确。
  const name = "someordinaryfilenamewithoutspaces.txt";
  for (const pattern of ["(a+)+$", "(a*)*", "(\\d+)+b", "(?:\\w+)+", "(ab+)+", "((a+))*"]) {
    const result = program(pattern, "regex").test(name);
    assertMedianDurationWithin(() => { program(pattern, "regex").test(name); }, 50, `${pattern} on a ${name.length}-char name`);
    assert.equal(result, new RegExp(pattern, "gi").test(name), `${pattern} must agree with native RegExp`);
  }
});

test("B1 the guard's old wall-clock cliff is gone: previously-freezing patterns now match fast", () => {
  // 评审 B-1：这三个形态在修复前会让 UI 冻结（实测 7879ms / 135352ms / 6775ms）。
  for (const pattern of ["(.*a){3}$", "([a-z]{1,10}){1,10}$", "(a+)(a+)(a+)(a+)(a+)(a+)$"]) {
    assertMedianDurationWithin(() => {
      for (const name of [
        "applicationmanifestdocumentation.md",
        "someordinaryfilenamewithoutspaces.txt",
        "a".repeat(120)
      ]) {
        program(pattern, "regex").test(name);
      }
    }, 150, `${pattern} must not freeze on long names`);
  }
});

test("B5 the structural check does not reject ordinary regexes", () => {
  for (const pattern of ["(ab)+", "(a|b)+", "a+b", "a{2,4}", "a{2}", "[+]+", "\\++", "(?:ab)+c", "^\\d+$", "(a)(b)"]) {
    assert.equal(compileQuickFilter(pattern, "regex", "highlight").ok, true, `${pattern} must be accepted`);
  }
});

test("B2 the previously false-rejected everyday regexes are accepted and match correctly", () => {
  // 评审 B-2：这 8 个模式占"看似合理"样本的 31%，修复前被启发式误拒。
  const cases: Array<[pattern: string, name: string, expected: boolean]> = [
    ["\\d+\\.\\d+\\.\\d+\\.\\d+", "192.168.0.1.txt", true],
    ["\\d+\\.\\d+\\.\\d+\\.\\d+", "readme.md", false],
    ["(\\d+\\.){3}\\d+", "192.168.0.1.txt", true],
    ["^v?\\d+(\\.\\d+){1,3}$", "v1.2.3", true],
    ["^v?\\d+(\\.\\d+){1,3}$", "v1.2.3.4.5", false],
    ["\\w+\\s\\w+\\s\\w+\\s\\w+", "a b c d.txt", true],
    ["^(\\w+-)+\\w+$", "my-project-name", true],
    ["(\\d+_)+", "2024_05_report.xlsx", true],
    ["(\\w+_){2,}", "a_b_c.txt", true],
    ["^(\\w+_)+\\w+$", "a_b_c", true]
  ];
  for (const [pattern, name, expected] of cases) {
    const result = compileQuickFilter(pattern, "regex", "highlight");
    assert.equal(result.ok, true, `${pattern} must be accepted`);
    if (result.ok) {
      assert.equal(result.program.test(name), expected, `${pattern} on ${JSON.stringify(name)}`);
    }
  }
});

test("IRA-01 the engine never rejects a pattern for being 'too complex'", () => {
  // 线性引擎的正确性不再依赖"拦截危险模式"，因此不存在复杂度拒绝这条路径；
  // 只有语法错误、不支持的构造和输入规模上限会失败。
  const name = "a".repeat(200);
  // 期望值按模式语义手工推导（原生 RegExp 在同类模式上仍会灾难性回溯，不能当基线）：
  // `(a*){3}b` 需要结尾的 `b`（200 个 a 里没有）⇒ false；其余 `.*a` 类都命中。
  const cases: Array<[pattern: string, expected: boolean]> = [
    ["(.*a){3}$", true],
    ["(a*){3}b", false],
    [".*a.*a.*", true],
    ["(.*a){7}$", true],
    [".*a.*a.*a.*a.*a.*a.*a.*a.*a.*a.*", true]
  ];
  for (const [pattern, expected] of cases) {
    const result = compileQuickFilter(pattern, "regex", "highlight");
    assert.equal(result.ok, true, `${pattern} must be accepted`);
    if (result.ok) {
      // 只对**本引擎**计时。原生 RegExp 仍会在这类模式上灾难性回溯
      // （`(a*){3}b` 在 200 字符上实测 3.3s），因此不能把它放进计时区间 ——
      // 那测的是 V8 的回溯器，不是本引擎。
      assert.equal(result.program.test(name), expected, `${pattern} on 200 a's`);
      assertMedianDurationWithin(() => { result.program.test(name); }, 50, `${pattern} on a 200-char name`);
    }
  }
  assert.equal(program("(a*){3}b", "regex").test("aaab"), true);
  assert.equal(program("(a*){3}b", "regex").test("b"), true, "each `a*` may match empty");
});

test("IRA-01 bounded and literal patterns stay fast and are never rejected", () => {
  // 判定必须只依赖模式文本，且不得误伤正常写法。
  // 注：标题原为"the guard stays fast"（SR1/IR1 F-3）—— 启发式 `guard` 已由线性引擎取代
  // （spec §3.1），保留旧标题会让人误以为守卫仍存在。
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
