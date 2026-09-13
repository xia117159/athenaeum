import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { act } from "react";
import { BatchRenameHelpWindowView } from "./BatchRenameHelpWindowView";
import { openBatchRenameHelpWindow, BATCH_RENAME_HELP_WINDOW_LABEL } from "./batchRenameHelpWindow";
import { installDomEnvironment, flushEffects } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  let loaded = 0;
  try {
    await act(async () => {
      root.render(<BatchRenameHelpWindowView loadFunctions={async () => {
        loaded++;
        return [{ name: "my_new_function", aliases: ["alias"], parameters: [{ name: "text", role: "text", optional: false }],
          description: "注册表添加的函数说明", examples: [{ expression: "<my_new_function *>", result: "New.txt" }] }];
      }} />);
      await flushEffects();
    });
    assert.equal(loaded, 1, "help must load the backend function registry");
    const text = document.body.textContent ?? "";
    for (const value of ["my_new_function", "注册表添加的函数说明", "<my_new_function *>", "New.txt", "默认保留扩展名", "原基本名",
      "<#001>", "yyyy-mm-ddThh-mm-ss", "单引号", "20 条", "Ctrl+Z", "<tolower <tohex New_<date yyyy-mm-dd>>>", "esn\\d{4}gpa\\d{3}"] ) {
      assert.ok(text.includes(value), `help contains ${value}`);
    }
    const events: string[] = [];
    await openBatchRenameHelpWindow({ hasTauriRuntime: () => true, openBrowserWindow: () => {},
      loadWebviewWindow: async () => ({ WebviewWindow: Object.assign(function() { throw new Error("must reuse"); }, {
        getByLabel: async (label: string) => { assert.equal(label, BATCH_RENAME_HELP_WINDOW_LABEL); return {
          show: async () => { events.push("show"); }, setFocus: async () => { events.push("focus"); }, once: async () => () => {} }; }
      }) as never }) });
    assert.deepEqual(events, ["show", "focus"]);
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/batch-rename-help.json", "utf8"));
    assert.deepEqual(capability.windows, ["batch-rename-help"]);
    assert.deepEqual(capability.permissions, ["allow-get-batch-rename-functions"]);
    assert.ok(readFileSync("src/app/AppShell.tsx", "utf8").includes('view === "batch-rename-help"'));
    console.log("ok - standalone help uses the registry, includes rules/examples and has only read access");
  } finally { await act(async () => root.unmount()); }
})();
