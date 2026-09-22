import type { QuickFilterRange } from "./quickFilterTypes";

/**
 * 线性正则引擎（spec §3.2/§3.3）。
 *
 * 本模块替代原先"结构性风险启发式 + 原生 RegExp"的方案（评审 B-1/B-2）：
 * 启发式只是在"漏判危险模式"和"误拒合法模式"两个错误类之间搬迁阈值，
 * 因此这里改成**执行方式**上的保证 —— 用 Thompson NFA 的状态集合模拟，
 * 任何模式、任何名称的匹配代价都是 O(名称长度 × 程序规模)，不存在回溯。
 *
 * 语义对齐 `new RegExp(source, "gi")`（无 `u` 标志）：
 * - 不锚定；`^`/`$` 是**整串**首尾（不是行首尾）；带 `i`。
 * - 匹配单位是 UTF-16 code unit，因此 `.` 只吃一个 code unit（可落在代理对中间）。
 * - `ranges` 为全网扫描的非重叠、升序区间；零长度匹配不产生区间。
 *
 * 与原生引擎的两处**已记录偏离**（都是找匹配的取法，不影响存在性判定）：
 * 1. 惰性量词（`a*?`）按贪婪处理；
 * 2. 交替取最长分支（`a|ab` 在 `ab` 上取 `ab`，原生取 `a`）。
 * 二者只影响 `highlight` 的区间切分，不影响"是否命中"。
 *
 * 明确**不支持**并以可读诊断拒绝：环视（`(?=`/`(?<=`…）、反向引用（`\1`/`\k<…>`）、
 * 内联标志（`(?i)`）。原因是环视使匹配不再是正则语言，无法线性实现，
 * 而"接受它"正是灾难性回溯的来源之一。
 */

const MAX_SOURCE_LENGTH = 2000;
const MAX_REPEAT_BOUND = 4096;
const MAX_INSTRUCTIONS = 32768;

const OP_CHAR = 0;
const OP_CLASS = 1;
const OP_ANY = 2;
const OP_SPLIT = 3;
const OP_JMP = 4;
const OP_ASSERT_START = 5;
const OP_ASSERT_END = 6;
const OP_ASSERT_WORD = 7;
const OP_ASSERT_NOT_WORD = 8;
const OP_MATCH = 9;

/** `\d`：仅 ASCII 数字（无 `u` 标志，实测 `[\d]` 不匹配 U+FF11）。 */
const DIGIT_RANGES = [0x30, 0x39];
/** `\w`：仅 ASCII 词字符（实测 63 个 code unit）。 */
const WORD_RANGES = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
/** `\s`：实测 25 个 code unit。 */
const SPACE_RANGES = [
  0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680,
  0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff
];

/**
 * 字符类的一个并集项。
 * `\D`/`\W`/`\S` 在类内是**取反集合**，但取反后仍是 code unit 空间上的区间并集
 * （全集上界 0xFFFF），所以统一用扁平区间表表示，不需要单独的取反标记。
 */
interface ClassTerm {
  readonly ranges: readonly number[];
  /** 全部端点 ≤127：此时非 ASCII 输入必然不命中（实测没有任何 code unit 折叠进 ASCII）。 */
  readonly asciiOnly: boolean;
}

interface ClassSet {
  /** 各项之间是"或"关系（实测 `[a\W]` 等价于 `(?:a|\W)`）。 */
  readonly terms: readonly ClassTerm[];
  /** 顶层 `[^…]` 取反，作用在整个并集上。 */
  readonly negated: boolean;
}

interface Hole {
  index: number;
  field: 1 | 2;
}

interface Frag {
  start: number;
  holes: Hole[];
}

export type RegexCompileResult =
  | {
      ok: true;
      source: string;
      test(name: string): boolean;
      matchRanges(name: string): QuickFilterRange[];
    }
  | { ok: false; reason: "syntax" | "unsupported" | "limit"; message: string };

// ---------------------------------------------------------------------------
// 大小写等价类
// ---------------------------------------------------------------------------

function isAsciiLetterCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

/**
 * 无 `u` 标志下 `/i` 的规范化：转大写；但**非 ASCII 一律不做特殊折叠**
 * （`U+017F`/`U+212A` 在无 `u` 标志下不等于 `s`/`k`，实测）。
 */
