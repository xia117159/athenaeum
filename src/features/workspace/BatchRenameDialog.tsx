import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, X, CircleAlert } from "lucide-react";
import { canConfirmBatchRename, type BatchRenameDialogState } from "./batchRenameState";
import type { BatchRenameRow } from "../../app/batchRename";
import { RenameExpressionInput } from "./RenameExpressionInput";
import { BatchRenamePreviewList } from "./BatchRenamePreviewList";
import { batchRenameResultRows } from "./batchRenameRows";
import { describeRenameDiagnostic } from "./batchRenameDiagnostic";
import "./batch-rename.css";

export interface BatchRenameDialogProps {
  dialog: BatchRenameDialogState;
  onChange(id: string, value: string): void;
  onConfirm(id: string): void;
  onClose(id: string): void;
  onHelp(): void;
}
export function BatchRenameDialog({ dialog, onChange, onConfirm, onClose, onHelp }: BatchRenameDialogProps) {
  const surface = useRef<HTMLFormElement>(null), input = useRef<HTMLInputElement>(null), composing = useRef(false);
  const [inspected, setInspected] = useState<string>();
  const editing = dialog.phase === "editing" || dialog.phase === "previewing";
  const running = ["submitting", "running", "cancelling"].includes(dialog.phase);
  const finished = dialog.phase === "finished" || dialog.phase === "error";
  const initialItems = useMemo((): BatchRenameRow[] => dialog.target.entries.map(entry => ({ id: entry.id,
    sourcePath: entry.path, parentPath: entry.parentPath, oldName: entry.name, newName: null, targetPath: null,
    isDirectory: entry.kind === "folder", status: "unchanged", diagnostic: null })), [dialog.target]);
  const sourceItems = dialog.preview?.items ?? dialog.session?.items ?? initialItems;
  const items = useMemo(() => batchRenameResultRows(sourceItems, dialog.task), [sourceItems, dialog.task]);
  const invalid = items.filter(item => item.status === "error");
  const selectedError = items.find(item => item.id === inspected && item.diagnostic) ?? invalid[0];
  const globalDiagnostic = dialog.preview?.diagnostics[0];
  const rowDiagnostic = selectedError?.diagnostic;
  const rowHasRange = Boolean(rowDiagnostic && (rowDiagnostic.start > 0 || rowDiagnostic.end > 0));
  const expressionInvalid = Boolean(globalDiagnostic || rowHasRange);
  const error = dialog.error ?? (globalDiagnostic ? describeRenameDiagnostic(dialog.expression, globalDiagnostic) : undefined)
    ?? (rowDiagnostic ? `${selectedError!.oldName}：${describeRenameDiagnostic(dialog.expression, rowDiagnostic, rowHasRange)}` : undefined);
  const message = dialog.error ?? (dialog.phase === "cancelling" ? "正在取消并恢复名称，请稍候…"
    : dialog.phase === "loading" ? "正在读取项目和文件日期…"
    : dialog.phase === "previewing" ? "正在预览…"
    : dialog.phase === "submitting" ? "正在准备重命名…"
    : running || dialog.phase === "finished" ? dialog.task?.message
    : error ?? (dialog.preview?.changedCount ? `将重命名 ${dialog.preview.changedCount} 个项目` : "输入表达式以生成新名称"));

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (input.current && !input.current.disabled) { input.current.focus(); input.current.select(); }
    else surface.current?.focus();
    const overlay = surface.current?.parentElement;
    const siblings = Array.from(document.body.children).filter(child => child !== overlay) as HTMLElement[];
    const previousInert = siblings.map(element => element.inert);
    siblings.forEach(element => { element.inert = true; });
    return () => {
      siblings.forEach((element, index) => { element.inert = previousInert[index]; });
      const listing = document.querySelector<HTMLElement>(`.file-listing__scroll[data-panel-id="${dialog.target.panelId}"]`);
      (listing ?? previous)?.focus({ preventScroll: true });
    };
  }, [dialog.id, dialog.target.panelId]);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!surface.current?.contains(focused) || focused?.matches(":disabled")) surface.current?.focus();
    if (editing && document.activeElement === surface.current) { input.current?.focus(); input.current?.select(); }
  }, [editing, dialog.phase]);

  return createPortal(<div className="batch-rename-overlay" onContextMenu={event => event.preventDefault()}>
    <form ref={surface} className="batch-rename" role="dialog" aria-modal="true" aria-label="批量重命名" tabIndex={-1}
      onSubmit={event => { event.preventDefault(); if (!composing.current && canConfirmBatchRename(dialog)) onConfirm(dialog.id); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        event.stopPropagation();
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); onClose(dialog.id); }
        if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault(); if (canConfirmBatchRename(dialog)) onConfirm(dialog.id);
        }
        if (event.key === "Tab") {
          const focusable = Array.from(surface.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex="0"]') ?? []);
          const index = focusable.indexOf(document.activeElement as HTMLElement);
          if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === focusable.length - 1)) {
            event.preventDefault(); (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
          }
        }
      }}>
      <header className="batch-rename__header"><strong>批量重命名</strong><span>{items.length} 个项目</span>
        <button type="button" className="batch-rename__close" aria-label="关闭批量重命名" title={running ? "取消重命名" : "关闭"}
          disabled={dialog.phase === "cancelling"} onClick={() => onClose(dialog.id)}><X size={16} /></button>
      </header>
      <div className="batch-rename__expression-area">
        <label className="batch-rename__expression-label">重命名表达式</label>
        <div className="batch-rename__expression-line">
          <RenameExpressionInput value={dialog.expression} history={dialog.history} disabled={!editing} inputRef={input} invalid={expressionInvalid}
            onChange={value => onChange(dialog.id, value)} />
          <button type="button" className="batch-rename__button" data-action="rename-help" onClick={onHelp}><CircleHelp size={15} />帮助</button>
        </div>
        <div className="batch-rename__hint" id="batch-rename-rules"><code>*</code> 原基本名　<code>?</code> 原扩展名　<code>{"<#001>"}</code> 序号　默认保留扩展名</div>
      </div>
      <BatchRenamePreviewList items={items} onInspect={setInspected} completed={dialog.phase === "finished"} />
      <div id="batch-rename-error" className={`batch-rename__message${error || (finished && dialog.task?.status !== "succeeded") ? " is-error" : ""}`} role="status" aria-live="polite">
        {error ? <CircleAlert size={15} aria-hidden="true" /> : null}
        <span>{message}{invalid.length > 1 ? `（${invalid.length} 项无效）` : ""}
          {dialog.phase === "finished" && dialog.task?.undoable ? " 可在操作历史中恢复名称。" : ""}</span>
      </div>
      {running ? <progress className="batch-rename__progress" aria-label="批量重命名进度"
        value={dialog.task?.completedEntries ?? 0} max={Math.max(1, dialog.task?.totalEntries ?? items.length)} /> : null}
      <footer className="batch-rename__footer">
        <span>{finished ? (dialog.task ? "实际结果可在操作历史中查看" : "关闭窗口后可重试") : "整批操作可通过 Ctrl+Z 撤销"}</span>
        <button type="submit" className="batch-rename__button batch-rename__button--primary" data-action="confirm-rename"
          disabled={!canConfirmBatchRename(dialog)}>确认</button>
        <button type="button" className="batch-rename__button" data-action="cancel-rename" disabled={dialog.phase === "cancelling"}
          onClick={() => onClose(dialog.id)}>{finished ? "关闭" : dialog.phase === "cancelling" ? "正在取消" : "取消"}</button>
      </footer>
    </form>
  </div>, document.body);
}
