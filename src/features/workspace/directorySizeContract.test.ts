import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

test("directory size IPC is explicitly registered, permissioned and bound to the invoking window", () => {
  const commandsPath = "src-tauri/src/commands/directory_sizes.rs";
  assert.equal(existsSync(commandsPath), true, "thin directory-size command module must exist");
  const commands = readFileSync(commandsPath, "utf8");
  const app = readFileSync("src-tauri/src/lib.rs", "utf8");
  const permissions = readFileSync("src-tauri/permissions/default.toml", "utf8");
  for (const command of ["subscribe_directory_sizes", "release_directory_sizes", "lookup_directory_sizes"]) {
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
