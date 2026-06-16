import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  hasTauriRuntime,
  invokeRequired,
  invokeWithBrowserFallback,
  readSystemFileClipboard,
  performSystemFileOperation,
  setSystemFileClipboard,
  startSystemFileDrag,
  showNativeBackgroundContextMenu,
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
    "set_system_file_clipboard",
    "read_system_file_clipboard",
    "start_system_file_drag",
    "perform_system_file_operation",
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
    "show_native_background_context_menu",
    "show_native_context_menu"
  ];

  assert.equal(capability.permissions.includes("default"), true);
  for (const command of requiredCommands) {
    assert.equal(appPermission.includes(`"${command}"`), true, `${command} should be allowed by default permission`);
  }
  assert.equal(
    appPermission.includes("register_system_file_drop_target"),
    false,
    "file drops must use Tauri/wry's dragDropEnabled target instead of overriding it"
  );
});

assertTest("Tauri main window keeps native file drag-and-drop enabled", () => {
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src-tauri/tauri.conf.json"), "utf8")) as {
    app?: {
      windows?: Array<{
        dragDropEnabled?: boolean;
      }>;
    };
  };
  assert.equal(config.app?.windows?.[0]?.dragDropEnabled, true);
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

  await assertAsyncTest("showNativeBackgroundContextMenu invokes the background native menu command", async () => {
    let invokedArgs: Record<string, unknown> | null = null;
    const options = {
      viewMode: "details" as const,
      sort: {
        columnId: "name" as const,
        direction: "asc" as const
      },
      canPaste: true
    };

    assert.deepEqual(
      await showNativeBackgroundContextMenu("D:\\Projects", 10.4, 20.6, options, async <T>() => undefined as T, undefined),
      { opened: false }
    );

    assert.deepEqual(
      await showNativeBackgroundContextMenu(
        "D:\\Projects",
        10.4,
        20.6,
        options,
        async <T>(_command: string, args: Record<string, unknown>) => {
          invokedArgs = args;
          return {
            opened: true,
            action: {
              type: "setSort",
              columnId: "size"
            }
          } as T;
        },
        runtimeWindow
      ),
      {
        opened: true,
        action: {
          type: "setSort",
          columnId: "size"
        }
      }
    );
    assert.deepEqual(invokedArgs, {
      directoryPath: "D:\\Projects",
      x: 10,
      y: 21,
      options
    });
  });

  await assertAsyncTest("system file clipboard commands are thin IPC wrappers", async () => {
    let setArgs: Record<string, unknown> | null = null;
    let readCalled = false;

    await setSystemFileClipboard(
      ["D:\\Projects\\Atlas\\README.md"],
      "cut",
      async <T>(_command: string, args: Record<string, unknown>) => {
        setArgs = args;
        return undefined as T;
      },
      runtimeWindow
    );

    const clipboard = await readSystemFileClipboard(
      async <T>(_command: string, _args: Record<string, unknown>) => {
        readCalled = true;
        return { mode: "copy", paths: ["D:\\source.txt"] } as T;
      },
      runtimeWindow
    );

    assert.deepEqual(setArgs, {
      paths: ["D:\\Projects\\Atlas\\README.md"],
      mode: "cut"
    });
    assert.deepEqual(clipboard, {
      mode: "copy",
      paths: ["D:\\source.txt"]
    });
    assert.equal(readCalled, true);
  });

  await assertAsyncTest("startSystemFileDrag is a thin IPC wrapper", async () => {
    let invokedCommand: string | null = null;
    let invokedArgs: Record<string, unknown> | null = null;

    const result = await startSystemFileDrag(
      ["D:\\Projects\\Atlas\\README.md"],
      async <T>(command: string, args: Record<string, unknown>) => {
        invokedCommand = command;
        invokedArgs = args;
        return "copy" as T;
      },
      runtimeWindow
    );

    assert.equal(result, "copy");
    assert.equal(invokedCommand, "start_system_file_drag");
    assert.deepEqual(invokedArgs, {
      paths: ["D:\\Projects\\Atlas\\README.md"]
    });
    assert.equal(await startSystemFileDrag(["D:\\Projects\\Atlas\\README.md"], async <T>() => "copy" as T, undefined), null);
  });

  await assertAsyncTest("performSystemFileOperation invokes the native shell operation command", async () => {
    let invokedCommand: string | null = null;
    let invokedArgs: Record<string, unknown> | null = null;

    await performSystemFileOperation(
      ["D:\\Projects\\Atlas\\README.md"],
      "D:\\Archive",
      "copy",
      async <T>(command: string, args: Record<string, unknown>) => {
        invokedCommand = command;
        invokedArgs = args;
        return undefined as T;
      },
      runtimeWindow
    );

    assert.equal(invokedCommand, "perform_system_file_operation");
    assert.deepEqual(invokedArgs, {
      request: {
        sources: ["D:\\Projects\\Atlas\\README.md"],
        destination: "D:\\Archive",
        operation: "copy"
      }
    });
    assert.equal(
      await performSystemFileOperation(["D:\\Projects\\Atlas\\README.md"], "D:\\Archive", "move", async <T>() => undefined as T, undefined),
      undefined
    );
  });
})();
