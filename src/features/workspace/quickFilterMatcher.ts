import { pinyin } from "pinyin-pro";
import type {
  QuickFilterCompileResult,
  QuickFilterMode,
  QuickFilterProgram,
  QuickFilterRange,
  QuickFilterSyntax
} from "./quickFilterTypes";

/**
 * 快速过滤的编译与匹配内核。
 *
 * 三条硬性设计约束（详见 spec §6）：
 * 1. 匹配源只有 `entry.name`（D6）。本模块不接触路径、描述或标签。
 * 2. 拼音只在 `substring` 语法下叠加（D3），且 `pinyin-pro` **只在本模块**被引入（评审 Sug3）。
 * 3. 匹配不得存在可被用户输入触发的病态回溯：`wildcard` 走线性 NFA，
 *    `regex` 走**结构性风险检测**（spec §6.4，实现期修订：原"墙钟探测"方案被否决）。
 */

const REGEX_RANGE_ITERATION_LIMIT = 4096;
const COMPILE_CACHE_LIMIT = 128;
const NAME_CACHE_LIMIT = 2048;

/** 名称的按 code point 切分索引；`starts`/`lengths` 用于把 code point 区间换算回 code unit。 */
interface NameIndex {
  points: string[];
  lowerPoints: string[];
  starts: number[];
  lengths: number[];
}

/** 与 `index.points` 逐位对齐的拼音表；非 CJK 位置回退为字面字符。 */
interface PinyinTables {
  full: string[];
  initial: string[];
}

const nameIndexCache = new Map<string, NameIndex>();
const pinyinTablesCache = new Map<string, PinyinTables>();
const compileCache = new Map<string, QuickFilterCompileResult>();

function cacheSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  if (cache.size >= limit) cache.clear();
  cache.set(key, value);
  return value;
}

