import type { BatchRenameRow } from "../../app/batchRename";
import type { OperationTaskSnapshot } from "../../app/types";

export function batchRenameResultRows(rows: BatchRenameRow[], task?: OperationTaskSnapshot): BatchRenameRow[] {
  if (!task || !["failed", "cancelled", "partialSucceeded", "succeeded"].includes(task.status)) return rows;
  const results = new Map(task.entryResults.flatMap(result => result.source?.kind === "local" ? [[result.source.path, result] as const] : []));
  return rows.map(row => {
    const result = results.get(row.sourcePath);
    const path = result?.destination?.kind === "local" ? result.destination.path : row.sourcePath;
    const uncertain = result?.error?.retryable === false;
    const changed = path !== row.sourcePath;
    return { ...row, newName: uncertain ? null : path.split(/[\\/]/).at(-1) ?? row.oldName, targetPath: path,
      status: uncertain ? "error" : changed ? "changed" : "unchanged",
      diagnostic: uncertain || (changed && task.status !== "succeeded")
        ? { start: 0, end: 0, message: result?.error?.message ?? "名称尚未恢复，可在操作历史中继续恢复。" } : null };
  });
}
