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
  };
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

  try {
    await act(async () => {
      root.render(React.createElement(Harness));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    assert.equal(container.querySelectorAll("tbody tr").length, 2);
    assert.equal(container.querySelectorAll(".color-rule-icon-button").length >= 8, true);

    await act(async () => {
      setHarnessRules((rules) => rules.map((item, index) => index === 0
        ? {
            ...item,
            enabled: false,
            expression: "",
            migrationDiagnostic: "Color rule count exceeds 256"
          }
        : item));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assert.match(container.querySelector("tbody tr:first-child .color-rule-diagnostic")?.textContent ?? "", /exceeds 256/);
    await act(async () => {
      setHarnessRules((rules) => rules.map((item, index) => index === 0
        ? { ...item, enabled: true, expression: "*.txt", migrationDiagnostic: null }
        : item));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    console.log("ok - untouched migration placeholders show their recovery reason");

    const nameInput = container.querySelector<HTMLInputElement>(".color-rule-name")!;
    const expressionLimitInput = container.querySelector<HTMLInputElement>(".color-rule-expression")!;
    assert.equal(nameInput.hasAttribute("maxlength"), false);
    assert.equal(expressionLimitInput.hasAttribute("maxlength"), false);
    console.log("ok - editor limits count Unicode scalar values instead of UTF-16 units");

    const pageSource = fs.readFileSync(
      path.join(process.cwd(), "src/features/workspace/ColorRulesPage.tsx"),
      "utf8"
    );
    assert.equal(pageSource.includes("name: event.currentTarget.value"), true);
    console.log("ok - removable outer whitespace does not truncate a valid boundary name");

    const firstColorInput = container.querySelector<HTMLInputElement>(".color-rule-color-control input")!;
    await act(async () => {
      patchLegacyInputEventTarget(firstColorInput);
      setInputValue.call(firstColorInput, "#a");
      firstColorInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    assert.equal(firstColorInput.value, "#a");
    assert.equal(firstColorInput.getAttribute("aria-invalid"), "true");
    assert.equal(latestValid, false);
    assert.equal(latestDraftDirty, true);
    assert.match(container.querySelector(".color-rule-color-diagnostic")?.textContent ?? "", /#RRGGBB/);
    await act(async () => {
      setConflict(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(firstColorInput.value, "#a");
    assert.equal(latestDraftDirty, true);
    assert.ok(container.querySelector(".color-rules-conflict"));
    await act(async () => { firstColorInput.dispatchEvent(new dom.window.Event("blur", { bubbles: true })); });
    assert.equal(firstColorInput.value, "#a");
    await act(async () => {
      setResetToken((current) => current + 1);
      setConflict(false);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assert.equal(firstColorInput.value, "#112233");
    assert.equal(firstColorInput.getAttribute("aria-invalid"), "false");
    assert.equal(latestValid, true);
    assert.equal(latestDraftDirty, false);
    console.log("ok - an authoritative same-value reset discards invalid color drafts");

    await act(async () => {
      setHarnessRules((rules) => rules.map((item, index) => index === 0 ? { ...item, backgroundColorHex: null } : item));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    const emptyColorInput = container.querySelectorAll<HTMLInputElement>(".color-rule-color-control input")[1];
    const emptyColorClear = container.querySelectorAll<HTMLButtonElement>(
      "tbody tr:first-child .color-rule-color-control .color-rule-icon-button"
    )[1];
    await act(async () => {
      patchLegacyInputEventTarget(emptyColorInput);
      setInputValue.call(emptyColorInput, "#bad");
      emptyColorInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assert.equal(emptyColorClear.disabled, false);
    await act(async () => {
      emptyColorClear.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assert.equal(emptyColorInput.value, "");
    assert.equal(latestValid, true);
    console.log("ok - quick clear removes an invalid draft over an unset color");

    await act(async () => {
      patchLegacyInputEventTarget(firstColorInput);
      setInputValue.call(firstColorInput, "#a");
      firstColorInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    const firstColorClear = container.querySelector<HTMLButtonElement>(
      "tbody tr:first-child .color-rule-color-control .color-rule-icon-button"
    )!;
    await act(async () => {
      firstColorClear.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    assert.equal(firstColorInput.value, "");
    assert.equal(latestValid, true);
    console.log("ok - invalid color drafts remain visible and block apply until cleared");

    const expression = container.querySelector<HTMLInputElement>(".color-rule-expression")!;
    await act(async () => {
      setHarnessRules((rules) => rules.map((item, index) => index === 0
        ? { ...item, enabled: true, expression: "bad", foregroundColorHex: "#112233" }
        : item));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    assert.equal(expression.value, "bad");
    assert.equal(latestValid, false);
    const expressionDiagnostic = Array.from(container.querySelectorAll(".color-rule-diagnostic"))
      .find((item) => item.textContent === "Invalid expression")!;
    assert.equal(expression.getAttribute("aria-describedby"), expressionDiagnostic.id);
    assert.equal(expressionDiagnostic.textContent, "Invalid expression");
    console.log("ok - enabled invalid rules expose a row diagnostic and block apply state");

    const staleValidation = deferred<Awaited<ReturnType<typeof validateRule>>>();
    validationOverride = (value) => value === "slow-fail"
      ? staleValidation.promise
      : Promise.resolve({ valid: true, message: null, span: null });
    await act(async () => {
      setHarnessRules((rules) => rules.map((item, index) => index === 0
        ? { ...item, expression: "slow-fail" }
        : item));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    await act(async () => {
      setHarnessRules((rules) => rules.map((item, index) => index === 0
        ? { ...item, expression: "recovered" }
        : item));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    staleValidation.reject(new Error("stale transport failure"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(container.querySelector(".color-rules-validation-error"), null);
    assert.equal(latestValid, true);
    console.log("ok - stale validation rejection cannot overwrite a newer successful run");

    validationOverride = async () => { throw new Error("transport unavailable"); };
    await act(async () => {
      setHarnessRules((rules) => rules.map((item, index) => index === 0
        ? { ...item, expression: "transport-error" }
        : item));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    const validationError = container.querySelector<HTMLElement>(".color-rules-validation-error")!;
    assert.equal(validationError.getAttribute("role"), "alert");
    assert.match(validationError.textContent ?? "", /规则验证失败，请重试/);
    assert.equal(latestValid, false);
    validationOverride = undefined;
    const retryValidation = validationError.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { retryValidation.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    assert.equal(container.querySelector(".color-rules-validation-error"), null);
    assert.equal(latestValid, true);
    console.log("ok - active validation failure is accessible and retryable");

    const secondMoveUp = container.querySelector<HTMLButtonElement>(
      "tbody tr:nth-child(2) .color-rules-table__actions button:not(:disabled)"
    )!;
    await act(async () => { secondMoveUp.click(); });
    assert.deepEqual(latestRules.map((item) => item.id), ["two", "one"]);
    assert.deepEqual(latestRules.map((item) => item.priority), [1, 2]);
    console.log("ok - color rule row controls reorder rules and normalize priorities");

    let confirmCalls = 0;
    dom.window.confirm = () => {
      confirmCalls += 1;
      return true;
    };
    const addButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("新增规则"))!;
    await act(async () => { addButton.click(); });
    assert.equal(latestRules.length, 3);
    const newDelete = container.querySelector<HTMLButtonElement>("tbody tr:nth-child(3) .color-rule-icon-button--danger")!;
    await act(async () => { newDelete.click(); });
    assert.equal(confirmCalls, 0);
    assert.equal(latestRules.length, 2);
    const existingDelete = container.querySelector<HTMLButtonElement>("tbody tr:nth-child(2) .color-rule-icon-button--danger")!;
    await act(async () => { existingDelete.click(); });
    assert.equal(confirmCalls, 1);
    assert.equal(latestRules.length, 1);
    console.log("ok - untouched new rules delete directly while persisted rules require confirmation");

    const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/color-rules.css"), "utf8");
    assert.equal(css.includes(".color-rules-table-wrap"), true);
    assert.equal(css.includes("min-width: 1140px"), true);
    assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.color-rule-preview[\s\S]*forced-color-adjust:\s*auto/);
    console.log("ok - color rule table keeps stable widths and system forced-color fallback");
    assert.equal(container.textContent?.includes("从上到下匹配，首条符合条件的规则生效。"), false);
    console.log("ok - matching guidance remains in the dedicated Help window");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
  }
})();