function canonicalOf(code: number): number {
  const upper = String.fromCharCode(code).toUpperCase();
  if (upper.length !== 1) return code;
  const upperCode = upper.charCodeAt(0);
  if (code >= 128 && upperCode < 128) return code;
  return upperCode;
}

let canonTable: Uint16Array | null = null;
let membersTable: Map<number, number[]> | null = null;

/**
 * 延迟构建"规范化值 → 等价类成员"表。
 *
 * 实测：`/i` 的等价关系**恰好**是 `canonicalOf(a) === canonicalOf(b)`（全 BMP 零反例），
 * 且等价类最大 4 个成员（如 `U+03A3/U+03C2/U+03C3`；`U+0399` 类含 `U+0345/U+0399/U+03B9/U+1FBE`），
 * ASCII 类的成员恰好是自身与其大小写对。因此区间/取反类都能按"类成员逐个测试"精确定义：
 * 只要**任一**成员落在原区间内即算命中，取反则取非。
 *
 * 该表构造后不可变，因此被多个程序共享是安全的（不变量 I3）。
 */
function ensureFoldTables(): void {
  if (canonTable && membersTable) return;
  const canon = new Uint16Array(0x10000);
  const groups = new Map<number, number[]>();
  for (let code = 0; code <= 0xffff; code += 1) {
    const key = canonicalOf(code);
    canon[code] = key;
    const list = groups.get(key);
    if (list) list.push(code);
    else groups.set(key, [code]);
  }
  // 单成员类无需查表：此时 key === code。
  for (const [key, list] of [...groups]) {
    if (list.length === 1) groups.delete(key);
  }
  canonTable = canon;
  membersTable = groups;
}

function rawHas(ranges: readonly number[], code: number): boolean {
  for (let index = 0; index < ranges.length; index += 2) {
    if (code >= ranges[index] && code <= ranges[index + 1]) return true;
  }
  return false;
}

/** ASCII 输入的折叠：自身或大小写对（实测 ASCII 类无第三个成员）。 */
function asciiFoldHas(ranges: readonly number[], code: number): boolean {
  if (rawHas(ranges, code)) return true;
  if (isAsciiLetterCode(code)) return rawHas(ranges, code ^ 0x20);
  return false;
}

function classMatches(set: ClassSet, code: number): boolean {
  let hit = false;
  for (const term of set.terms) {
    if (code < 128) {
      if (asciiFoldHas(term.ranges, code)) {
        hit = true;
        break;
      }
    } else if (!term.asciiOnly) {
      // 没有任何 code unit ≥128 能折叠进 ASCII，故 ASCII-only 项必然不命中。
      ensureFoldTables();
      const key = canonTable![code];
      const members = membersTable!.get(key);
      if (members ? members.some((member) => rawHas(term.ranges, member)) : rawHas(term.ranges, code)) {
        hit = true;
        break;
      }
    }
  }
  return set.negated ? !hit : hit;
}

