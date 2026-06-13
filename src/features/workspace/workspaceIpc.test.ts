import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  hasTauriRuntime,
  invokeRequired,
  invokeWithBrowserFallback,
  showNativeContextMenu
} from "./workspaceIpc";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function assertAsyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const runtimeWindow = { __TAURI_INTERNALS__: {} };
const tauriV2RuntimeWindow = { isTauri: true };

assertTest("hasTauriRuntime detects Tauri v2 runtime windows", () => {
  assert.equal(hasTauriRuntime(undefined), false);
  assert.equal(hasTauriRuntime({}), false);
  assert.equal(hasTauriRuntime(runtimeWindow), true);
  assert.equal(hasTauriRuntime(tauriV2RuntimeWindow), true);
});

assertTest("Tauri app ACL exposes required workspace commands to the main window", () => {
  const capability = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src-tauri/capabilities/default.json"), "utf8")) as {
    permissions: string[];
  };
  const appPermission = fs.readFileSync(path.join(process.cwd(), "src-tauri/permissions/default.toml"), "utf8");
  const requiredCommands = [
    "initialize_workspace",
    "list_directory",
    "get_item_properties",
    "get_tree_children",
    "resolve_system_icon",
    "copy_entries",
    "move_entries",
    "delete_entries",
    "rename_entry",
    "create_directory",
    "create_file",
    "start_file_operation",
    "list_file_operation_tasks",
    "cancel_file_operation",
    "resolve_file_operation_conflict",
    "list_operation_history",
    "undo_latest_operation",
    "undo_operation",
    "start_search",
    "cancel_search",
    "get_settings_snapshot",
    "save_bookmark",
    "delete_bookmark",
    "save_hotlist_entry",
    "delete_hotlist_entry",
    "save_color_rule",
    "delete_color_rule",
    "save_tag_definition",
    "delete_tag_definition",
    "save_shortcuts",
    "save_details_row_height",
    "save_settings_model",
    "save_ui_layout",
    "save_ui_theme",
    "save_navigation_item",
    "delete_navigation_item",
    "reorder_navigation_items",
    "mark_navigation_item_opened",
    "resolve_navigation_targets",
    "open_path_with_system_default",
    "list_remote_profiles",
    "save_remote_profile",
    "delete_remote_profile",
    "test_remote_profile",
    "get_remote_host_key",
    "trust_remote_host_key",
    "list_remote_directory",
    "create_remote_directory",
    "delete_remote_entries",
    "rename_remote_entry",
    "upload_remote_files",
    "download_remote_entries",
    "copy_remote_entries",
    "move_remote_entries",
    "transfer_remote_entries",
    "show_native_context_menu"
  ];

  assert.equal(capability.permissions.includes("default"), true);
  for (const command of requiredCommands) {
    assert.equal(appPermission.includes(`"${command}"`), true, `${command} should be allowed by default permission`);
  }
});

export const workspaceIpcTests = (async () => {
  await assertAsyncTest("invokeWithBrowserFallback uses fallback only when Tauri runtime is absent", async () => {
    let invoked = false;

    const result = await invokeWithBrowserFallback(
      "list_directory",
      { path: "D:\\Projects" },
      async () => "browser",
      async <T>() => {
        invoked = true;
        return "tauri" as T;
      },
      undefined
    );

    assert.equal(result, "browser");
    assert.equal(invoked, false);
  });

  await assertAsyncTest("invokeWithBrowserFallback returns Tauri results when runtime is present", async () => {
    let fallbackUsed = false;

    const result = await invokeWithBrowserFallback(
      "list_directory",
      { path: "D:\\Projects" },
      async () => {
        fallbackUsed = true;
        return "browser";
      },
      async <T>() => "tauri" as T,
      runtimeWindow
    );

    assert.equal(result, "tauri");
    assert.equal(fallbackUsed, false);
  });

  await assertAsyncTest("invokeWithBrowserFallback propagates Tauri command failures", async () => {
    const commandError = new Error("backend failed");
    let fallbackUsed = false;

    await assert.rejects(
      () =>
        invokeWithBrowserFallback(
          "list_directory",
          { path: "D:\\Projects" },
          async () => {
            fallbackUsed = true;
            return "browser";
          },
          async <T>() => {
            throw commandError;
          },
          runtimeWindow
        ),
      commandError
    );
    assert.equal(fallbackUsed, false);
  });

  await assertAsyncTest("invokeRequired still allows explicit browser fallbacks outside Tauri", async () => {
    const result = await invokeRequired(
      "list_remote_profiles",
      {},
      async () => ["browser-profile"],
      async <T>() => [] as T,
      undefined
    );

    assert.deepEqual(result, ["browser-profile"]);
  });

  await assertAsyncTest("showNativeContextMenu reports whether the native menu opened", async () => {
    let invokedArgs: Record<string, unknown> | null = null;

    assert.equal(await showNativeContextMenu(["D:\\Projects"], 10.4, 20.6, async <T>() => undefined as T, undefined), false);

    assert.equal(
      await showNativeContextMenu(
        ["D:\\Projects"],
        10.4,
        20.6,
        async <T>(_command: string, args: Record<string, unknown>) => {
          invokedArgs = args;
          return true as T;
        },
        runtimeWindow
      ),
      true
    );
    assert.deepEqual(invokedArgs, {
      paths: ["D:\\Projects"],
      x: 10,
      y: 21
    });

    assert.equal(
      await showNativeContextMenu(
        ["D:\\Projects"],
        10,
        20,
        async <T>() => false as T,
        runtimeWindow
      ),
      false
    );

    assert.equal(
      await showNativeContextMenu(
        ["D:\\Projects"],
        10,
        20,
        async <T>() => {
          throw new Error("not supported");
        },
        runtimeWindow
      ),
      false
    );
  });
})();
