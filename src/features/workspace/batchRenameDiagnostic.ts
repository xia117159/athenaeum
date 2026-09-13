import type { RenameDiagnostic } from "../../app/batchRename";

/** Backend ranges are UTF-8 bytes; display positions count Unicode code points. */
export function describeRenameDiagnostic(expression: string, diagnostic: RenameDiagnostic, sourceRange = true) {
  if (!sourceRange || !Number.isSafeInteger(diagnostic.start) || diagnostic.start < 0) return diagnostic.message;
  let bytes = 0, position = 1;
  for (const character of expression) {
    if (bytes >= diagnostic.start) break;
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    position++;
  }
  return bytes === diagnostic.start ? `第 ${position} 个字符：${diagnostic.message}` : diagnostic.message;
}
