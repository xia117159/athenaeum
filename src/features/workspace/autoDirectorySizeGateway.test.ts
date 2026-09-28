import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutoDirectorySizeGateway } from "./autoDirectorySizeGateway";
import type { WorkspaceInvoke } from "./workspaceIpc";

test("desktop commands carry only the path; the saved list arrives only through settings_changed (SAF-04)", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    return command === "choose_directory_size_folder" ? "D:\\Data" : ["D:\\Data"];
  }) as WorkspaceInvoke;
  const gateway = createAutoDirectorySizeGateway({ invoke, runtimeHost: { __TAURI_INTERNALS__: {} } });
  assert.equal(await gateway.add("D:\\Data"), undefined, "a reply may be older than another window's broadcast");
  assert.equal(await gateway.remove("d:\\data"), undefined);
  assert.equal(await gateway.choose(), "D:\\Data");
  assert.deepEqual(calls, [
    ["add_auto_directory_size_path", { path: "D:\\Data" }],
    ["remove_auto_directory_size_path", { path: "d:\\data" }],
    ["choose_directory_size_folder", {}]
  ]);
});

test("the browser fallback edits a local list with the backend's normalization", async () => {
  const gateway = createAutoDirectorySizeGateway({ runtimeHost: null });
  assert.deepEqual(await gateway.add(" d:/data/ "), ["D:\\data"]);
  assert.deepEqual(await gateway.add("D:\\DATA"), ["D:\\data"], "case-insensitive duplicates are kept once");
  assert.deepEqual(await gateway.add("\\\\server\\share"), ["D:\\data", "\\\\server\\share"]);
  await assert.rejects(gateway.add("relative\\path"), /有效的本地或网络文件夹绝对路径/);
  assert.deepEqual(await gateway.remove("d:\\Data"), ["\\\\server\\share"]);
  assert.equal(await gateway.choose(), null);
});
