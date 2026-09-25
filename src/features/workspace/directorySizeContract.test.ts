import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

test("desktop cache initialization precedes worker startup at Tauri Ready", () => {
  const app = readFileSync("src-tauri/src/lib.rs", "utf8");
  const run = app.indexOf("app.run(move |app, event|");
  const start = app.indexOf(".directory_sizes.start(");
  assert.ok(start > run, "Tauri setup runs at Ready, so starting before app.run silently disables history initialization");
  const ready = app.slice(run, start);
  assert.match(ready, /RunEvent::Ready/);
  const state = readFileSync("src-tauri/src/services/mod.rs", "utf8");
  assert.match(state, /directory_sizes\.initialize_storage\(data_dir\.join\("directory-size-cache-v2"\)\)/);
  assert.doesNotMatch(state, /directory_sizes\.initialize_history/);
});

test("directory size IPC is explicitly registered, permissioned and bound to the invoking window", () => {
  const commandsPath = "src-tauri/src/commands/directory_sizes.rs";
  assert.equal(existsSync(commandsPath), true, "thin directory-size command module must exist");
  const commands = readFileSync(commandsPath, "utf8");
  const app = readFileSync("src-tauri/src/lib.rs", "utf8");
  const permissions = readFileSync("src-tauri/permissions/default.toml", "utf8");
  for (const command of ["subscribe_directory_sizes", "release_directory_sizes", "lookup_directory_sizes", "get_directory_size_diagnostics", "lookup_directory_size_cache", "update_directory_size_views"]) {
    assert.match(commands, new RegExp(`fn ${command}\\b`));
    assert.match(app, new RegExp(`\\b${command}\\b`));
    assert.ok(permissions.includes(`commands.allow = ["${command}"]`));
    const defaultPermissions = permissions.slice(0, permissions.indexOf("[[permission]]"));
    assert.ok(defaultPermissions.includes(`"allow-${command.replaceAll("_", "-")}"`));
  }
  assert.match(commands, /window\.label\(\)/);
  assert.doesNotMatch(commands, /request\.(owner|windowLabel)/);
  assert.match(app, /directory_sizes\.close_owner\(window\.label\(\)\)/);
});
