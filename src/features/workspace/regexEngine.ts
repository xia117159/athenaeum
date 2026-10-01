import { RE2JS } from "re2js";
import type { QuickFilterRange } from "./quickFilterTypes";

export type RegexCompileResult =
  | { ok: true; source: string; test(name: string): boolean; matchRanges(name: string): QuickFilterRange[] }
  | { ok: false; reason: "syntax" | "unsupported" | "limit"; message: string };

/** RE2 semantics: leftmost-first, lazy quantifiers and Unicode scalar matching.
 * Offsets exposed by RE2JS are UTF-16, as required by React name slicing.
 * Production callers execute this adapter exclusively in the filter Worker.
 */
export function compileLinearRegex(source: string): RegexCompileResult {
  if (source.length > 2000) {
    return { ok: false, reason: "limit", message: "模式过长（上限 2000 个字符）" };
  }
  try {
    // Translation preserves JS Unicode escapes/named groups, but would turn an
    // unsupported named backreference into literal text. Reject it explicitly.
    for (let index = 0; index < source.length; index++) {
      if (source[index] !== "\\") continue;
      index++;
      if (source[index] === "k" && source[index + 1] === "<") {
        return { ok: false, reason: "unsupported", message: "不支持命名反向引用 \\k<name>" };
      }
    }
    const regex = RE2JS.compile(RE2JS.translateRegExp(source), RE2JS.CASE_INSENSITIVE);
    if (regex.programSize() > 32768) {
      return { ok: false, reason: "limit", message: "展开后的程序过大（上限 32768 条指令）" };
    }
    return {
      ok: true,
      source,
      test: (name) => regex.test(name),
      matchRanges(name) {
        const matcher = regex.matcher(name);
        const ranges: QuickFilterRange[] = [];
        while (matcher.find()) {
          const start = matcher.start();
          const end = matcher.end();
          if (end > start) ranges.push({ start, end });
        }
        return ranges;
      }
    };
  } catch (error) {
    return {
      ok: false,
      reason: "syntax",
      message: `RE2 正则语法错误（不支持环视与反向引用）：${error instanceof Error ? error.message : String(error)}`
    };
  }
}
