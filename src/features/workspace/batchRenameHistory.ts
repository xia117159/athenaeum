export const BATCH_RENAME_HISTORY_KEY = "athenaeum.batch-rename.history.v1";
type HistoryStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): HistoryStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
function normalize(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string =>
    typeof entry === "string" && entry.trim().length > 0 && entry.length <= 16384 && !/[\r\n]/.test(entry)))].slice(0, 20);
}
export function readBatchRenameHistory(storage: HistoryStorage | undefined = browserStorage()): string[] {
  try { return normalize(JSON.parse(storage?.getItem(BATCH_RENAME_HISTORY_KEY) ?? "[]")); } catch { return []; }
}
export function rememberBatchRenameExpression(expression: string, storage: HistoryStorage | undefined = browserStorage()): string[] {
  const history = normalize([expression, ...readBatchRenameHistory(storage)]);
  try { storage?.setItem(BATCH_RENAME_HISTORY_KEY, JSON.stringify(history)); } catch { /* Storage may be unavailable in embedded/private contexts. */ }
  return history;
}