function charMatches(literal: number, code: number): boolean {
  if (literal < 128) {
    if (code >= 128) return false;
    if (code === literal) return true;
    return isAsciiLetterCode(code) && isAsciiLetterCode(literal) && (code ^ 0x20) === literal;
  }
  if (code < 128) return false;
  ensureFoldTables();
  return canonTable![code] === canonTable![literal];
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

// ---------------------------------------------------------------------------
// 语法分析
// ---------------------------------------------------------------------------

class RegexSyntaxError extends Error {
  readonly reason: "syntax" | "unsupported" | "limit";

  constructor(message: string, reason: "syntax" | "unsupported" | "limit" = "syntax") {
    super(message);
    this.reason = reason;
  }
}

type Node =
  | { kind: "empty" }
  | { kind: "char"; code: number }
  | { kind: "any" }
  | { kind: "class"; set: ClassSet }
  | { kind: "assert"; op: number }
  | { kind: "seq"; items: Node[] }
  | { kind: "alt"; options: Node[] }
  | { kind: "repeat"; body: Node; min: number; max: number };

interface Quantifier {
  min: number;
  max: number;
  length: number;
}

function digitsAt(source: string, from: number): { value: number; length: number } | null {
  let index = from;
  while (index < source.length && source[index] >= "0" && source[index] <= "9") index += 1;
  if (index === from) return null;
  return { value: Number(source.slice(from, index)), length: index - from };
}

/** 读出 `index` 处的量词；不构成量词时返回 null（Annex B：此时 `{` 是字面量）。 */
function quantifierAt(source: string, index: number): Quantifier | null {
  const character = source[index];
  if (character === "*") return { min: 0, max: Infinity, length: 1 };
  if (character === "+") return { min: 1, max: Infinity, length: 1 };
  if (character === "?") return { min: 0, max: 1, length: 1 };
  if (character !== "{") return null;
  const lower = digitsAt(source, index + 1);
  if (!lower) return null;
  let cursor = index + 1 + lower.length;
  if (source[cursor] === "}") return { min: lower.value, max: lower.value, length: cursor - index + 1 };
  if (source[cursor] !== ",") return null;
  cursor += 1;
  const upper = digitsAt(source, cursor);
  if (!upper) {
    if (source[cursor] === "}") return { min: lower.value, max: Infinity, length: cursor - index + 1 };
    return null;
  }
  cursor += upper.length;
  if (source[cursor] !== "}") return null;
  if (upper.value < lower.value) {
    throw new RegexSyntaxError("数字顺序颠倒的 {} 量词（numbers out of order）");
  }
  if (upper.value > MAX_REPEAT_BOUND) {
    throw new RegexSyntaxError(`量词上界 ${upper.value} 过大（上限 ${MAX_REPEAT_BOUND}）`, "limit");
  }
  return { min: lower.value, max: upper.value, length: cursor - index + 1 };
}

function controlCode(character: string): number {
  return character.toUpperCase().charCodeAt(0) % 32;
}

/** 解析一个非类内转义，返回它代表的节点（可能是字符类或断言）。 */
function parseAtomEscape(source: string, start: number): { node: Node; next: number } {
  const marker = source[start + 1];
  if (marker === undefined) throw new RegexSyntaxError("模式末尾的孤立反斜杠（\\ at end of pattern）");
  const simple: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, f: 0x0c, v: 0x0b, "0": 0x00 };
  if (marker === "d") return { node: { kind: "class", set: makeClass(DIGIT_RANGES, false) }, next: start + 2 };
  if (marker === "D") return { node: { kind: "class", set: makeClass(DIGIT_RANGES, true) }, next: start + 2 };
  if (marker === "w") return { node: { kind: "class", set: makeClass(WORD_RANGES, false) }, next: start + 2 };
  if (marker === "W") return { node: { kind: "class", set: makeClass(WORD_RANGES, true) }, next: start + 2 };
  if (marker === "s") return { node: { kind: "class", set: makeClass(SPACE_RANGES, false) }, next: start + 2 };
  if (marker === "S") return { node: { kind: "class", set: makeClass(SPACE_RANGES, true) }, next: start + 2 };
  if (marker === "b") return { node: { kind: "assert", op: OP_ASSERT_WORD }, next: start + 2 };
  if (marker === "B") return { node: { kind: "assert", op: OP_ASSERT_NOT_WORD }, next: start + 2 };
  if (marker === "k") {
    throw new RegexSyntaxError("不支持命名反向引用 \\k<name>", "unsupported");
  }
  if (marker >= "1" && marker <= "9") {
    throw new RegexSyntaxError(`不支持反向引用 \\${marker}`, "unsupported");
  }
  if (marker === "p" || marker === "P") {
    // 无 `u` 标志时 `\p`/`\P` 不是属性转义，但与原生一致地按字面量处理更安全：
    // 原生把 `\p{L}` 解释为字面量 `p{L}`，因此这里沿用该解释。
    return { node: { kind: "char", code: marker.charCodeAt(0) }, next: start + 2 };
  }
  if (marker === "x") {
    const hex = source.slice(start + 2, start + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return { node: { kind: "char", code: parseInt(hex, 16) }, next: start + 4 };
    return { node: { kind: "char", code: 0x78 }, next: start + 2 };
  }
  if (marker === "u") {
    const hex = source.slice(start + 2, start + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return { node: { kind: "char", code: parseInt(hex, 16) }, next: start + 6 };
    // `\u{41}` 在无 u 标志下不是码点转义：`\u` 是字面量 `u`，`{41}` 是量词。
    return { node: { kind: "char", code: 0x75 }, next: start + 2 };
  }
  if (marker === "c") {
    const letter = source[start + 2];
    if (letter && /[A-Za-z]/.test(letter)) {
      return { node: { kind: "char", code: controlCode(letter) }, next: start + 3 };
    }
    return { node: { kind: "char", code: 0x63 }, next: start + 2 };
  }
  if (marker === "0" || simple[marker] !== undefined) {
    return { node: { kind: "char", code: simple[marker] ?? 0 }, next: start + 2 };
  }
  // 其余（`\q`、`\A`、`\-`、`\/`、`\.`、`\\`、`\ ` …）都是字面量。
  return { node: { kind: "char", code: marker.charCodeAt(0) }, next: start + 2 };
}

const CODE_UNIT_MAX = 0xffff;

function termOf(ranges: readonly number[]): ClassTerm {
  let asciiOnly = true;
  for (const value of ranges) {
    if (value > 127) {
      asciiOnly = false;
      break;
    }
  }
  return { ranges, asciiOnly };
}

/** 在 code unit 空间上求补集，结果仍是升序不相交的区间表。 */
function complementRanges(ranges: readonly number[]): number[] {
  const result: number[] = [];
  let cursor = 0;
  for (let index = 0; index < ranges.length; index += 2) {
    if (ranges[index] > cursor) result.push(cursor, ranges[index] - 1);
    cursor = ranges[index + 1] + 1;
  }
  if (cursor <= CODE_UNIT_MAX) result.push(cursor, CODE_UNIT_MAX);
  return result;
}

function makeClass(ranges: number[], negated: boolean): ClassSet {
  return { terms: [termOf(ranges)], negated };
}

/** 类内转义：只有这些能代表"字符集合"；其余按字面量处理（`\b` 在类内是退格）。 */
function classEscapeTerm(marker: string): number[] | null {
  if (marker === "d") return [...DIGIT_RANGES];
  if (marker === "D") return complementRanges(DIGIT_RANGES);
  if (marker === "w") return [...WORD_RANGES];
  if (marker === "W") return complementRanges(WORD_RANGES);
  if (marker === "s") return [...SPACE_RANGES];
  if (marker === "S") return complementRanges(SPACE_RANGES);
  return null;
}

/**
 * 解析字符类。规则按 Annex B 实测校准：
 * - `]` 紧跟在 `[` 或 `[^` 之后即刻闭合，因此 `[]` 是**空集**（实测不匹配任何输入），
 *   `[^]` 是"匹配任意一个 code unit"；`[]]` 是空集后跟一个字面量 `]`。
 * - `-` 在首位（或末尾、或区间第二个端点不是单个 code unit）时是字面量。
 * - 集合类转义（`\d`/`\w`/`\s` 及其取反）不能充当区间端点：`[a-\d]` 中的 `-` 是字面量。
 * - 类内 `\b` 是退格 U+0008，`\B` 是字面量 `B`（实测）。
 */
function parseClass(source: string, start: number): { node: Node; next: number } {
  let index = start + 1;
  let negated = false;
  if (source[index] === "^") {
    negated = true;
    index += 1;
  }
  const terms: ClassTerm[] = [];
  // 字面端点累积成一个区间表；集合类转义各自成为独立项（实测 `[a\W]` 等价于 `(?:a|\W)`）。
  let literals: number[] = [];
  const flush = () => {
    if (literals.length > 0) {
      terms.push(termOf(literals));
      literals = [];
    }
  };
  let first = true;
  while (index < source.length) {
    if (source[index] === "]") {
      flush();
      return { node: { kind: "class", set: { terms, negated } }, next: index + 1 };
    }
    if (first && source[index] === "-") {
      literals.push(0x2d, 0x2d);
      index += 1;
      first = false;
      continue;
    }
    first = false;

    const low = readClassAtom(source, index);
    index = low.next;
    if (low.kind === "set") {
      flush();
      terms.push(termOf(low.ranges));
      continue;
    }
    // 只有"下一个是 `-` 且再下一个不是 `]`"时才可能是区间。
    if (source[index] === "-" && source[index + 1] !== undefined && source[index + 1] !== "]") {
      const high = readClassAtom(source, index + 1);
      if (high.kind === "code") {
        if (high.code < low.code) throw new RegexSyntaxError("字符类中的区间顺序颠倒（Range out of order）");
        literals.push(low.code, high.code);
        index = high.next;
        continue;
      }
      // 第二个端点是集合类转义：`-` 退化为字面量，三者都是成员。
      literals.push(low.code, low.code);
      literals.push(0x2d, 0x2d);
      flush();
      terms.push(termOf(high.ranges));
      index = high.next;
      continue;
    }
    literals.push(low.code, low.code);
  }
  throw new RegexSyntaxError("未闭合的字符类（Unterminated character class）");
}

type ClassAtom = { kind: "code"; code: number; next: number } | { kind: "set"; ranges: number[]; next: number };

function readClassAtom(source: string, index: number): ClassAtom {
  if (source[index] === "\\") {
    const marker = source[index + 1];
    if (marker === undefined) throw new RegexSyntaxError("字符类末尾的孤立反斜杠");
    if (marker === "b") return { kind: "code", code: 0x08, next: index + 2 };
    const setRanges = classEscapeTerm(marker);
    if (setRanges) return { kind: "set", ranges: setRanges, next: index + 2 };
    const parsed = parseClassEscapeChar(source, index);
    return { kind: "code", code: parsed.code, next: parsed.next };
  }
  return { kind: "code", code: source.charCodeAt(index), next: index + 1 };
}

function parseClassEscapeChar(source: string, slashIndex: number): { code: number; next: number } {
  const marker = source[slashIndex + 1];
  if (marker === undefined) throw new RegexSyntaxError("字符类末尾的孤立反斜杠");
  const simple: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, f: 0x0c, v: 0x0b, b: 0x08 };
  if (simple[marker] !== undefined) return { code: simple[marker], next: slashIndex + 2 };
  if (marker === "x") {
    const hex = source.slice(slashIndex + 2, slashIndex + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return { code: parseInt(hex, 16), next: slashIndex + 4 };
    return { code: 0x78, next: slashIndex + 2 };
  }
  if (marker === "u") {
    const hex = source.slice(slashIndex + 2, slashIndex + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return { code: parseInt(hex, 16), next: slashIndex + 6 };
    return { code: 0x75, next: slashIndex + 2 };
  }
  if (marker === "c") {
    const letter = source[slashIndex + 2];
    if (letter && /[A-Za-z]/.test(letter)) return { code: controlCode(letter), next: slashIndex + 3 };
    return { code: 0x63, next: slashIndex + 2 };
  }
  if (marker === "0") return { code: 0x00, next: slashIndex + 2 };
  return { code: marker.charCodeAt(0), next: slashIndex + 2 };
}

function parseAlternation(source: string, state: { index: number }): Node {
  const options: Node[] = [parseSequence(source, state)];
  while (source[state.index] === "|") {
    state.index += 1;
    options.push(parseSequence(source, state));
  }
  return options.length === 1 ? options[0] : { kind: "alt", options };
}

function parseSequence(source: string, state: { index: number }): Node {
  const items: Node[] = [];
  while (state.index < source.length) {
    const character = source[state.index];
    if (character === "|" || character === ")") break;
    if (character === "*" || character === "+" || character === "?") {
      throw new RegexSyntaxError("没有可重复的表达式（Nothing to repeat）");
    }
    if (character === "{" && quantifierAt(source, state.index)) {
      throw new RegexSyntaxError("没有可重复的表达式（Nothing to repeat）");
    }
    items.push(parseQuantified(source, state));
  }
  if (items.length === 0) return { kind: "empty" };
  return items.length === 1 ? items[0] : { kind: "seq", items };
}

function parseQuantified(source: string, state: { index: number }): Node {
  const atom = parseAtom(source, state);
  const quantifier = quantifierAt(source, state.index);
  if (!quantifier) return atom;
  state.index += quantifier.length;
  // 惰性标记：接受但按贪婪处理（已记录的偏离）。
  if (source[state.index] === "?") state.index += 1;
  return { kind: "repeat", body: atom, min: quantifier.min, max: quantifier.max };
}

function parseGroup(source: string, state: { index: number }): Node {
  const after = source[state.index + 1];
  if (after === "?") {
    const kind = source[state.index + 2];
    if (kind === ":") {
      state.index += 3;
    } else if (kind === "=" || kind === "!") {
      throw new RegexSyntaxError("不支持环视（前瞻）(?=…) / (?!…)", "unsupported");
    } else if (kind === "<") {
      const lookbehind = source[state.index + 3];
      if (lookbehind === "=" || lookbehind === "!") {
        throw new RegexSyntaxError("不支持环视（后顾）(?<=…) / (?<!…)", "unsupported");
      }
      const close = source.indexOf(">", state.index + 3);
      if (close === -1) throw new RegexSyntaxError("命名分组缺少 `>`（Invalid capture group name）");
      const name = source.slice(state.index + 3, close);
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        throw new RegexSyntaxError("命名分组的名字非法（Invalid capture group name）");
      }
      state.index = close + 1;
    } else {
      throw new RegexSyntaxError(
        `不支持扩展分组或内联标志（如 (?i)、(?#…)）：(?${kind ?? ""}`,
        "unsupported"
      );
    }
  } else {
    state.index += 1;
  }
  const body = parseAlternation(source, state);
  if (source[state.index] !== ")") throw new RegexSyntaxError("未闭合的分组（Unterminated group）");
  state.index += 1;
  return body;
}

function parseAtom(source: string, state: { index: number }): Node {
  const character = source[state.index];
  if (character === "(") return parseGroup(source, state);
  if (character === "[") {
    const parsed = parseClass(source, state.index);
    state.index = parsed.next;
    return parsed.node;
  }
  if (character === ".") {
    state.index += 1;
    return { kind: "any" };
  }
  if (character === "^") {
    state.index += 1;
    return { kind: "assert", op: OP_ASSERT_START };
  }
  if (character === "$") {
    state.index += 1;
    return { kind: "assert", op: OP_ASSERT_END };
  }
  if (character === "\\") {
    const parsed = parseAtomEscape(source, state.index);
    state.index = parsed.next;
    return parsed.node;
  }
  state.index += 1;
  return { kind: "char", code: character.charCodeAt(0) };
}

// ---------------------------------------------------------------------------
// 编译：AST → Thompson NFA 指令表
// ---------------------------------------------------------------------------

interface Program {
  ops: Uint8Array;
  out1: Int32Array;
  out2: Int32Array;
  arg: Int32Array;
  classes: ClassSet[];
  entry: number;
  matchIndex: number;
  size: number;
  anchorAtStart: boolean;
  source: string;
}

function buildProgram(root: Node, source: string): Program {
  const ops: number[] = [];
  const out1: number[] = [];
  const out2: number[] = [];
  const arg: number[] = [];
  const classes: ClassSet[] = [];

  function emit(op: number, a = -1, b = -1, argument = -1): number {
    if (ops.length >= MAX_INSTRUCTIONS) {
      throw new RegexSyntaxError(`展开后的程序过大（上限 ${MAX_INSTRUCTIONS} 条指令）`, "limit");
    }
    ops.push(op);
    out1.push(a);
    out2.push(b);
    arg.push(argument);
    return ops.length - 1;
  }

  function patch(holes: Hole[], target: number): void {
    for (const hole of holes) {
      if (hole.field === 1) out1[hole.index] = target;
      else out2[hole.index] = target;
    }
  }

  function sequence(frags: Frag[]): Frag {
    if (frags.length === 0) {
      const index = emit(OP_JMP);
      return { start: index, holes: [{ index, field: 1 }] };
    }
    for (let index = 0; index + 1 < frags.length; index += 1) {
      patch(frags[index].holes, frags[index + 1].start);
    }
    return { start: frags[0].start, holes: frags[frags.length - 1].holes };
  }

  function compile(node: Node): Frag {
    switch (node.kind) {
      case "empty": {
        const index = emit(OP_JMP);
        return { start: index, holes: [{ index, field: 1 }] };
      }
      case "char": {
        const index = emit(OP_CHAR, -1, -1, node.code);
        return { start: index, holes: [{ index, field: 1 }] };
      }
      case "any": {
        const index = emit(OP_ANY);
        return { start: index, holes: [{ index, field: 1 }] };
      }
      case "class": {
        const slot = classes.push(node.set) - 1;
        const index = emit(OP_CLASS, -1, -1, slot);
        return { start: index, holes: [{ index, field: 1 }] };
      }
      case "assert": {
        const index = emit(node.op);
        return { start: index, holes: [{ index, field: 1 }] };
      }
      case "seq":
        return sequence(node.items.map(compile));
      case "alt": {
        const options = node.options.map(compile);
        let current = options[options.length - 1];
        for (let index = options.length - 2; index >= 0; index -= 1) {
          const split = emit(OP_SPLIT);
          out1[split] = options[index].start;
          out2[split] = current.start;
          current = { start: split, holes: [...options[index].holes, ...current.holes] };
        }
        return current;
      }
      case "repeat": {
        const parts: Frag[] = [];
        for (let count = 0; count < node.min; count += 1) parts.push(compile(node.body));
        if (node.max === Infinity) {
          const inner = compile(node.body);
          const split = emit(OP_SPLIT);
          out1[split] = inner.start;
          patch(inner.holes, split);
          parts.push({ start: split, holes: [{ index: split, field: 2 }] });
        } else {
          for (let count = node.min; count < node.max; count += 1) {
            const inner = compile(node.body);
            const split = emit(OP_SPLIT);
            out1[split] = inner.start;
            parts.push({ start: split, holes: [...inner.holes, { index: split, field: 2 }] });
          }
        }
        return sequence(parts);
      }
    }
  }

  const rootFrag = compile(root);
  const matchIndex = emit(OP_MATCH);
  patch(rootFrag.holes, matchIndex);

  // 起始锚定检测：仅作为"只需从 0 开始尝试"的优化，保守取 false 也始终正确。
  let foundStart = false;
  let foundOther = false;
  const seen = new Set<number>();
  const stack = [rootFrag.start];
  while (stack.length > 0) {
    const index = stack.pop()!;
    if (seen.has(index)) continue;
    seen.add(index);
    const op = ops[index];
    if (op === OP_SPLIT) stack.push(out1[index], out2[index]);
    else if (op === OP_JMP) stack.push(out1[index]);
    else if (op === OP_ASSERT_START) foundStart = true;
    else foundOther = true;
  }

  return {
    ops: Uint8Array.from(ops),
    out1: Int32Array.from(out1),
    out2: Int32Array.from(out2),
    arg: Int32Array.from(arg),
    classes,
    entry: rootFrag.start,
    matchIndex,
    size: ops.length,
    anchorAtStart: foundStart && !foundOther,
    source
  };
}

// ---------------------------------------------------------------------------
// 执行：状态集合模拟（无回溯）
// ---------------------------------------------------------------------------

function assertionHolds(op: number, name: string, position: number): boolean {
  if (op === OP_ASSERT_START) return position === 0;
  if (op === OP_ASSERT_END) return position === name.length;
  const before = position > 0 && isWordCode(name.charCodeAt(position - 1));
  const after = position < name.length && isWordCode(name.charCodeAt(position));
  return op === OP_ASSERT_WORD ? before !== after : before === after;
}

/** ε 闭包：展开 JMP/SPLIT，并在当前位置求值断言。返回集合内被置位的状态数。 */
function closeStates(program: Program, states: Uint8Array, name: string, position: number, stack: Int32Array): number {
  let top = 0;
  let count = 0;
  for (let index = 0; index < program.size; index += 1) {
    if (states[index]) {
      stack[top] = index;
      top += 1;
      count += 1;
    }
  }
  while (top > 0) {
    top -= 1;
    const index = stack[top];
    const op = program.ops[index];
    if (op === OP_SPLIT) {
      const first = program.out1[index];
      const second = program.out2[index];
      if (!states[first]) {
        states[first] = 1;
        stack[top] = first;
        top += 1;
        count += 1;
      }
      if (!states[second]) {
        states[second] = 1;
        stack[top] = second;
        top += 1;
        count += 1;
      }
      continue;
    }
    let target = -1;
    if (op === OP_JMP) target = program.out1[index];
    else if (
      op === OP_ASSERT_START ||
      op === OP_ASSERT_END ||
      op === OP_ASSERT_WORD ||
      op === OP_ASSERT_NOT_WORD
    ) {
      if (!assertionHolds(op, name, position)) continue;
      target = program.out1[index];
    } else {
      // CHAR/CLASS/ANY/MATCH 对闭包是终点。
      continue;
    }
    if (target >= 0 && !states[target]) {
      states[target] = 1;
      stack[top] = target;
      top += 1;
      count += 1;
    }
  }
  return count;
}

function stepStates(program: Program, current: Uint8Array, next: Uint8Array, code: number): void {
  for (let index = 0; index < program.size; index += 1) {
    if (!current[index]) continue;
    const op = program.ops[index];
    if (op === OP_CHAR) {
      if (charMatches(program.arg[index], code)) next[program.out1[index]] = 1;
    } else if (op === OP_CLASS) {
      if (classMatches(program.classes[program.arg[index]], code)) next[program.out1[index]] = 1;
    } else if (op === OP_ANY) {
      if (!isLineTerminator(code)) next[program.out1[index]] = 1;
    }
  }
}

/**
 * 存在性判定：单趟同时模拟"从每一个位置开始"的线程集合。
 * 只关心可达性，因此不需要记录起点，代价是 O(名称长度 × 程序规模)。
 */
function runTest(program: Program, name: string): boolean {
  const size = program.size;
  const length = name.length;
  const stack = new Int32Array(size);
  let current = new Uint8Array(size);
  let next = new Uint8Array(size);
  for (let position = 0; position <= length; position += 1) {
    current[program.entry] = 1;
    closeStates(program, current, name, position, stack);
    if (current[program.matchIndex]) return true;
    if (position < length) {
      next.fill(0);
      stepStates(program, current, next, name.charCodeAt(position));
      const swap = current;
      current = next;
      next = swap;
    }
  }
  return false;
}

/** 从 `start` 起锚定的**最长**匹配结束位置；无匹配返回 -1。 */
function longestEndFrom(program: Program, name: string, start: number): number {
  const size = program.size;
  const length = name.length;
  const stack = new Int32Array(size);
  const current = new Uint8Array(size);
  const next = new Uint8Array(size);
  let best = -1;
  current[program.entry] = 1;
  let count = closeStates(program, current, name, start, stack);
  if (current[program.matchIndex]) best = start;
  for (let position = start; position < length; position += 1) {
    next.fill(0);
    stepStates(program, current, next, name.charCodeAt(position));
    count = closeStates(program, next, name, position + 1, stack);
    if (next[program.matchIndex]) best = position + 1;
    current.set(next);
    // MATCH 是终点，不参与"是否还能继续消费"的判断。
    const alive = count - (next[program.matchIndex] ? 1 : 0);
    if (alive <= 0) break;
  }
  return best;
}

/**
 * 全局扫描：从左到右取**最左、在该起点下最长**的非重叠匹配。
 *
 * 先用线性的 `runTest` 做**存在性预筛**：没有匹配时直接返回，避免为每个起点
 * 各跑一趟模拟（这正是 `(a{1,20}){1,20}$` 对上 128 字符名称会耗时 70ms+ 的原因）。
 * 有匹配时再逐起点求最长结束位置；Windows 名称长度上限（255 code unit）构成硬约束。
 */
function runRanges(program: Program, name: string): QuickFilterRange[] {
  if (!runTest(program, name)) return [];
  const length = name.length;
  const ranges: QuickFilterRange[] = [];

  // 起始锚定：只可能从 0 开始，扫描一次即可（否则会反复重试 0 号起点）。
  if (program.anchorAtStart) {
    const end = longestEndFrom(program, name, 0);
    if (end > 0) ranges.push({ start: 0, end });
    return ranges;
  }

  let floor = 0;
  // 每轮至少推进 1 个 code unit，因此循环次数有界。
  while (floor <= length) {
    let advanced = false;
    for (let candidate = floor; candidate <= length; candidate += 1) {
      const end = longestEndFrom(program, name, candidate);
      if (end < 0) continue;
      if (end > candidate) {
        ranges.push({ start: candidate, end });
        floor = end;
      } else {
        // 零长度匹配不产生区间，但必须推进，否则会死循环。
        floor = candidate + 1;
      }
      advanced = true;
      break;
    }
    if (!advanced) break;
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export function compileLinearRegex(source: string): RegexCompileResult {
  try {
    if (source.length > MAX_SOURCE_LENGTH) {
      throw new RegexSyntaxError(`模式过长（上限 ${MAX_SOURCE_LENGTH} 个字符）`, "limit");
    }
    const state = { index: 0 };
    const root = parseAlternation(source, state);
    if (state.index < source.length) {
      throw new RegexSyntaxError("多余的右括号（Unmatched ')'）");
    }
    const program = buildProgram(root, source);
    return {
      ok: true,
      source,
      test: (name: string) => runTest(program, name),
      matchRanges: (name: string) => runRanges(program, name)
    };
  } catch (error) {
    if (error instanceof RegexSyntaxError) {
      return { ok: false, reason: error.reason, message: error.message };
    }
    return {
      ok: false,
      reason: "syntax",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
