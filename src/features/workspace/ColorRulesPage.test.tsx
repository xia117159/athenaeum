import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useState, type Dispatch, type SetStateAction } from "react";
import { ColorRulesPage } from "./ColorRulesPage";
import { installLegacyInputEventPatch, patchLegacyInputEventTarget } from "./testDom";
import type { ColorFilterRule, ColorFilterValidationResult } from "./colorFilterTypes";

const { JSDOM } = require("jsdom") as { JSDOM: new (html?: string, options?: { url?: string }) => { window: Window & typeof globalThis } };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rule(id: string, name: string, priority: number): ColorFilterRule {
  return {
    id,
    name,
    enabled: true,
    target: "any",
    expression: "*.txt",
    caseSensitive: false,
    foregroundColorHex: "#112233",
    backgroundColorHex: "#ffffff",
    priority,
    migrationDiagnostic: null
  };
}

function flushDebounce() {
  return new Promise((resolve) => setTimeout(resolve, 350));
}

export const completion = (async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost" });
  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  installLegacyInputEventPatch(dom);
  Object.defineProperty(globalThis, "self", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const React = require("react") as typeof import("react");
  const { act } = React;
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const container = document.getElementById("root")!;
  const root = ReactDOM.createRoot(container);
  const setInputValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  const click = (element: Element) => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const dblclick = (element: Element) => element.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const keyDown = (element: Element, key: string) =>
    element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const focusOut = (element: Element) => element.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));

  let latestRules: ColorFilterRule[] = [];
  let latestValid = true;
  let latestDraftDirty = false;
  let validationOverride: ((expression: string) => Promise<ColorFilterValidationResult>) | undefined;
  const validateRule = async (expression: string) => {
    if (validationOverride) return validationOverride(expression);
    return expression === "bad" || expression === ""
      ? {
          valid: false,
          message: expression === "" ? "Expression is required" : "Invalid expression",
          span: { start: 0, end: Math.max(expression.length, 1) }
        }
      : { valid: true, message: null, span: null };
  };
  const handleValidationChange = (valid: boolean) => {
    latestValid = valid;
    if (!valid) validationInvalidReasons.push(latestRules.map((item) => `${item.id}:${item.enabled}:${item.expression}`).join("|"));
  };
  const validationInvalidReasons: string[] = [];
  let setHarnessRules: Dispatch<SetStateAction<ColorFilterRule[]>> = () => undefined;
  let setResetToken: Dispatch<SetStateAction<number>> = () => undefined;
  let setConflict: Dispatch<SetStateAction<boolean>> = () => undefined;

  function Harness() {
    const [rules, setRules] = useState([rule("one", "One", 1), rule("two", "Two", 2)]);
    const [resetToken, updateResetToken] = useState(0);
    const [conflict, updateConflict] = useState(false);
    setHarnessRules = setRules;
    setResetToken = updateResetToken;
    setConflict = updateConflict;
    latestRules = rules;
    return React.createElement(ColorRulesPage, {
      colorRules: rules,
      disabled: false,
      conflict,
      onChange: setRules,
      onHelp: () => undefined,
      onValidationChange: handleValidationChange,
      onDraftDirtyChange: (dirty: boolean) => {
        latestDraftDirty = dirty;
      },
      resetToken,
      validateRule
    });
  }

  const queryRow = (index: number) =>
    container.querySelectorAll<HTMLLIElement>(".color-rules-list-row")[index];
  const querySelectedRow = () =>
    container.querySelector<HTMLLIElement>(".color-rules-list-row.is-selected");
  const queryEditInput = () =>
    container.querySelector<HTMLInputElement>(".color-rules-expression-input");
  const queryOperationButton = (action: string) =>
    container.querySelector<HTMLButtonElement>(`[data-action='${action}']`);
  const queryColorInput = (label: string) =>
    container.querySelector<HTMLInputElement>(`[aria-label='${label}十六进制值']`);
  const queryClearColor = (label: string) =>
    container.querySelector<HTMLButtonElement>(`[aria-label='清除${label}']`);

  try {
    await act(async () => {
      root.render(React.createElement(Harness));
      await flushDebounce();
    });

    // 1. 两栏布局结构：左侧规则列表（仅启用框 + 表达式），右侧操作面板。
    assert.ok(container.querySelector(".color-rules-content .color-rules-list-wrap"));
    assert.ok(container.querySelector(".color-rules-content .color-rules-operations"));
    assert.equal(container.querySelectorAll("[role='listbox'] .color-rules-list-row").length, 2);
    assert.equal(container.querySelectorAll(".color-rules-list-row__enabled").length, 2);
    assert.equal(container.querySelectorAll(".color-rule-expression-label").length, 2);
    // 名称不再显示或编辑，但模型仍保留稳定的 id/name。
    assert.equal(container.querySelector(".color-rule-name"), null);
    assert.equal(container.querySelector("table"), null);
    assert.equal(latestRules.map((item) => item.name).join(","), "One,Two");
    assert.equal(latestRules.map((item) => item.id).join(","), "one,two");
    // Duplicate/复制 不再出现在 V2 UI。
    assert.equal(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.includes("复制")),
      false
    );
    console.log("ok - color rules editor renders the V2 two-pane layout");

    // 2. 无选中时：除“新建”外右侧操作全部禁用。
    const operations = container.querySelector(".color-rules-operations")!;
    for (const action of ["edit-color-rule", "delete-color-rule", "move-color-rule-up", "move-color-rule-down"]) {
      assert.equal(queryOperationButton(action)!.disabled, true, action);
    }
    assert.equal(queryOperationButton("add-color-rule")!.disabled, false);
    assert.equal(queryColorInput("文字颜色")!.disabled, true);
    assert.equal(queryColorInput("背景颜色")!.disabled, true);
    assert.equal(container.querySelector<HTMLSelectElement>("[aria-label='匹配目标']")!.disabled, true);
    assert.equal(queryOperationButton("color-rule-case-sensitive")!.disabled, true);
    assert.match(operations.textContent ?? "", /请选择一个规则/);
    console.log("ok - right-side operations are disabled without a selection");

    // 3. 选中后：右侧操作启用（首条的上移仍禁用）。
    await act(async () => {
      click(queryRow(0)!);
    });
    assert.equal(querySelectedRow()?.dataset.ruleId, "one");
    assert.equal(queryRow(0)!.getAttribute("aria-selected"), "true");
    assert.equal(queryOperationButton("edit-color-rule")!.disabled, false);
    assert.equal(queryOperationButton("delete-color-rule")!.disabled, false);
    assert.equal(queryOperationButton("move-color-rule-up")!.disabled, true);
    assert.equal(queryOperationButton("move-color-rule-down")!.disabled, false);
    assert.equal(queryColorInput("文字颜色")!.disabled, false);
    assert.equal(queryColorInput("背景颜色")!.disabled, false);
    assert.equal(container.querySelector<HTMLSelectElement>("[aria-label='匹配目标']")!.disabled, false);
    assert.equal(queryOperationButton("color-rule-case-sensitive")!.disabled, false);
    console.log("ok - selecting a rule enables the selected-rule operations");

    // 5. 编辑按钮让选中规则的表达式变成输入框，内容为当前表达式。
    await act(async () => {
      click(queryOperationButton("edit-color-rule")!);
    });
    const editInput = queryEditInput()!;
    assert.ok(editInput);
    assert.equal(editInput.value, "*.txt");
    assert.equal(editInput.closest("[data-rule-id]")?.getAttribute("data-rule-id"), "one");
    console.log("ok - the Edit command turns the selected expression into an input");

    // 9. Escape 取消并恢复原表达式。
    await act(async () => {
      patchLegacyInputEventTarget(editInput);
      setInputValue.call(editInput, "junk-*");
      editInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      keyDown(editInput, "Escape");
    });
    assert.equal(queryEditInput(), null);
    assert.equal(latestRules[0].expression, "*.txt");
    assert.equal(queryRow(0)!.querySelector(".color-rule-expression-label")?.textContent, "*.txt");
    console.log("ok - Escape cancels the draft and restores the previous expression");

    // 6. 双击表达式进入输入框编辑模式。
    await act(async () => {
      dblclick(queryRow(1)!.querySelector(".color-rule-expression-label")!);
    });
    const secondEditInput = queryEditInput()!;
    assert.ok(secondEditInput);
    assert.equal(secondEditInput.value, "*.txt");
    assert.equal(secondEditInput.closest("[data-rule-id]")?.getAttribute("data-rule-id"), "two");
    console.log("ok - double-clicking an expression enters inline editing");

    // 10. 表达式输入框白底黑字（类契约 + CSS 白底黑字声明）。
    assert.equal(queryEditInput()!.classList.contains("color-rules-expression-input"), true);
    const colorRulesCss = fs.readFileSync(
      path.join(process.cwd(), "src/features/workspace/color-rules.css"),
      "utf8"
    );
    assert.match(colorRulesCss, /\.color-rules-expression-input\s*\{[^}]*background:\s*#ffffff;/);
    assert.match(colorRulesCss, /\.color-rules-expression-input\s*\{[^}]*color:\s*#000000;/);
    console.log("ok - expression editing input keeps the white-background black-text contract");

    // 10b. 右栏固定 240px，命令按钮分组竖排：96px 定宽靠左，内容居中。
    assert.match(colorRulesCss, /\.color-rules-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.2fr\)\s*240px/);
    const commandsBlock = colorRulesCss.match(/\.color-rules-operations__commands\s*\{[^}]*\}/)![0];
    assert.match(commandsBlock, /flex-direction:\s*column/);
    assert.doesNotMatch(commandsBlock, /flex-wrap:\s*wrap/);
    assert.match(colorRulesCss, /\.color-rules-operations__commands--secondary\s*\{[^}]*margin-top:\s*\d+px/);
    const commandButtonBlock = colorRulesCss.match(/\.color-rules-operations__commands > \.toolbar-button\s*\{[^}]*\}/)![0];
    assert.match(commandButtonBlock, /width:\s*96px/);
    assert.doesNotMatch(commandButtonBlock, /width:\s*100%/);
    assert.doesNotMatch(commandButtonBlock, /justify-content:\s*flex-start/);
    // 颜色行：触发钮 30px 定宽，十六进制输入占满剩余空间。
    const colorControlBlock = colorRulesCss.match(/\.color-rule-color-control\s*\{[^}]*\}/)![0];
    assert.match(colorControlBlock, /grid-template-columns:\s*30px minmax\(0,\s*1fr\) 26px/);
    const swatchBlock = colorRulesCss.match(/\.color-rule-swatch\s*\{[^}]*\}/)![0];
    assert.match(swatchBlock, /width:\s*30px/);
    assert.doesNotMatch(swatchBlock, /width:\s*100%/);
    console.log("ok - right operations pane is a fixed 240px column with 96px centered-content command buttons");

    // 9b. 键盘提交后焦点回到表达式行。
    await act(async () => {
      keyDown(secondEditInput, "Escape");
    });

    // 8. Enter 提交并把焦点返回表达式行。
    await act(async () => {
      click(queryRow(0)!);
    });
    await act(async () => {
      click(queryOperationButton("edit-color-rule")!);
    });
    const enterInput = queryEditInput()!;
    await act(async () => {
      patchLegacyInputEventTarget(enterInput);
      setInputValue.call(enterInput, "*.md");
      enterInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      keyDown(enterInput, "Enter");
    });
    assert.equal(queryEditInput(), null);
    assert.equal(latestRules[0].expression, "*.md");
    assert.equal((document.activeElement as HTMLElement | null)?.getAttribute?.("data-rule-id"), "one");
    console.log("ok - Enter commits the draft and returns focus to the expression row");

    // 7. 点击输入框外（blur）提交并恢复普通文本。
    await act(async () => {
      click(queryOperationButton("edit-color-rule")!);
    });
    const blurInput = queryEditInput()!;
    await act(async () => {
      patchLegacyInputEventTarget(blurInput);
      setInputValue.call(blurInput, "*.log");
      blurInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      focusOut(blurInput);
    });
    assert.equal(queryEditInput(), null);
    assert.equal(latestRules[0].expression, "*.log");
    assert.equal(queryRow(0)!.querySelector(".color-rule-expression-label")?.textContent, "*.log");
    console.log("ok - blur commits the draft and restores ordinary text");

    // 表达式限制按 Unicode scalar 计数（不按 UTF-16 单元）。
    await act(async () => {
      click(queryOperationButton("edit-color-rule")!);
    });
    const limitInput = queryEditInput()!;
    await act(async () => {
      patchLegacyInputEventTarget(limitInput);
      setInputValue.call(limitInput, "\u{1F642}".repeat(1100));
      limitInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      keyDown(limitInput, "Enter");
    });
    assert.equal(Array.from(latestRules[0].expression).length, 1024);
    console.log("ok - expression editing counts Unicode scalar values instead of UTF-16 units");
    await act(async () => {
      setHarnessRules((current) => current.map((item) => ({ ...item, expression: "*.txt" })));
      await flushDebounce();
    });

    // 11. 字体色/背景色选择和清除；清除第二个颜色后规则自动禁用。
    await act(async () => {
      click(queryRow(0)!);
      const foregroundInput = queryColorInput("文字颜色")!;
      patchLegacyInputEventTarget(foregroundInput);
      setInputValue.call(foregroundInput, "#aabbcc");
      foregroundInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(latestRules[0].foregroundColorHex, "#aabbcc");
    await act(async () => {
      click(queryClearColor("文字颜色")!);
    });
    assert.equal(latestRules[0].foregroundColorHex, null);
    assert.equal(latestRules[0].enabled, true);
    await act(async () => {
      const backgroundInput = queryColorInput("背景颜色")!;
      patchLegacyInputEventTarget(backgroundInput);
      setInputValue.call(backgroundInput, "#336699");
      backgroundInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(latestRules[0].backgroundColorHex, "#336699");
    await act(async () => {
      click(queryClearColor("背景颜色")!);
    });
    assert.equal(latestRules[0].backgroundColorHex, null);
    assert.equal(latestRules[0].enabled, false);
    assert.equal(queryRow(0)!.querySelector<HTMLInputElement>(".color-rules-list-row__enabled")!.disabled, true);
    console.log("ok - color selection and clear preserve the no-color auto-disable behavior");

    // 12. 目标下拉框。
    await act(async () => {
      setHarnessRules(() => [rule("one", "One", 1), rule("two", "Two", 2)]);
      await flushDebounce();
    });
    await act(async () => {
      click(queryRow(0)!);
      const targetSelect = container.querySelector<HTMLSelectElement>("[aria-label='匹配目标']")!;
      patchLegacyInputEventTarget(targetSelect);
      targetSelect.value = "file";
      targetSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(latestRules[0].target, "file");
    assert.deepEqual(
      Array.from(container.querySelectorAll("[aria-label='匹配目标'] option")).map((option) => option.textContent),
      ["文件和文件夹", "文件", "文件夹"]
    );
    console.log("ok - the target select offers 文件和文件夹/文件/文件夹");

    // 13. caseSensitive 逐规则开关。
    await act(async () => {
      click(queryOperationButton("color-rule-case-sensitive")!);
    });
    assert.equal(latestRules[0].caseSensitive, true);
    // 17. caseSensitive 通过替换输入（Apply 路径）持久化。
    assert.equal(latestRules[0].enabled, true);
    await act(async () => {
      click(queryOperationButton("color-rule-case-sensitive")!);
    });
    assert.equal(latestRules[0].caseSensitive, false);
    console.log("ok - the selected-rule caseSensitive toggle updates the draft rule");

    // 14. 删除首条、中间、末条后的确定性选中。
    let confirmCalls = 0;
    dom.window.confirm = () => {
      confirmCalls += 1;
      return true;
    };
    await act(async () => {
      setHarnessRules(() => [rule("one", "One", 1), rule("two", "Two", 2), rule("three", "Three", 3)]);
      await flushDebounce();
    });
    await act(async () => {
      click(queryRow(1)!);
    });
    await act(async () => {
      click(queryOperationButton("delete-color-rule")!);
    });
    assert.equal(confirmCalls, 1);
    assert.equal(latestRules.map((item) => item.id).join(","), "one,three");
    assert.equal(querySelectedRow()?.dataset.ruleId, "three");
    console.log("ok - deleting a middle rule selects the rule now at that index");

    await act(async () => {
      click(queryOperationButton("delete-color-rule")!);
    });
    assert.equal(latestRules.map((item) => item.id).join(","), "one");
    assert.equal(querySelectedRow()?.dataset.ruleId, "one");
    console.log("ok - deleting the last rule selects the previous rule");

    await act(async () => {
      click(queryOperationButton("delete-color-rule")!);
    });
    assert.equal(latestRules.length, 0);
    assert.equal(querySelectedRow(), null);
    assert.ok(container.querySelector(".color-rules-empty"));
    console.log("ok - deleting the only rule clears the selection");

    // 未触碰的新建规则删除无需确认；已存在规则需要确认。
    await act(async () => {
      setHarnessRules(() => [rule("one", "One", 1)]);
      await flushDebounce();
    });
    await act(async () => {
      click(queryOperationButton("add-color-rule")!);
    });
    assert.equal(latestRules.length, 2);
    confirmCalls = 0;
    await act(async () => {
      click(queryOperationButton("delete-color-rule")!);
    });
    assert.equal(confirmCalls, 0);
    assert.equal(latestRules.length, 1);
    await act(async () => {
      click(queryOperationButton("delete-color-rule")!);
    });
    assert.equal(confirmCalls, 1);
    assert.equal(latestRules.length, 0);
    console.log("ok - untouched new rules delete directly while persisted rules require confirmation");

    // 4. 新建自动选中新规则、进入表达式编辑并聚焦输入框。
    await act(async () => {
      setHarnessRules(() => [rule("one", "One", 1)]);
      await flushDebounce();
    });
    await act(async () => {
      click(queryOperationButton("add-color-rule")!);
    });
    assert.equal(latestRules.length, 2);
    const added = latestRules[1];
    assert.equal(querySelectedRow()?.dataset.ruleId, added.id);
    const newInput = queryEditInput()!;
    assert.ok(newInput);
    assert.equal(newInput.value, "");
    assert.equal(newInput.closest("[data-rule-id]")?.getAttribute("data-rule-id"), added.id);
    assert.equal(document.activeElement, newInput);
    console.log("ok - New selects the new rule and focuses its expression input");
    await act(async () => {
      keyDown(newInput, "Escape");
      setHarnessRules((current) => current.slice(0, 1));
      await flushDebounce();
    });

    // 上移/下移沿用优先级归一化。
    await act(async () => {
      setHarnessRules(() => [rule("one", "One", 1), rule("two", "Two", 2), rule("three", "Three", 3)]);
      await flushDebounce();
    });
    await act(async () => {
      click(queryRow(1)!);
    });
    await act(async () => {
      click(queryOperationButton("move-color-rule-down")!);
    });
    assert.deepEqual(latestRules.map((item) => item.id), ["one", "three", "two"]);
    assert.deepEqual(latestRules.map((item) => item.priority), [1, 2, 3]);
    await act(async () => {
      click(queryRow(2)!);
    });
    await act(async () => {
      click(queryOperationButton("move-color-rule-up")!);
    });
    assert.deepEqual(latestRules.map((item) => item.id), ["one", "two", "three"]);
    console.log("ok - move commands keep stable order and normalized priorities");

    // 16. 迁移诊断在行内可见（隐藏名称修复边界由迁移保证）。
    await act(async () => {
      setHarnessRules((current) => current.map((item, index) => index === 0
        ? { ...item, migrationDiagnostic: "Color rule count exceeds 256" }
        : item));
      await flushDebounce();
    });
    assert.match(queryRow(0)!.querySelector(".color-rule-diagnostic")?.textContent ?? "", /exceeds 256/);
    await act(async () => {
      setHarnessRules((current) => current.map((item, index) => index === 0
        ? { ...item, migrationDiagnostic: null }
        : item));
      await flushDebounce();
    });
    console.log("ok - migration diagnostics stay visible inline without a name column");

    // 15. 255 -> 256 -> 删除后的规则数量边界。
    const bulk = Array.from({ length: 255 }, (_, index) => rule(`bulk-${index + 1}`, `Rule ${index + 1}`, index + 1));
    await act(async () => {
      setHarnessRules(bulk);
      await flushDebounce();
    });
    assert.equal(queryOperationButton("add-color-rule")!.disabled, false);
    await act(async () => {
      click(queryOperationButton("add-color-rule")!);
    });
    assert.equal(latestRules.length, 256);
    const addButton = queryOperationButton("add-color-rule")!;
    assert.equal(addButton.disabled, true);
    const status = container.querySelector<HTMLElement>(".color-rules-operations__status")!;
    assert.match(status.textContent ?? "", /上限/);
    assert.equal(addButton.getAttribute("aria-describedby"), status.id);
    await act(async () => {
      click(queryRow(0)!);
    });
    await act(async () => {
      click(queryOperationButton("delete-color-rule")!);
    });
    assert.equal(latestRules.length, 255);
    assert.equal(queryOperationButton("add-color-rule")!.disabled, false);
    console.log("ok - the 256-rule limit disables New with an accessible reason and recovers after delete");

    // 校验失败可访问且可重试。
    validationOverride = async () => {
      throw new Error("transport unavailable");
    };
    await act(async () => {
      setHarnessRules(() => [rule("one", "One", 1)]);
    });
    await act(async () => {
      await flushDebounce();
    });
    const validationError = container.querySelector<HTMLElement>(".color-rules-validation-error")!;
    assert.equal(validationError.getAttribute("role"), "alert");
    assert.match(validationError.textContent ?? "", /规则验证失败，请重试/);
    assert.equal(latestValid, false);
    validationOverride = undefined;
    const retryValidation = validationError.querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      retryValidation.click();
      await flushDebounce();
    });
    assert.equal(container.querySelector(".color-rules-validation-error"), null);
    assert.equal(latestValid, true);
    console.log("ok - active validation failure is accessible and retryable");

    // 过期验证拒绝不能覆盖更新的成功运行。
    const staleValidation = deferred<Awaited<ReturnType<typeof validateRule>>>();
    validationOverride = (value) => value === "slow-fail"
      ? staleValidation.promise
      : Promise.resolve({ valid: true, message: null, span: null });
    await act(async () => {
      setHarnessRules((current) => current.map((item) => ({ ...item, expression: "slow-fail" })));
    });
    await act(async () => {
      await flushDebounce();
    });
    await act(async () => {
      setHarnessRules((current) => current.map((item) => ({ ...item, expression: "recovered" })));
    });
    await act(async () => {
      await flushDebounce();
    });
    staleValidation.reject(new Error("stale transport failure"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(container.querySelector(".color-rules-validation-error"), null);
    assert.equal(latestValid, true);
    validationOverride = undefined;
    console.log("ok - stale validation rejection cannot overwrite a newer successful run");

    // 无效颜色草稿保持可见并阻塞 Apply；权威重置丢弃草稿。
    await act(async () => {
      click(queryRow(0)!);
    });
    await act(async () => {
      const foregroundInput = queryColorInput("文字颜色")!;
      patchLegacyInputEventTarget(foregroundInput);
      setInputValue.call(foregroundInput, "#a");
      foregroundInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flushDebounce();
    });
    const foregroundInput = queryColorInput("文字颜色")!;
    assert.equal(foregroundInput.value, "#a");
    assert.equal(foregroundInput.getAttribute("aria-invalid"), "true");
    assert.equal(latestValid, false);
    assert.equal(latestDraftDirty, true);
    assert.match(container.querySelector(".color-rule-color-diagnostic")?.textContent ?? "", /#RRGGBB/);
    await act(async () => {
      setConflict(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(container.querySelector(".color-rules-conflict"));
    await act(async () => {
      setResetToken((current) => current + 1);
      setConflict(false);
    });
    await act(async () => {
      await flushDebounce();
    });
    assert.equal(queryColorInput("文字颜色")!.value, "#112233");
    assert.equal(latestValid, true);
    assert.equal(latestDraftDirty, false);
    console.log("ok - an authoritative reset discards invalid color drafts");

    // 权威重置同时关闭表达式编辑态与打开的选色器（规格：重置收尾关闭编辑与弹层）。
    await act(async () => {
      click(queryRow(0)!);
    });
    await act(async () => {
      keyDown(queryRow(0)!, "Enter");
    });
    const editInputForReset = queryEditInput()!;
    assert.ok(editInputForReset, "expression edit input opens");
    // 输入与当前表达式不同的草稿，验证重置后草稿不会经 blur 提交覆盖重载快照。
    const differingDraft = `${latestRules[0].expression}-stale`;
    await act(async () => {
      setInputValue.call(editInputForReset, differingDraft);
      editInputForReset.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const swatchForReset = container.querySelector<HTMLButtonElement>(".color-rule-swatch[aria-label^='文字颜色']")!;
    await act(async () => {
      click(swatchForReset);
    });
    const pickerForReset = document.querySelector(".color-rule-picker");
    assert.ok(pickerForReset, "color picker popover opens");
    // 弹层渲染在 body 顶层（Portal），不在右栏滚动容器内，避免撑出滚动条。
    assert.equal(pickerForReset!.parentElement, document.body, "picker popover is portaled to document.body");
    assert.ok(pickerForReset!.classList.contains("color-rule-picker--anchored"), "picker popover uses fixed anchor positioning");
    assert.ok(!(swatchForReset.closest(".color-rules-operations") as HTMLElement | null)?.contains(pickerForReset!), "picker popover must not live inside the scrolling operations pane");
    await act(async () => {
      setResetToken((current) => current + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(queryEditInput(), null, "edit mode closes on authoritative reset");
    assert.equal(document.querySelector(".color-rule-picker"), null, "color popover closes on authoritative reset");
    // 重置后遗留草稿不得经 blur 提交覆盖重载快照（该规则当前表达式为前面场景设置的 recovered）。
    assert.equal(latestRules[0].expression, "recovered");
    assert.notEqual(latestRules[0].expression, differingDraft);
    console.log("ok - an authoritative reset closes expression editing and the color popover");

    // 选色器交互：色块打开弹层、点击外部关闭、Escape 关闭。
    await act(async () => {
      click(swatchForReset);
    });
    assert.ok(document.querySelector(".color-rule-picker"), "popover reopens after reset");
    await act(async () => {
      document.body.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector(".color-rule-picker"), null, "outside mousedown closes the popover");
    await act(async () => {
      click(swatchForReset);
    });
    assert.ok(document.querySelector(".color-rule-picker"), "popover reopens for escape test");
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector(".color-rule-picker"), null, "Escape closes the popover");
    console.log("ok - the color picker popover closes on outside mousedown and Escape");

    // 弹层互斥：打开背景颜色弹层会关闭文字颜色弹层。
    const foregroundSwatch = container.querySelector<HTMLButtonElement>(".color-rule-swatch[aria-label^='文字颜色']")!;
    const backgroundSwatch = container.querySelector<HTMLButtonElement>(".color-rule-swatch[aria-label^='背景颜色']")!;
    await act(async () => {
      click(foregroundSwatch);
    });
    assert.ok(document.querySelector(".color-rule-picker"), "foreground popover opens");
    await act(async () => {
      click(backgroundSwatch);
    });
    const openPickerLabels = Array.from(container.querySelectorAll(".color-rule-color-control.is-open [aria-haspopup='dialog']"))
      .map((button) => button.getAttribute("aria-label") ?? "");
    assert.equal(openPickerLabels.length, 1, "only one color popover is open");
    assert.match(openPickerLabels[0], /^背景颜色/);
    console.log("ok - opening the background color popover closes the foreground one");

    // F2 进入表达式编辑（与 Enter 等价的快捷入口）。
    await act(async () => {
      keyDown(queryRow(0)!, "F2");
    });
    assert.ok(queryEditInput(), "F2 opens the expression edit input");
    assert.equal(document.activeElement, queryEditInput(), "F2 focuses the expression edit input");
    await act(async () => {
      keyDown(queryEditInput()!, "Escape");
    });
    assert.equal(queryEditInput(), null);
    console.log("ok - F2 enters expression editing with focus");

    // 帮助入口保留在命令栏；匹配指引仍只在帮助窗口。
    assert.ok(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("帮助")));
    assert.equal(container.textContent?.includes("从上到下匹配，首条符合条件的规则生效。"), false);
    console.log("ok - matching guidance remains in the dedicated Help window");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
  }
})();