function isCjkCodePoint(code: number) {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

/**
 * 按 code point 切分名称，并预计算 code unit 偏移。
 * 位置基准统一为 code point，切片渲染前才换算回 code unit，因此非 BMP 名称不会切出半个代理对。
 */
function getNameIndex(name: string): NameIndex {
  const cached = nameIndexCache.get(name);
  if (cached) return cached;
  const points = Array.from(name);
  const starts: number[] = [];
  const lengths: number[] = [];
  let offset = 0;
  for (const point of points) {
    starts.push(offset);
    lengths.push(point.length);
    offset += point.length;
  }
  return cacheSet(nameIndexCache, name, { points, lowerPoints: points.map((point) => point.toLowerCase()), starts, lengths }, NAME_CACHE_LIMIT);
}

/**
 * 逐"最大 CJK 连续段"调用 pinyin-pro，避免跨段分组干扰上下文取音，
 * 也避免非中文段落进入转写。返回的表与 code point 严格对齐。
 */
function getPinyinTables(name: string): PinyinTables {
  const cached = pinyinTablesCache.get(name);
  if (cached) return cached;
  const index = getNameIndex(name);
  const points = index.points;
  const full: string[] = new Array(points.length);
  const initial: string[] = new Array(points.length);
  let position = 0;
  while (position < points.length) {
    const code = points[position].codePointAt(0) ?? 0;
    if (!isCjkCodePoint(code)) {
      full[position] = index.lowerPoints[position];
      initial[position] = index.lowerPoints[position];
      position += 1;
      continue;
    }
    let end = position;
    while (end < points.length && isCjkCodePoint(points[end].codePointAt(0) ?? 0)) end += 1;
    let syllables: string[] = [];
    try {
      syllables = pinyin(points.slice(position, end).join(""), { type: "array", toneType: "none" });
    } catch {
      syllables = [];
    }
    for (let offset = position; offset < end; offset += 1) {
      const syllable = (syllables[offset - position] ?? "").toLowerCase();
      full[offset] = syllable || index.lowerPoints[offset];
      initial[offset] = syllable ? syllable.slice(0, 1) : index.lowerPoints[offset];
    }
    position = end;
  }
  return cacheSet(pinyinTablesCache, name, { full, initial }, NAME_CACHE_LIMIT);
}

function isAsciiLetterQuery(query: string) {
  return query.length > 0 && /^[a-z]+$/.test(query);
}

/**
 * substring 语法下、从 `start`（code point 下标）开始的最短匹配结束位置（含）。
 * 先试字面子串，失败且查询为纯 ASCII 字母时再走拼音贪心消费扫描。
 */
function substringMatchEnd(name: string, query: string, queryPoints: string[], start: number): number | null {
  const index = getNameIndex(name);
  const total = queryPoints.length;
  const remaining = index.points.length - start;
  if (remaining >= total) {
    let literal = true;
    for (let offset = 0; offset < total; offset += 1) {
      if (index.lowerPoints[start + offset] !== queryPoints[offset]) {
        literal = false;
        break;
      }
    }
    if (literal) return start + total - 1;
  }
  if (!isAsciiLetterQuery(query)) return null;
  const tables = getPinyinTables(name);
  let positions = new Set<number>([0]);
  for (let position = start; position < index.points.length; position += 1) {
    const literal = index.lowerPoints[position];
    const full = tables.full[position];
    const initial = tables.initial[position];
    const next = new Set<number>();
    for (const consumed of positions) {
      if (literal === query[consumed]) next.add(consumed + 1);
      if (full.length > 0 && query.startsWith(full, consumed)) next.add(consumed + full.length);
      if (initial.length > 0 && query.startsWith(initial, consumed)) next.add(consumed + initial.length);
    }
    if (next.size === 0) return null;
    if (next.has(total)) return position;
    positions = next;
  }
  return null;
}

function pushRange(ranges: QuickFilterRange[], index: NameIndex, start: number, end: number) {
  ranges.push({ start: index.starts[start], end: index.starts[end] + index.lengths[end] });
}

/** 非重叠、从左到右的命中区间。 */
function substringRanges(name: string, query: string, queryPoints: string[]): QuickFilterRange[] {
  const index = getNameIndex(name);
  const ranges: QuickFilterRange[] = [];
  let lastEnd = -1;
  for (let start = 0; start < index.points.length; start += 1) {
    if (start <= lastEnd) continue;
    const end = substringMatchEnd(name, query, queryPoints, start);
    if (end === null) continue;
    pushRange(ranges, index, start, end);
    lastEnd = end;
  }
  return ranges;
}

function substringTest(name: string, query: string, queryPoints: string[]): boolean {
  const index = getNameIndex(name);
  for (let start = 0; start < index.points.length; start += 1) {
    if (substringMatchEnd(name, query, queryPoints, start) !== null) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// wildcard：锚定整名匹配的线性 NFA（不构造 RegExp，因此不存在病态回溯）
// ---------------------------------------------------------------------------

const KIND_LITERAL = 0;
const KIND_ANY = 1;
const KIND_STAR = 2;

interface GlobProgram {
  kinds: Uint8Array;
  chars: string[];
}

function compileGlob(pattern: string): GlobProgram {
  const points = Array.from(pattern);
  const kinds = new Uint8Array(points.length);
  const chars: string[] = new Array(points.length).fill("");
  for (let position = 0; position < points.length; position += 1) {
    if (points[position] === "*") {
      kinds[position] = KIND_STAR;
    } else if (points[position] === "?") {
      kinds[position] = KIND_ANY;
    } else {
      kinds[position] = KIND_LITERAL;
      chars[position] = points[position].toLowerCase();
    }
  }
  return { kinds, chars };
}

/** `*` 允许零个字符，因此状态在第 j 位且第 j 位是 `*` 时可直接推进到 j+1。升序单趟即可收敛。 */
function globClosure(states: Uint8Array, glob: GlobProgram) {
  const total = glob.kinds.length;
  for (let position = 0; position < total; position += 1) {
    if (states[position] && glob.kinds[position] === KIND_STAR) states[position + 1] = 1;
  }
}

function globTest(name: string, glob: GlobProgram): boolean {
  const index = getNameIndex(name);
  const total = glob.kinds.length;
  let current = new Uint8Array(total + 1);
  let next = new Uint8Array(total + 1);
  current[0] = 1;
  globClosure(current, glob);
  for (const point of index.lowerPoints) {
    next.fill(0);
    for (let position = 0; position < total; position += 1) {
      if (!current[position]) continue;
      if (glob.kinds[position] === KIND_STAR) next[position] = 1;
      else if (glob.kinds[position] === KIND_ANY) next[position + 1] = 1;
      else if (glob.chars[position] === point) next[position + 1] = 1;
    }
    globClosure(next, glob);
    const swap = current;
    current = next;
    next = swap;
  }
  return current[total] === 1;
}

// ---------------------------------------------------------------------------
// regex：原生 RegExp + 结构性风险检测
// ---------------------------------------------------------------------------

/**
 * 读出 `index` 处的量词记号。只有无界量词（`*`、`+`、`{n,}`）才可能造成指数级回溯；
 * `?` 与 `{n,m}` 是有界的，不算。`count` 用于评估"有界重复放大内部歧义"。
 */
function quantifierTokenAt(pattern: string, index: number): { length: number; unbounded: boolean; count: number } {
  const character = pattern[index];
  if (character === "*" || character === "+") return { length: 1, unbounded: true, count: Infinity };
  if (character !== "{") return { length: 0, unbounded: false, count: 1 };
  const close = pattern.indexOf("}", index + 1);
  if (close === -1) return { length: 0, unbounded: false, count: 1 };
  const body = pattern.slice(index + 1, close);
  if (!/^\d+(,\d*)?$/.test(body)) return { length: 0, unbounded: false, count: 1 };
  const length = close - index + 1;
  if (body.includes(",")) {
    const upper = body.slice(body.indexOf(",") + 1);
    // `{n,}` 无上界 ⇒ 无界；`{n,m}` 有界，count = m。
    return upper === "" ? { length, unbounded: true, count: Infinity } : { length, unbounded: false, count: Number(upper) };
  }
  return { length, unbounded: false, count: Number(body) };
}

/**
 * 歧义权重上限：超过它即判定为风险。取 3 的依据是实测回溯量级 ——
 * 无界量词彼此可匹配同一段文本时，回溯量约为"名称长度 ^ 权重"，权重 4 在
 * 255 字符名称上已达 ~4×10⁹ 步，而权重 ≤3 仍在可控范围。
 */
const UNSAFE_QUANTIFIER_WEIGHT = 3;

/**
 * 确定性的正则风险结构检测（判定只依赖模式文本，不可能挂起）。
 *
 * 覆盖**两类**灾难性回溯形态，二者都由"同一段文本存在指数级多种切分方式"造成：
 *
 * 1. **嵌套**：无界量词直接作用于自身已含无界量词的分组 —— `(a+)+`、`(\d*)*`、`((a+))*`、`(ab+)+`。
 * 2. **顺序/重复**：同一层出现多个可匹配同一段文本的无界量词，或"含无界量词的分组被有界重复放大"。
 *    典型是 §6.2 点名的 `.*a.*a.*a.*a.*a.*a.*a.*a.*a.*a.*`，以及 `(.*a){7}` ——
 *    后者的分组量词 `{7}` 虽然是**有界**的，但每次重复都会把内部 `.*` 的歧义再乘一层。
 *
 * 实现期修订（第二轮）：初版只检测形态 1，实测漏检形态 2 —— `(.*a){7}$` 对 41 字符名称
 * 单次 `ranges()` 耗时 **5726ms**（`{6}` 1247ms、`{5}` 226ms），正是 §6.2 要消除的
 * "键入瞬间冻结界面"。因此改为对**歧义权重**求和：同一层每个无界量词计 1，
 * 含无界量词的分组被有界重复 n 次则把内部权重乘 n，无界量词套无界量词直接判危。
 */
function hasUnsafeQuantifierStructure(pattern: string): boolean {
  type Frame = { sum: number; hasUnbounded: boolean };
  const frames: Frame[] = [{ sum: 0, hasUnbounded: false }];
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "[") {
      index += 1;
      while (index < pattern.length && pattern[index] !== "]") {
        if (pattern[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      const classQuantifier = quantifierTokenAt(pattern, index);
      if (classQuantifier.length > 0) {
        if (classQuantifier.unbounded) {
          frames[frames.length - 1].sum += 1;
          frames[frames.length - 1].hasUnbounded = true;
        }
        index += classQuantifier.length;
      }
      continue;
    }
    if (character === "(") {
      frames.push({ sum: 0, hasUnbounded: false });
      index += 1;
      continue;
    }
    if (character === ")") {
      const child = frames.pop() ?? { sum: 0, hasUnbounded: false };
      index += 1;
      if (frames.length === 0) frames.push({ sum: 0, hasUnbounded: false });
      const parent = frames[frames.length - 1];
      const groupQuantifier = quantifierTokenAt(pattern, index);
      if (groupQuantifier.length === 0) {
        parent.sum += child.sum;
        parent.hasUnbounded = parent.hasUnbounded || child.hasUnbounded;
        continue;
      }
      if (groupQuantifier.unbounded) {
        // 形态 1：无界量词套在"内部已含无界量词"的分组上。
        if (child.hasUnbounded) return true;
        parent.sum += 1;
        parent.hasUnbounded = true;
      } else {
        // 形态 2：有界重复把内部歧义按次数放大。
        parent.sum += child.sum * groupQuantifier.count;
        parent.hasUnbounded = parent.hasUnbounded || child.hasUnbounded;
      }
      index += groupQuantifier.length;
      if (parent.sum > UNSAFE_QUANTIFIER_WEIGHT) return true;
      continue;
    }
    const quantifier = quantifierTokenAt(pattern, index);
    if (quantifier.length > 0) {
      if (quantifier.unbounded) {
        frames[frames.length - 1].sum += 1;
        frames[frames.length - 1].hasUnbounded = true;
      }
      index += quantifier.length;
      if (frames[frames.length - 1].sum > UNSAFE_QUANTIFIER_WEIGHT) return true;
      continue;
    }
    index += 1;
  }
  return false;
}

/**
 * 把区间边界对齐到 code point 边界，避免把代理对切成两半。
 * 正则带 `gi` 不带 `u`（§6.3），因此匹配可能停在代理对中间：
 * `start` 落在低位代理时要回退一位，`end` 前面是高位的代理时要前进一位。
 */
function alignRangeToCodePoints(name: string, start: number, end: number, floor: number): QuickFilterRange | null {
  let alignedStart = start;
  let alignedEnd = end;
  const startCode = name.charCodeAt(alignedStart);
  if (startCode >= 0xdc00 && startCode <= 0xdfff) alignedStart -= 1;
  const lastCode = name.charCodeAt(alignedEnd - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) alignedEnd += 1;
  // 对齐后不得与上一区间重叠，也不得越过字符串末尾。
  if (alignedStart < floor) alignedStart = floor;
  if (alignedEnd > name.length) alignedEnd = name.length;
  if (alignedStart >= alignedEnd) return null;
  return { start: alignedStart, end: alignedEnd };
}

function regexRanges(regex: RegExp, name: string): QuickFilterRange[] {
  const ranges: QuickFilterRange[] = [];
  regex.lastIndex = 0;
  let iterations = 0;
  let floor = 0;
  let match = regex.exec(name);
  while (match && iterations < REGEX_RANGE_ITERATION_LIMIT) {
    iterations += 1;
    if (match[0].length > 0) {
      const aligned = alignRangeToCodePoints(name, match.index, match.index + match[0].length, floor);
      if (aligned) {
        ranges.push(aligned);
        floor = aligned.end;
      }
    } else {
      // 零长度匹配必须手动推进，否则 exec 会永远停在同一位置。
      regex.lastIndex = match.index + 1;
    }
    if (regex.lastIndex > name.length) break;
    match = regex.exec(name);
  }
  return ranges;
}

function createProgram(
  mode: QuickFilterMode,
  text: string,
  test: (name: string) => boolean,
  ranges: (name: string) => QuickFilterRange[]
): QuickFilterProgram {
  return { mode, text, test, ranges };
}

function compileSubstring(mode: QuickFilterMode, text: string): QuickFilterProgram {
  const query = text.toLowerCase();
  const queryPoints = Array.from(query);
  return createProgram(
    mode,
    text,
    (name) => substringTest(name, query, queryPoints),
    (name) => substringRanges(name, query, queryPoints)
  );
}

function compileWildcard(mode: QuickFilterMode, text: string): QuickFilterProgram {
  const glob = compileGlob(text);
  return createProgram(
    mode,
    text,
    (name) => globTest(name, glob),
    (name) => (globTest(name, glob) ? [{ start: 0, end: name.length }] : [])
  );
}

function compileRegex(mode: QuickFilterMode, text: string): QuickFilterCompileResult {
  let regex: RegExp;
  try {
    regex = new RegExp(text, "gi");
  } catch (error) {
    // 语法错误优先报告，避免用户看到一个"过于复杂"却其实是写错了的模式。
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `正则表达式无效：${message}` };
  }
  if (hasUnsafeQuantifierStructure(text)) {
    return { ok: false, message: "正则表达式过于复杂，已保留上一次有效匹配" };
  }
  return {
    ok: true,
    program: createProgram(
      mode,
      text,
      (name) => {
        regex.lastIndex = 0;
        return regex.test(name);
      },
      (name) => regexRanges(regex, name)
    )
  };
}

/**
 * 编译快速过滤程序。
 * `text` 为空串时返回恒真、无区间的程序；只有 `regex` 语法可能返回失败（D22）。
 */
export function compileQuickFilter(text: string, syntax: QuickFilterSyntax, mode: QuickFilterMode): QuickFilterCompileResult {
  const cacheKey = `${syntax}\u0000${mode}\u0000${text}`;
  const cached = compileCache.get(cacheKey);
  if (cached) return cached;
  if (text === "") {
    return cacheSet(compileCache, cacheKey, { ok: true, program: createProgram(mode, text, () => true, () => []) }, COMPILE_CACHE_LIMIT);
  }
  const result =
    syntax === "regex"
      ? compileRegex(mode, text)
      : { ok: true as const, program: syntax === "wildcard" ? compileWildcard(mode, text) : compileSubstring(mode, text) };
  return cacheSet(compileCache, cacheKey, result, COMPILE_CACHE_LIMIT);
}
