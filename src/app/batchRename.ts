import type { OperationIntent } from "./types";

/** start/end are zero-based UTF-8 byte offsets, end exclusive; file errors use 0..0. */
export interface RenameDiagnostic { message: string; start: number; end: number }
export interface BatchRenameRow {
  id: string;
  sourcePath: string;
  parentPath: string;
  oldName: string;
  newName: string | null;
  targetPath: string | null;
  isDirectory: boolean;
  status: "unchanged" | "changed" | "error";
  diagnostic: RenameDiagnostic | null;
}
export interface BatchRenameSession {
  sessionId: string;
  frozenAt: string;
  items: BatchRenameRow[];
}
export interface BatchRenamePreview {
  sessionId: string;
  revision: number;
  expression: string;
  previewId: string | null;
  items: BatchRenameRow[];
  diagnostics: RenameDiagnostic[];
  changedCount: number;
  canApply: boolean;
}
export interface PreviewBatchRenameRequest { sessionId: string; expression: string; revision: number }
export interface InvalidateBatchRenameRequest { sessionId: string; revision: number }
export interface ApplyBatchRenameRequest {
  sessionId: string;
  previewId: string;
  requestId: string;
  source: OperationIntent["source"];
  panelId: string;
  tabId: string;
}
export interface RenameFunctionInfo {
  name: string;
  aliases: string[];
  parameters: Array<{ name: string; role: string; optional: boolean }>;
  description: string;
  examples: Array<{ expression: string; result: string }>;
}
