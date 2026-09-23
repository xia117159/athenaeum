import { pinyin } from "pinyin-pro";
import { compileLinearRegex } from "./regexEngine";
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
 * 3. 匹配不得存在可被用户输入触发的病态回溯：`wildcard` 与 `regex` **都走线性 NFA**。
 *    `regex` 原先用"结构性风险启发式 + 原生 RegExp"，评审 B-1/B-2 证明该方案同时漏判
 *    （`(.*a){3}$`、`([a-z]{1,10}){1,10}$` 冻结界面）与误拒（31% 的合理模式），
 *    因此改为 `regexEngine.compileLinearRegex`（spec §3.1/§3.3）。
 */

const COMPILE_CACHE_LIMIT = 128;
const NAME_CACHE_LIMIT = 2048;

/** 名称的按 code point 切分索引；`starts`/`lengths` 用于把 code point 区间换算回 code unit。 */
interface NameIndex {
  points: string[];
  lowerPoints: string[];
  starts: number[];
  lengths: number[];
  /**
   * S-2：NFC 归一化后的名称。匹配一律针对它进行，因此组合字符与预组合字符互相命中。
   * 名称本身已是 NFC 时与 `name` **同一字符串**（Windows 上的常态，零额外成本）。
   */
  nfcName: string;
  /**
   * S-2：每个 `points[i]` 所属 cluster 的 code unit 区间。归一化会把一个 cluster 的多个
   * code unit 折叠成若干 code point（如 `e`+U+0301 → `é`），它们**共享**同一个原始区间，
   * 因此区间端点必然落在 cluster 边界上，不会切出半个簇。
   */
  spans: Array<{ start: number; end: number }>;
  /** S-2：每个 cluster 在 `nfcName` 中的起始 code unit 偏移，用于把正则区间映射回原串。 */
  clusterNfcStarts: number[];
  /** 名称已是 NFC 时为真：此时 spans 与 cluster 一一对应，映射可走恒等快路径。 */
  plain: boolean;
}

/** 与 `index.points` 逐位对齐的拼音表；非 CJK 位置回退为字面字符。 */
interface PinyinTables {
  full: string[];
  initial: string[];
}

const nameIndexCache = new Map<string, NameIndex>();
const pinyinTablesCache = new Map<string, PinyinTables>();
const compileCache = new Map<string, QuickFilterCompileResult>();

/**
 * LRU 写入。原实现 `cache.clear()` 在达到上限时**整表清空**，导致刚形成的复用窗口
 * 在跨过 2048 条后瞬间归零（评审 S-1：n=2000 时复用率 52×，n=2100 时 ≈0×）。
 * `Map` 的插入顺序即访问顺序，删除最早一项即可。
 */
function cacheSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  if (cache.has(key)) cache.delete(key);
  while (cache.size >= limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
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

/** 组合记号：必须并入前一 cluster（`\p{M}` 覆盖 Mn/Mc/Me）。 */
function isCombiningMark(point: string) {
  return COMBINING_MARK.test(point);
}
const COMBINING_MARK = /\p{M}/u;

/**
 * S-2 的核心：把名称切成"规范组合簇"，使
 *
 *     NFC(name) === concat(NFC(cluster_i))
 *
 * 成立。该恒等式是区间数学仍然正确的前提 —— 它保证每个归一化后的 code point 唯一对应
 * 原串中一个**连续**区间，因此不需要任何"把偏移猜回去"的启发式。
 *
 * 合并规则（纯局部判定，不依赖任何 Unicode 表）：
 * ① 下一个 code point 是组合记号（`\p{M}`）⇒ 并入；
 * ② 或它与**当前整个簇**结构性组合（`NFC(cur+next) !== NFC(cur)+NFC(next)`）⇒ 并入。
 *
 * **②必须与"整个簇"比较，不能只与紧邻的前一个 code point 比较**。两种比较方式各有一个
 * 已实测的反例，且都是同一类错误（交互对象不在紧邻位置），只是层次不同：
 *
 * - 只看**紧邻对**会漏掉**非相邻的规范重排**：
 *   `"e" + U+0316 + U+0301` 归一化为 `"é" + U+0316` —— 第三个 code point 与第一个组合，
 *   而 `NFC(U+0316 + U+0301) === U+0316 + U+0301`（彼此不组合），紧邻判定看不见。
 * - 只看**紧邻对**还会漏掉**谚文 L+V+T**：`NFC(V+T) === V+T`（V 与 T 单独不组合），
 *   但 `NFC(L+V+T)` 是一个音节。实测在 43 万组谚文语料上有 **288 例**反例。
 *
 * 与整个簇比较则两者都被覆盖（因为 `cur` 已包含 L 和 V）。**规则①仍不可省**：一个当下
 * 看似惰性的记号（`e`+U+0316）可能被**后续**记号重排，把基字符与记号分开就会破坏恒等式。
 *
 * 实测（**470 万**组语料：谚文 L/V/T 全交叉 2–4 字、长记号串、1916 个特殊字符的两两
 * 穷举、多脚本随机串）上述恒等式与"簇严格铺满原串"**零反例**。
 */
function splitClusters(name: string): Array<{ text: string; start: number }> {
  const points = Array.from(name);
  const clusters: Array<{ text: string; start: number }> = [];
  let current = "";
  let currentStart = 0;
  let offset = 0;
  for (const point of points) {
    if (current === "") {
      current = point;
      currentStart = offset;
    } else {
      const interacts = isCombiningMark(point) ||
        (current + point).normalize("NFC") !== current.normalize("NFC") + point.normalize("NFC");
      if (interacts) {
        current += point;
      } else {
        clusters.push({ text: current, start: currentStart });
        current = point;
        currentStart = offset;
      }
    }
    offset += point.length;
  }
  if (current !== "") clusters.push({ text: current, start: currentStart });
  return clusters;
}

/**
 * 按 NFC code point 切分名称，并把每个 code point 映射回**原始串**的 cluster 区间。
 *
 * `nfcName === name` 时走恒等快路径（Windows 上绝大多数名称如此）：一个 code point 一个
 * cluster，区间就是该 code point 自身的 code unit 跨度，与修复前逐位一致。
 */
function getNameIndex(name: string): NameIndex {
  const cached = nameIndexCache.get(name);
  if (cached) return cached;

  const nfcName = name.normalize("NFC");
  if (nfcName === name) {
    const points = Array.from(name);
    const starts: number[] = [];
    const lengths: number[] = [];
    const spans: Array<{ start: number; end: number }> = [];
    const clusterNfcStarts: number[] = [];
    let offset = 0;
    for (const point of points) {
      starts.push(offset);
      lengths.push(point.length);
      spans.push({ start: offset, end: offset + point.length });
      clusterNfcStarts.push(offset);
      offset += point.length;
    }
    return cacheSet(nameIndexCache, name, {
      points,
      lowerPoints: points.map((point) => point.toLowerCase()),
      starts,
      lengths,
      nfcName,
      spans,
      clusterNfcStarts,
      plain: true
    }, NAME_CACHE_LIMIT);
  }

  // 需要归一化：按 cluster 展开，同一 cluster 的多个 code point 共享同一个原始区间。
  const clusters = splitClusters(name);
  const points: string[] = [];
  const starts: number[] = [];
  const lengths: number[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const clusterNfcStarts: number[] = [];
  let nfcOffset = 0;
  for (const cluster of clusters) {
    const nfcText = cluster.text.normalize("NFC");
    clusterNfcStarts.push(nfcOffset);
    spans.push({ start: cluster.start, end: cluster.start + cluster.text.length });
    for (const point of Array.from(nfcText)) {
      points.push(point);
      starts.push(cluster.start);
      lengths.push(cluster.text.length);
    }
    nfcOffset += nfcText.length;
  }
  return cacheSet(nameIndexCache, name, {
    points,
    lowerPoints: points.map((point) => point.toLowerCase()),
    starts,
    lengths,
    nfcName,
    spans,
    clusterNfcStarts,
    plain: false
  }, NAME_CACHE_LIMIT);
}

/**
 * 逐"最大 CJK 连续段"调用 pinyin-pro，避免跨段分组干扰上下文取音，
 * 也避免非中文段落进入转写。返回的表与 code point 严格对齐。
 *
 * S-2：拼音表建立在**归一化后**的 code point 上（`index.points`），与匹配用的点位一致。
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

/** 把 code point 区间换算成原始串的 code unit 区间（S-2：同一簇的多个 code point 共享一个区间）。 */
function pointRangeToUnits(index: NameIndex, start: number, end: number): QuickFilterRange {
  return { start: index.starts[start], end: index.starts[end] + index.lengths[end] };
}

/**
 * 非重叠、从左到右的命中区间。
 *
 * IR2-F1（严重级）：去重必须发生在 **code unit 空间**，而不是 code point 空间。
 * 原因：S-2 让同一簇折叠出的多个 code point **共享同一个原始区间**，因此"再前进一个
 * code point"并不保证越过该簇。若用 code point 下标做去重（`start <= lastEnd`），
 * 当查询只命中簇内 code point 的**真子集**（典型是单个组合记号）时，同一簇会被连续命中
 * 两次，而两次换算得到**完全相同**的区间 ⇒ 渲染层把名称画两遍（实测
 * `"e\u0316\u0301\u0316"` + 查询 `"\u0316"` 得到 `[[0,4],[0,4]]`）。
 * 改为比较换算后的 code unit 区间是否已被上一段覆盖即可。
 */
function substringRanges(name: string, query: string, queryPoints: string[]): QuickFilterRange[] {
  const index = getNameIndex(name);
  const ranges: QuickFilterRange[] = [];
  let lastUnitEnd = -1;
  let lastPointEnd = -1;
  for (let start = 0; start < index.points.length; start += 1) {
    if (start <= lastPointEnd) continue;
    const end = substringMatchEnd(name, query, queryPoints, start);
    if (end === null) continue;
    const units = pointRangeToUnits(index, start, end);
    lastPointEnd = end;
    // 同一簇内的后继 code point 会换算出与上一段相同的区间，跳过以免重复。
    if (units.start < lastUnitEnd) continue;
    ranges.push(units);
    lastUnitEnd = units.end;
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

/**
 * 编译通配符模式。S-2：模式先做 NFC 归一化，与名称一侧的归一化对齐，
 * 因此 `caf?` 能命中 `cafe\u0301`（归一化后是 4 个 code point）。
 */
function compileGlob(pattern: string): GlobProgram {
  const points = Array.from(pattern.normalize("NFC"));
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

/**
 * 通配符命中区间：在 NFA 的可达状态图上做一次 BFS，回溯出一条从 `(0, 0)` 到
 * `(名末, 模式末)` 的路径，并把路径上**由字面记号消费掉**的 code point 合并成区间。
 *
 * 这样 `*.txt` 只高亮 `.txt`、`report?` 只高亮 `report`，而不是把整名点亮（评审 S-3）。
 * `*` 与 `?` 消费的字符不属于"字面命中"，因此不高亮 —— 这是刻意的：
 * 高亮要回答"我输入的哪些字被匹配到了"。
 */
function globLiteralRanges(name: string, glob: GlobProgram): QuickFilterRange[] {
  if (!globTest(name, glob)) return [];
  const index = getNameIndex(name);
  const total = glob.kinds.length;
  const pointCount = index.points.length;
  const width = total + 1;
  const size = (pointCount + 1) * width;
  const id = (position: number, state: number) => position * width + state;

  const previous = new Int32Array(size).fill(-1);
  // 0 = ε 迁移（未消费字符），1 = 字面记号消费，2 = `*`/`?` 消费。
  const kindOf = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  previous[id(0, 0)] = id(0, 0);
  queue[tail] = id(0, 0);
  tail += 1;

  while (head < tail) {
    const current = queue[head];
    head += 1;
    const position = Math.floor(current / width);
    const state = current % width;
    const candidates: number[] = [];
    const kinds: number[] = [];
    const push = (next: number, kind: number) => {
      candidates.push(next);
      kinds.push(kind);
    };
    // `*` 允许零个字符：同位置直接跳到下一状态。
    if (state < total && glob.kinds[state] === KIND_STAR) push(id(position, state + 1), 0);
    if (position < pointCount && state < total) {
      const kind = glob.kinds[state];
      const point = index.lowerPoints[position];
      if (kind === KIND_STAR) push(id(position + 1, state), 2);
      else if (kind === KIND_ANY) push(id(position + 1, state + 1), 2);
      else if (glob.chars[state] === point) push(id(position + 1, state + 1), 1);
    }
    for (let index2 = 0; index2 < candidates.length; index2 += 1) {
      const next = candidates[index2];
      if (previous[next] !== -1) continue;
      previous[next] = current;
      kindOf[next] = kinds[index2];
      queue[tail] = next;
      tail += 1;
    }
  }

  const goal = id(pointCount, total);
  if (previous[goal] === -1) return [];
  const literals = new Set<number>();
  let cursor = goal;
  while (cursor !== id(0, 0)) {
    if (kindOf[cursor] === 1) literals.add(Math.floor(cursor / width) - 1);
    cursor = previous[cursor];
  }
  if (literals.size === 0) return [];

  const ranges: QuickFilterRange[] = [];
  let start = -1;
  let end = -1;
  for (let position = 0; position < pointCount; position += 1) {
    if (!literals.has(position)) continue;
    const pointStart = index.starts[position];
    const pointEnd = pointStart + index.lengths[position];
    if (start < 0) {
      start = pointStart;
      end = pointEnd;
    } else if (pointStart === end) {
      // 紧邻的下一个 code point：延长当前区间。
      end = pointEnd;
    } else if (pointStart < end) {
      // IR2-F1（阻断级）：同一个簇里的**第二个** code point 与前一个共享完全相同的
      // `starts`/`lengths`（S-2 的归一化会把一个簇折叠成多个 code point），因此
      // `pointStart` 等于**当前区间的起点**而不是终点，`pointStart === end` 不成立。
      // 若在此另起区间，就会得到 [[0,3],[0,3]] —— 渲染层把名称画两遍。
      // 该 code point 已被当前区间覆盖，跳过即可。
      continue;
    } else {
      ranges.push({ start, end });
      start = pointStart;
      end = pointEnd;
    }
  }
  if (start >= 0) ranges.push({ start, end });
  return ranges;
}

// ---------------------------------------------------------------------------
// regex: RE2JS adapter, evaluated in the Worker in production.
// ---------------------------------------------------------------------------

/**
 * 把区间边界对齐到 code point 边界，避免把代理对切成两半。
 * RE2JS returns Unicode character boundaries as UTF-16 offsets. Keep this
 * defensive alignment at the renderer boundary for malformed surrogate input.
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

function createProgram(
  mode: QuickFilterMode,
  text: string,
  test: (name: string) => boolean,
  ranges: (name: string) => QuickFilterRange[]
): QuickFilterProgram {
  return { mode, text, test, ranges };
}

/**
 * substring 程序。
 *
 * S-2：查询与名称都先做 NFC 归一化再比较，因此组合字符与预组合字符互相命中。
 * 名称一侧的归一化由 `getNameIndex` 完成（`index.points` 即 NFC code point）。
 */
function compileSubstring(mode: QuickFilterMode, text: string): QuickFilterProgram {
  const query = text.normalize("NFC").toLowerCase();
  const queryPoints = Array.from(query);
  return createProgram(
    mode,
    text,
    (name) => substringTest(name, query, queryPoints),
    (name) => substringRanges(name, query, queryPoints)
  );
}

/**
 * 通配符程序同时保留"线性 NFA 判定"与"字面记号命中区间"。
 *
 * 评审 S-3：原实现命中时返回整名区间 `[{0, name.length}]`，等于"命中即全名高亮"，
 * 与另两种语法的逐段高亮不一致。这里改为沿匹配路径回溯出**字面记号**在名称中的区间，
 * 使 `*.txt` 只高亮 `.txt`、`report?` 只高亮 `report` + 一个字符。
 */
function compileWildcard(mode: QuickFilterMode, text: string): QuickFilterProgram {
  const glob = compileGlob(text);
  return createProgram(
    mode,
    text,
    (name) => globTest(name, glob),
    (name) => globLiteralRanges(name, glob)
  );
}

function compileRegex(mode: QuickFilterMode, text: string): QuickFilterCompileResult {
  // S-2：正则也走 NFC 对齐。查询与名称都归一化，因此 `café` 能命中 `cafe\u0301`。
  const source = text.normalize("NFC");
  const engine = compileLinearRegex(source);
  if (!engine.ok) {
    // 语法错误与"不支持的构造/规模上限"共用同一失败通道（评审 G-4），
    // 但诊断文本分别说明原因，用户能据此判断是自己写错了还是能力边界。
    return { ok: false, message: `正则表达式无效：${engine.message}` };
  }
  return {
    ok: true,
    program: createProgram(
      mode,
      text,
      (name) => engine.test(getNameIndex(name).nfcName),
      (name) => {
        // 引擎在**归一化后**的字符串上匹配，因此得到的是 NFC 坐标下的区间，
        // 必须映射回原始串的 cluster 区间（S-2）。映射只把区间**扩大到完整 cluster**，
        // 因此端点永远落在 cluster 边界上，不会切出半个簇。
        const index = getNameIndex(name);
        const aligned: QuickFilterRange[] = [];
        let floor = 0;
        for (const range of engine.matchRanges(index.nfcName)) {
          const fixed = index.plain
            ? alignRangeToCodePoints(name, range.start, range.end, floor)
            : mapNfcRangeToOriginal(index, name, range.start, range.end, floor);
          if (!fixed) continue;
          aligned.push(fixed);
          floor = fixed.end;
        }
        return aligned;
      }
    )
  };
}

/**
 * 把 NFC 坐标下的区间 `[start, end)` 映射回原始串的 code unit 区间。
 *
 * 取所有与 `[start, end)` 相交的 cluster，返回从**第一个** cluster 起点到**最后一个**
 * cluster 终点的区间 —— 即把区间扩大到完整 cluster 边界。这是唯一安全的做法：
 * 归一化后单个 code point 可能来自多个原 code unit，任何"按比例换算"都会切碎簇。
 * `floor` 保证不越过上一区间（`\b` 一类零宽断言对齐后可能与上一段相接）。
 */
function mapNfcRangeToOriginal(
  index: NameIndex,
  name: string,
  start: number,
  end: number,
  floor: number
): QuickFilterRange | null {
  if (end <= start) return null;
  let first = -1;
  let last = -1;
  const total = index.spans.length;
  for (let cluster = 0; cluster < total; cluster += 1) {
    const clusterStart = index.clusterNfcStarts[cluster];
    const clusterEnd = cluster + 1 < total ? index.clusterNfcStarts[cluster + 1] : index.nfcName.length;
    if (clusterEnd <= start) continue;
    if (clusterStart >= end) break;
    if (first < 0) first = cluster;
    last = cluster;
  }
  if (first < 0) return null;
  let alignedStart = index.spans[first].start;
  const alignedEnd = Math.min(index.spans[last].end, name.length);
  if (alignedStart < floor) alignedStart = floor;
  if (alignedStart >= alignedEnd) return null;
  return { start: alignedStart, end: alignedEnd };
}

/**
 * 编译快速过滤程序。
 * `text` 为空串时返回恒真、无区间的程序；只有 `regex` 语法可能返回失败（D22）。
 *
 * 首尾空白按基线行为处理（评审 G-17）：`trim` 后为空 ⇒ 不过滤，否则以 `trim` 后文本匹配。
 * 这恢复了基线把 `"report "`（尾随空格）视为 `"report"` 的行为，词内空格不受影响。
 */
export function compileQuickFilter(text: string, syntax: QuickFilterSyntax, mode: QuickFilterMode): QuickFilterCompileResult {
  const applied = text.trim();
  // `mode` 参与键：`entryNameHighlight.tsx:16` 依据 `program.mode` 决定是否高亮，
  // 因此不同 mode 的程序不可互换（评审 S-1 修正）。
  const cacheKey = `${syntax}\u0000${mode}\u0000${applied}`;
  const cached = compileCache.get(cacheKey);
  if (cached) return cached;
  if (applied === "") {
    return cacheSet(
      compileCache,
      cacheKey,
      { ok: true, program: createProgram(mode, applied, () => true, () => []) },
      COMPILE_CACHE_LIMIT
    );
  }
  const result =
    syntax === "regex"
      ? compileRegex(mode, applied)
      : { ok: true as const, program: syntax === "wildcard" ? compileWildcard(mode, applied) : compileSubstring(mode, applied) };
  return cacheSet(compileCache, cacheKey, result, COMPILE_CACHE_LIMIT);
}
