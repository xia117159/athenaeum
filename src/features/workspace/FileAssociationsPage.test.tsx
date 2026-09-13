import assert from "node:assert/strict";
import React, { act, useState } from "react";
import type { FileAssociationRule } from "../../app/fileAssociations";
import { FileAssociationsPage } from "./FileAssociationsPage";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { patchLegacyInputEventTarget } from "./testDom";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const initial: FileAssociationRule[] = [
    { id:"one", patterns:"txt", executablePath:"C:\\one.exe", argumentsTemplate:"" },
    { id:"two", patterns:"md", executablePath:"C:\\two.exe", argumentsTemplate:"{file}" }
  ];
  let latest = initial;
  let setRules!: React.Dispatch<React.SetStateAction<FileAssociationRule[]>>;
  let choose: () => Promise<string | null> = async () => null;
  function Harness() {
    const [rules, update] = useState(initial);
    setRules = update;
    latest = rules;
    return <FileAssociationsPage rules={rules} onChange={update} onChooseProgram={() => choose()}
      onInspectPrograms={async paths => paths.map(path => ({path, displayName:"Editor", exists:false}))} />;
  }
  const tick = async (action: () => void) => act(async () => { action(); await flushEffects(); });
  const button = (action: string) => {
    const element = container.querySelector<HTMLButtonElement>('[data-action="'+action+'"]');
    assert.ok(element, action);
    return element;
  };
  const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  const input = () => {
    const element = container.querySelector<HTMLInputElement>('[aria-label="关联表达式"]');
    assert.ok(element, "editing expression");
    return element;
  };
  const key = (element: HTMLElement, key: string, isComposing = false) => element.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {key, bubbles:true, cancelable:true, isComposing}));
  const change = async (element: HTMLInputElement, value: string) => tick(() => {
    element.focus();
    patchLegacyInputEventTarget(element);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", {bubbles:true}));
  });

  try {
    await tick(() => root.render(<Harness />));
    assert.equal(rows().length, 2, "expression list");
    assert.ok(container.querySelector("aside"));
    await tick(() => rows()[0].click());
    assert.equal(button("association-up").disabled, true);
    await tick(() => key(rows()[0], "F2"));
    const expression = String.raw`*.md;.json;txt > "D:\Program Files (x86)\Notepad++\notepad++.exe" --new-window {file}`;
    for (let i = 0; i <= expression.length; i++) {
      await change(input(), expression.slice(0,i));
      assert.equal(input().value, expression.slice(0,i), "typing must preserve separators and spaces");
    }
    assert.ok(latest[0].executablePath.includes("Program Files (x86)"), "current input already belongs to settings draft");
    assert.equal(latest[0].argumentsTemplate, "--new-window {file}");
    await tick(() => key(input(), "Enter", true));
    assert.ok(input(), "IME Enter must not commit");
    await tick(() => key(input(), "Enter"));
    assert.equal(container.querySelector('[aria-label="关联表达式"]'), null);
    assert.equal(rows()[0].textContent?.includes(expression), true);
    assert.equal(document.activeElement, rows()[0]);

    await tick(() => rows()[0].dispatchEvent(new dom.window.MouseEvent("dblclick", {bubbles:true})));
    await change(input(), "log > C:\\changed.exe --reuse-window");
    await tick(() => key(input(), "Escape"));
    assert.equal(latest[0].patterns, "*.md;.json;txt");
    assert.equal(latest[0].argumentsTemplate, "--new-window {file}", "Escape also restores the original parameter template");
    await tick(() => button("association-down").click());
    assert.deepEqual(latest.map(rule => rule.id), ["two", "one"]);
    await tick(() => button("association-delete").click());
    assert.deepEqual(latest.map(rule => rule.id), ["two"]);
    assert.equal(rows()[0].getAttribute("aria-selected"), "true");

    await tick(() => button("association-add").click());
    assert.equal(latest.length, 2);
    await change(input(), "");
    await tick(() => key(input(), "Enter"));
    assert.equal(latest[1].patterns, "");
    assert.equal(latest[1].executablePath, "");
    assert.equal(container.querySelector('[aria-label="参数模板"]'), null, "parameters are edited only in the expression row");
    await tick(() => button("association-edit").click());
    await change(input(), 'txt > "" --new-window "{file}"');
    await tick(() => key(input(), "Enter"));
    assert.equal(latest[1].argumentsTemplate, '--new-window "{file}"');

    let resolvePicker!: (path: string | null) => void;
    choose = () => new Promise(resolve => {resolvePicker = resolve;});
    await tick(() => button("association-choose-program").click());
    const newId = latest[1].id;
    await tick(() => setRules(rules => rules.filter(rule => rule.id !== newId)));
    await tick(() => resolvePicker("C:\\late.exe"));
    assert.equal(latest.length, 1);
    assert.equal(latest[0].executablePath, "C:\\two.exe", "late picker must not change another row");

    choose = async () => {throw new Error("picker unavailable");};
    await tick(() => button("association-choose-program").click());
    assert.ok(container.textContent?.includes("picker unavailable"));
    choose = async () => null;
    await tick(() => button("association-choose-program").click());
    assert.equal(latest[0].executablePath, "C:\\two.exe");
    choose = async () => "D:\\Program Files\\chosen.exe";
    await tick(() => button("association-choose-program").click());
    assert.equal(latest[0].executablePath, "D:\\Program Files\\chosen.exe");
    assert.equal(latest[0].argumentsTemplate, "{file}", "program selection preserves arguments");
    assert.ok(rows()[0].textContent?.includes('"D:\\Program Files\\chosen.exe" {file}'), "chosen paths with spaces are quoted");
    assert.deepEqual([...container.querySelectorAll("aside button")].map(element => element.getAttribute("data-action")), [
      "association-add", "association-edit", "association-choose-program", "association-delete", "association-up", "association-down"
    ]);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); });
    assert.ok(container.textContent?.includes("程序不存在或无法访问"));
    await tick(() => setRules(initial.map(rule => ({...rule}))));
    await tick(() => rows()[0].focus());
    await tick(() => key(rows()[0], "Delete"));
    assert.equal(document.activeElement === rows()[0], true, "keyboard deletion keeps focus on the adjacent rule");
    await tick(() => key(document.activeElement as HTMLElement, "F2"));
    assert.ok(input(), "editing continues without refocusing the list");
    await tick(() => key(input(), "Escape"));
    await tick(() => key(document.activeElement as HTMLElement, "Delete"));
    assert.equal(rows().length, 0);
    assert.equal(document.activeElement === button("association-add"), true, "deleting the final rule focuses New");
    await tick(() => setRules(initial.map(rule => ({...rule}))));
    await tick(() => { button("association-delete").focus(); button("association-delete").click(); });
    assert.equal(document.activeElement === button("association-delete"), true, "pointer/button deletion retains the operation control's focus");
    console.log("ok - association page typing, IME, CRUD, focus, parameters and picker races");
  } finally {
    await tick(() => root.unmount());
    container.remove();
  }
})();
