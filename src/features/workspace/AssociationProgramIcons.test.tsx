import assert from "node:assert/strict";
import React, { act, useState } from "react";
import type { FileAssociationRule } from "../../app/fileAssociations";
import { FileAssociationsPage } from "./FileAssociationsPage";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { setSystemIconResolverForTests, type SystemIconRequest } from "./systemIconGateway";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const container = document.createElement("div"); document.body.append(container);
  const root = ReactDOM.createRoot(container);
  const paths = ["C:/Tools/first.exe", "C:\\Tools\\first.exe", "C:/Tools/second.exe", "\\\\server\\apps\\network.exe", "C:/Missing/editor.exe", ""];
  const initial = paths.map((executablePath, index) => ({id:String(index), patterns:"txt", executablePath, argumentsTemplate:""}));
  const requests: SystemIconRequest[] = [];
  const icon = (color: string) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${color}"/></svg>`);
  const firstIcon = icon("green"), secondIcon = icon("blue"), networkIcon = icon("orange"), lastIcon = icon("purple");
  let lateIcon!: (source: string) => void;
  setSystemIconResolverForTests(async request => {
    requests.push(request);
    if (request.path?.endsWith("late.exe")) return new Promise(resolve => {lateIcon = resolve;});
    return request.path?.endsWith("first.exe") ? firstIcon : request.path?.endsWith("second.exe") ? secondIcon
      : request.path?.endsWith("network.exe") ? networkIcon : lastIcon;
  });
  let changeRules!: React.Dispatch<React.SetStateAction<FileAssociationRule[]>>;
  let inspectFails = false;
  function Harness() {
    const [rules, setRules] = useState(initial); changeRules = setRules;
    return <FileAssociationsPage rules={rules} onChange={setRules} onChooseProgram={async () => null}
      onInspectPrograms={async programPaths => {
        if (inspectFails) throw new Error("inspection unavailable");
        return programPaths.map(path => ({path, displayName:"Editor", exists:!path.includes("Missing")}));
      }} />;
  }
  const tick = async (action: () => void) => act(async () => { action(); await flushEffects(); });
  const inspected = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); await flushEffects(); });
  const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  const source = (index: number) => rows()[index].querySelector("img")?.getAttribute("src");
  const invalid = (index: number) => rows()[index].querySelector('[aria-label="程序不存在或无法访问"]');
  try {
    await tick(() => root.render(<Harness />));
    assert.equal(requests.length, 0, "unknown existence is not a failed path or an icon request");
    assert.equal(invalid(0) === null, true);
    await inspected();
    assert.equal(source(0), firstIcon, "association row loads the actual executable icon");
    assert.equal(source(1), firstIcon);
    assert.equal(source(2), secondIcon, "distinct .exe files cannot share an extension icon cache entry");
    assert.equal(source(3), networkIcon);
    assert.deepEqual(requests.map(request => request.path).sort(), ["C:\\Tools\\first.exe", "C:\\Tools\\second.exe", "\\\\server\\apps\\network.exe"].sort());
    assert.ok(requests.every(request => request.includeOverlays === true));
    assert.ok(invalid(4)); assert.equal(source(4), undefined);
    assert.equal(invalid(5) === null, true, "an empty rule is not reported as a missing executable");

    await tick(() => changeRules(rules => rules.map((rule, index) => index === 0 ? {...rule, executablePath:"C:/Tools/late.exe"} : rule)));
    assert.equal(source(0), undefined, "a new program immediately stops displaying the previous icon");
    await inspected();
    assert.equal(typeof lateIcon, "function");
    await tick(() => changeRules(rules => rules.map((rule, index) => index === 0 ? {...rule, executablePath:"C:/Tools/final.exe"} : rule)));
    await inspected();
    assert.equal(source(0), lastIcon);
    await tick(() => lateIcon(firstIcon));
    assert.equal(source(0), lastIcon, "late icon result cannot replace the current program");

    inspectFails = true;
    await tick(() => changeRules(rules => rules.map((rule, index) => index === 0 ? {...rule, executablePath:"C:/Tools/unavailable.exe"} : rule)));
    await inspected();
    assert.equal(source(0), undefined);
    assert.equal(invalid(0) === null, true, "inspection failure is not proof of a missing executable");
    assert.ok(container.textContent?.includes("inspection unavailable"));
    console.log("ok - program icons use exact paths, share separator aliases, identify missing programs and ignore late results");
  } finally {
    await tick(() => root.unmount()); container.remove(); setSystemIconResolverForTests();
    dom.window.close();
  }
})();
