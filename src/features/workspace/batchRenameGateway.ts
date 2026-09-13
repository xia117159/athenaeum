import type { ApplyBatchRenameRequest, BatchRenamePreview, BatchRenameSession, InvalidateBatchRenameRequest, PreviewBatchRenameRequest, RenameFunctionInfo } from "../../app/batchRename";
import type { OperationTaskSnapshot } from "../../app/types";
import { invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";

export interface BatchRenameGateway {
  create(paths: string[]): Promise<BatchRenameSession>;
  preview(request: PreviewBatchRenameRequest): Promise<BatchRenamePreview>;
  invalidate(request: InvalidateBatchRenameRequest): Promise<void>;
  apply(request: ApplyBatchRenameRequest): Promise<OperationTaskSnapshot>;
  close(sessionId: string): Promise<void>;
  functions(): Promise<RenameFunctionInfo[]>;
}
export function createBatchRenameGateway(runtime: { invoke?: WorkspaceInvoke; runtimeHost?: object | null } = {}): BatchRenameGateway {
  const command = <T>(name: string, args: Record<string, unknown>): Promise<T> => invokeRequired<T>(name, args,
    () => { throw new Error("批量重命名需要 Windows 桌面版"); }, runtime.invoke, runtime.runtimeHost);
  return {
    create: paths => command("create_batch_rename_session", { request: { paths } }),
    preview: request => command("preview_batch_rename", { request }),
    invalidate: request => command("invalidate_batch_rename_preview", { request }),
    apply: request => command("apply_batch_rename", { request }),
    close: sessionId => command("close_batch_rename_session", { sessionId }),
    functions: () => command("get_batch_rename_functions", {})
  };
}
