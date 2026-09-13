import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTemplateGateway } from "./templateCreationGateway";
import type { WorkspaceInvoke } from "./workspaceIpc";

export const completion = (async () => {
  const calls: { command: string; args: unknown }[] = [];
  const invoke: WorkspaceInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args }); return null as T;
  };
  const gateway = createTemplateGateway({ invoke, runtimeHost: { __TAURI_INTERNALS__: {} } });
  const request = { requestId: "unique", templateRoot: "C:\\模板", relativePaths: ["Word/报告.docx"], destination: "D:\\文档", panelId: "panel-1", tabId: "tab" };
  await gateway.list(request.templateRoot, "Word"); await gateway.create(request);
  assert.equal(await gateway.chooseRoot(), null);
  assert.deepEqual(calls, [
    { command: "list_creation_templates", args: { rootPath: request.templateRoot, relativePath: "Word" } },
    { command: "create_template_items", args: { request } },
    { command: "choose_template_root", args: {} }
  ]);
  const failure = createTemplateGateway({ runtimeHost: { __TAURI_INTERNALS__: {} }, invoke: async () => { throw new Error("access denied"); } });
  await assert.rejects(() => failure.list("C:\\Templates"), /access denied/);
  await assert.rejects(() => failure.create(request), /access denied/);
  const permissions = readFileSync("src-tauri/permissions/default.toml", "utf8");
  const defaults = permissions.split("[[permission]]")[0];
  const registration = readFileSync("src-tauri/src/lib.rs", "utf8").split("tauri::generate_handler![")[1];
  const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
  assert.ok(capability.permissions.includes("default"));
  assert.ok(["main", "settings"].every((window) => capability.windows.includes(window)));
  for (const { command } of calls) {
    const permission = `allow-${command.replaceAll("_", "-")}`;
    const definition = permissions.split("[[permission]]").find((entry) => entry.includes(`identifier = "${permission}"`));
    assert.ok(definition?.includes(`commands.allow = ["${command}"]`), `missing permission: ${command}`);
    assert.ok(defaults.includes(`"${permission}"`), `unreachable permission: ${command}`);
    assert.ok(registration.includes(`${command},`), `unregistered command: ${command}`);
  }
  console.log("ok - template gateway preserves IPC contracts and surfaces native failures");
})();
