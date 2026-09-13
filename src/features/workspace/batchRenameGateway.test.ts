import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBatchRenameGateway } from "./batchRenameGateway";

export const completion = (async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const gateway = createBatchRenameGateway({ runtimeHost: { __TAURI_INTERNALS__: {} },
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      calls.push({ command, args }); return { sessionId: "s" } as T;
    } });
  const paths = ["D:\\文档\\Test.txt", "D:\\other\\中文.txt"];
  const preview = { sessionId: "s", expression: "New_<#001>", revision: 4 };
  const apply = { sessionId: "s", previewId: "p", requestId: "r", source: "shortcut" as const, panelId: "left", tabId: "t" };
  assert.equal((await gateway.create(paths)).sessionId, "s");
  await gateway.preview(preview);
  await gateway.invalidate({ sessionId: "s", revision: 5 });
  await gateway.apply(apply);
  await gateway.close("s");
  await gateway.functions();
  assert.deepEqual(calls, [
    { command: "create_batch_rename_session", args: { request: { paths } } },
    { command: "preview_batch_rename", args: { request: preview } },
    { command: "invalidate_batch_rename_preview", args: { request: { sessionId: "s", revision: 5 } } },
    { command: "apply_batch_rename", args: { request: apply } },
    { command: "close_batch_rename_session", args: { sessionId: "s" } },
    { command: "get_batch_rename_functions", args: {} }
  ]);
  await assert.rejects(createBatchRenameGateway({ runtimeHost: null }).apply(apply), /桌面/);
  await assert.rejects(createBatchRenameGateway({ runtimeHost: { __TAURI_INTERNALS__: {} },
    invoke: async () => { throw new Error("stale preview"); } }).apply(apply), /stale preview/);
  const permissions = readFileSync("src-tauri/permissions/default.toml", "utf8");
  const registration = readFileSync("src-tauri/src/lib.rs", "utf8").split("tauri::generate_handler![")[1];
  for (const { command } of calls) {
    assert.ok(permissions.includes(`commands.allow = ["${command}"]`), command);
    assert.ok(registration.includes(`${command},`), command);
  }
  console.log("ok - batch rename gateway carries server preview tokens and requires desktop execution");
})();
