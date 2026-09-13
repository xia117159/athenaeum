import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { BatchRenameDialog } from "./BatchRenameDialog";
import { canConfirmBatchRename, type BatchRenameDialogState } from "./batchRenameState";
import { installDomEnvironment, flushEffects } from "./workspaceControllerTestHarness";
import type { BatchRenameRow } from "../../app/batchRename";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const items: BatchRenameRow[] = Array.from({ length: 500 }, (_, index) => ({ id: String(index), sourcePath: `C:\\Test${index + 1}.txt`,
    parentPath: "C:\\", oldName: `Test${index + 1}.txt`, newName: index === 0 ? "NEW_2026-09-12.txt" : `Test${index + 1}-001.txt`,
    targetPath: `C:\\New${index}.txt`, isDirectory: false, status: "changed", diagnostic: null }));
  const initial: BatchRenameDialogState = { id: "open", target: { panelId: "panel-1", tabId: "tab", rootPath: "C:\\files", selectionRevision: 0, source: "shortcut", entries: [] },
    expression: "New-*", revision: 2, phase: "editing", history: ["*-<#001>", "<toupper *>"],
    session: { sessionId: "s", frozenAt: "2026-09-12T12:00:00+08:00", items },
    preview: { sessionId: "s", expression: "New-*", revision: 2, previewId: "p", items, diagnostics: [], changedCount: 500, canApply: true } };
  const listing = document.createElement("div"); listing.className = "file-listing__scroll";
  listing.dataset.panelId = "panel-1"; listing.tabIndex = 0; document.body.append(listing); listing.focus();
  let change!: React.Dispatch<React.SetStateAction<BatchRenameDialogState | undefined>>;
  let current: BatchRenameDialogState | undefined; let confirmations = 0, helps = 0, closes = 0;
  const changes: string[] = [];
  function Harness() {
    const [dialog, set] = useState<BatchRenameDialogState | undefined>(initial); change = set; current = dialog;
    return dialog ? <BatchRenameDialog dialog={dialog}
      onChange={(_id, value) => { changes.push(value); set(old => ({ ...old!, expression: value, revision: old!.revision + 1, preview: undefined, phase: "previewing" })); }}
      onConfirm={() => { if (canConfirmBatchRename(dialog)) confirmations++; }}
      onClose={() => { closes++; set(undefined); }} onHelp={() => { helps++; }} /> : null;
  }
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const surface = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="批量重命名"]')!;
  const key = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) => tick(() => target.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));
  const confirm = () => document.querySelector<HTMLButtonElement>('[data-action="confirm-rename"]')!;
  try {
    await tick(() => root.render(<Harness />));
    assert.ok(surface(), "the production batch dialog must be rendered");
    assert.equal(document.activeElement, input());
    assert.equal(confirm().disabled, false);
    assert.equal(document.querySelector('[role="grid"]')?.getAttribute("aria-rowcount"), "501");
    assert.ok(document.querySelectorAll(".batch-rename__row").length < 50, "only visible preview rows are mounted");
    assert.equal(document.querySelector(".batch-rename__new-name mark")?.textContent, "NEW_2026-09-12");
    assert.equal(document.querySelectorAll(".batch-rename__new-name")[1].querySelector("mark")?.textContent, "-001");
    await key(input(), "Enter", { isComposing: true }); assert.equal(confirmations, 0);
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    await tick(() => input().dispatchEvent(undo)); assert.equal(undo.defaultPrevented, false, "Ctrl+Z remains text undo");
    await key(input(), "ArrowDown"); assert.equal(input().getAttribute("aria-expanded"), "true");
    await key(input(), "ArrowDown"); await key(input(), "Enter");
    assert.equal(changes.at(-1), "<toupper *>"); assert.equal(confirmations, 0);
    assert.equal(confirm().disabled, true, "selecting history invalidates the old preview");
    await tick(() => change(old => ({ ...old!, ...initial, phase: "editing" })));
    await key(input(), "ArrowDown"); await key(input(), "Escape"); assert.ok(surface());
    assert.equal(input().getAttribute("aria-expanded"), "false");
    await tick(() => document.querySelector<HTMLButtonElement>('[data-action="rename-help"]')!.click()); assert.equal(helps, 1);
    const cancel = document.querySelector<HTMLButtonElement>('[data-action="cancel-rename"]')!;
    await tick(() => cancel.focus()); await key(cancel, "Tab");
    assert.ok(surface().contains(document.activeElement), "Tab is trapped in the modal");
    const viewport = document.querySelector<HTMLElement>(".batch-rename__viewport")!;
    await tick(() => { viewport.scrollTop = 499 * 30; viewport.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })); });
    assert.ok(document.querySelector('[data-row-index="499"]'), "all captured rows can be reached by scrolling");
    await tick(() => change(old => ({ ...old!, phase: "cancelling" })));
    assert.equal(input().disabled, true); assert.equal(confirm().disabled, true);
    assert.match(surface().textContent ?? "", /恢复/);
    await tick(() => change(old => ({ ...old!, phase: "editing", error: "目标名称已存在", preview: undefined })));
    assert.equal(confirm().disabled, true); assert.match(surface().textContent ?? "", /目标名称已存在/);
    await key(surface(), "Escape"); assert.equal(closes, 1); assert.equal(current, undefined);
    assert.equal(document.activeElement, listing);
    const loading = { ...initial, id: "loading", phase: "loading" as const, session: undefined, preview: undefined };
    await tick(() => change(loading));
    assert.ok(surface().contains(document.activeElement), "loading a session must focus the dialog while its input is disabled");
    await key(document.activeElement as HTMLElement, "Escape");
    assert.equal(current, undefined, "Escape can dismiss a still-loading session");
    await tick(() => change({ ...loading, id: "failed-create" }));
    await tick(() => change(old => ({ ...old!, phase: "error", error: "无法读取选择的文件" })));
    assert.doesNotMatch(surface().querySelector("footer")?.textContent ?? "", /操作历史/,
      "failure before an operation task exists must not point to a nonexistent history record");
    assert.match(surface().querySelector("footer")?.textContent ?? "", /关闭窗口后可重试/);
    await key(document.activeElement as HTMLElement, "Tab");
    assert.ok(surface().contains(document.activeElement));
    await key(document.activeElement as HTMLElement, "Tab", { shiftKey: true });
    assert.ok(surface().contains(document.activeElement));
    await key(document.activeElement as HTMLElement, "Escape");
    assert.equal(current, undefined, "a failed create remains keyboard dismissible");
    assert.equal(document.activeElement, listing);
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      await tick(() => change({ ...initial, id: `finished-${status}`, phase: "finished", task: {
        taskId: "task", requestId: "request", kind: "rename", label: "批量重命名", status,
        createdAt: "2026-09-12", updatedAt: "2026-09-12", completedEntries: 0, failedEntries: 0,
        affectedRoots: [], entryResults: [], cancelable: false, undoable: false, sequence: 1
      } }));
      assert.match(surface().querySelector("footer")?.textContent ?? "", /实际结果可在操作历史中查看/);
    }
    for (const [expression, start, expected] of [
      ["新<unknown *>", 3, "第 2 个字符"],
      ["😀新<unknown *>", 7, "第 3 个字符"],
      ["<toupper *>😀<substr * bad>", 15, "第 13 个字符"]
    ] as const) {
      await tick(() => change({ ...initial, id: `diagnostic-${start}`, expression,
        preview: { ...initial.preview!, expression, canApply: false, previewId: null,
          diagnostics: [{ message: "请检查函数参数", start, end: new TextEncoder().encode(expression).length }] } }));
      assert.match(document.querySelector(".batch-rename__message")?.textContent ?? "", new RegExp(expected));
      assert.equal(confirm().disabled, true);
      assert.equal(input().getAttribute("aria-invalid"), "true");
    }
    const rowError = { ...items[0], status: "error" as const, diagnostic: { message: "目标已存在", start: 0, end: 0 } };
    await tick(() => change({ ...initial, id: "path-error", preview: { ...initial.preview!, canApply: false,
      previewId: null, items: [rowError] } }));
    assert.doesNotMatch(document.querySelector(".batch-rename__message")?.textContent ?? "", /第 \d+ 个字符/,
      "filesystem errors do not claim to have an expression location");
    await key(surface(), "Escape");
    console.log("ok - production batch modal preview, highlighting, history, IME, focus, errors and long-list access");
  } finally { await tick(() => root.unmount()); listing.remove(); }
})();
