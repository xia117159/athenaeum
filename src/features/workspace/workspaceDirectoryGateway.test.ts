import assert from "node:assert/strict";
import {
  buildRemoteTreeNodes,
  listRemoteProfilesRequired,
  loadWorkspaceTreeChildren,
  mapTreeNodes,
  resolveWorkspaceDirectory
} from "./workspaceDirectoryGateway";
import type {
  DirectoryListing as BackendDirectoryListing,
  EntryViewModel as BackendEntryViewModel,
  RemoteProfile as BackendRemoteProfile,
  TreeNode as BackendTreeNode
} from "../../app/types";
import type { WorkspaceInvoke } from "./workspaceIpc";

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

const runtimeHost = { __TAURI_INTERNALS__: {} };

const sftpProfile = {
  id: "remote-test",
  name: "Test SFTP",
  protocol: "sftp",
  host: "127.0.0.1",
  port: 6666,
  username: "cheng",
  rootPath: "/home/cheng"
} satisfies BackendRemoteProfile;

const sftpRootProfile = {
  ...sftpProfile,
  id: "remote-root-test",
  host: "192.168.1.12",
  rootPath: "/"
} satisfies BackendRemoteProfile;

function createFile(path: string, name: string): BackendEntryViewModel {
  return {
    path,
    name,
    extension: name.split(".").pop() ?? null,
    kind: "file",
    size: 42,
    modifiedAt: null,
    isHidden: false,
    isSystem: false,
    isProtectedOperatingSystem: false,
    isReadOnly: false,
    isSymlink: false,
    location: {
      kind: "local",
      path
    },
    decoration: {
      foregroundColorHex: null,
      backgroundColorHex: null,
      tags: []
    }
  };
}

assertTest("mapTreeNodes converts backend tree nodes into unloaded workspace nodes", () => {
  assert.deepEqual(
    mapTreeNodes([
      {
        path: "E:\\Workspace",
        name: "Workspace",
        hasChildren: true,
        isHidden: true,
        isSystem: true,
        isProtectedOperatingSystem: true
      }
    ]),
    [
      {
        id: "E:\\Workspace",
        label: "Workspace",
        path: "E:\\Workspace",
        kind: "folder",
        expandable: true,
        loaded: false,
        isHidden: true,
        isSystem: true,
        isProtectedOperatingSystem: true,
        children: []
      }
    ]
  );
});

assertTest("buildRemoteTreeNodes exposes folder entries as expandable child nodes", () => {
  const nodes = buildRemoteTreeNodes("sftp://cheng@127.0.0.1:6666/home/cheng", {
    location: {
      kind: "sftp",
      label: "Test SFTP",
      path: "sftp://cheng@127.0.0.1:6666/home/cheng"
    },
    breadcrumbs: [],
    entries: [
      {
        id: "folder",
        name: "releases",
        kind: "folder",
        path: "sftp://cheng@127.0.0.1:6666/home/cheng/releases",
        parentPath: "sftp://cheng@127.0.0.1:6666/home/cheng",
        sizeLabel: "--",
        modifiedLabel: "--",
        extension: "",
        attributes: ["D"],
        accentColor: "#2f6b57",
        tags: [],
        description: "folder"
      },
      {
        id: "file",
        name: "readme.txt",
        kind: "file",
        path: "sftp://cheng@127.0.0.1:6666/home/cheng/readme.txt",
        parentPath: "sftp://cheng@127.0.0.1:6666/home/cheng",
        sizeLabel: "1 KB",
        modifiedLabel: "--",
        extension: ".txt",
        attributes: ["A"],
        accentColor: "#29659f",
        tags: [],
        description: "file"
      }
    ]
  });

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, "releases");
  assert.equal(nodes[0].badge, "sftp://cheng@127.0.0.1:6666/home/cheng");
  assert.equal(nodes[0].isHidden, false);
  assert.equal(nodes[0].isSystem, false);
  assert.equal(nodes[0].isProtectedOperatingSystem, false);
});

export const workspaceDirectoryGatewayTests = (async () => {
  await assertAsyncTest("resolveWorkspaceDirectory invokes local list_directory with normalized paths", async () => {
    let invokedArgs: Record<string, unknown> | null = null;
    const listing: BackendDirectoryListing = {
      location: {
        kind: "local",
        path: "E:\\Workspace"
      },
      entries: [createFile("E:\\Workspace\\report.txt", "report.txt")],
      parent: "E:\\",
      canGoUp: true
    };

    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "list_directory");
      invokedArgs = args;
      return listing as T;
    };

    const snapshot = await resolveWorkspaceDirectory("\\\\?\\E:\\Workspace", [], {
      invoke,
      runtimeHost
    });

    assert.deepEqual(invokedArgs, { path: "E:\\Workspace" });
    assert.equal(snapshot.location.path, "E:\\Workspace");
    assert.equal(snapshot.entries[0].path, "E:\\Workspace\\report.txt");
  });

  await assertAsyncTest("resolveWorkspaceDirectory routes remote paths through list_remote_directory", async () => {
    const remoteEntry: BackendEntryViewModel = {
      path: "/home/cheng/releases",
      name: "releases",
      extension: null,
      kind: "directory",
      size: null,
      modifiedAt: null,
      isHidden: false,
      isSystem: false,
      isProtectedOperatingSystem: false,
      isReadOnly: false,
      isSymlink: false,
      location: {
        kind: "sftp",
        path: "/home/cheng/releases",
        connectionId: "remote-test"
      },
      decoration: {
        foregroundColorHex: null,
        backgroundColorHex: null,
        tags: []
      }
    };

    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "list_remote_directory");
      assert.deepEqual(args, {
        request: {
          profileId: "remote-test",
          path: "/home/cheng"
        }
      });
      return [remoteEntry] as T;
    };

    const snapshot = await resolveWorkspaceDirectory("sftp://cheng@127.0.0.1:6666/home/cheng", [sftpProfile], {
      invoke,
      runtimeHost
    });

    assert.equal(snapshot.location.kind, "sftp");
    assert.equal(snapshot.entries[0].path, "sftp://cheng@127.0.0.1:6666/home/cheng/releases");
  });

  await assertAsyncTest("resolveWorkspaceDirectory routes configured SFTP root urls through the remote command", async () => {
    let invokedArgs: Record<string, unknown> | null = null;
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "list_remote_directory");
      invokedArgs = args;
      return [] as T;
    };

    const snapshot = await resolveWorkspaceDirectory("sftp://cheng@192.168.1.12:6666/", [sftpRootProfile], {
      invoke,
      runtimeHost
    });

    assert.deepEqual(invokedArgs, {
      request: {
        profileId: "remote-root-test",
        path: "/"
      }
    });
    assert.equal(snapshot.location.kind, "sftp");
    assert.equal(snapshot.location.path, "sftp://cheng@192.168.1.12:6666/");
  });

  for (const protocol of ["ftp", "sftp"] as const) {
    await assertAsyncTest(`expanded ${protocol} directory reads preserve nested URI identity and real IPC errors`, async () => {
      const profile = { ...sftpProfile, id: `nested-${protocol}`, protocol, port: protocol === "ftp" ? 21 : 22 };
      const path = `${protocol}://cheng@127.0.0.1:${profile.port}/home/cheng/Dir`;
      const canonicalPath = `${protocol}://cheng@127.0.0.1/home/cheng/Dir`;
      const child = { ...createFile("/home/cheng/Dir/Report.txt", "Report.txt"),
        location: { kind: protocol, path: "/home/cheng/Dir/Report.txt", connectionId: profile.id } };
      const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
        assert.equal(command, "list_remote_directory");
        assert.deepEqual(args, { request: { profileId: profile.id, path: "/home/cheng/Dir" } });
        return [child] as T;
      };
      const snapshot = await resolveWorkspaceDirectory(path, [profile], { invoke, runtimeHost });
      assert.equal(snapshot.location.path, canonicalPath);
      assert.equal(snapshot.entries[0].path, `${canonicalPath}/Report.txt`);
      assert.equal(snapshot.entries[0].parentPath, canonicalPath);
      await assert.rejects(resolveWorkspaceDirectory(path, [profile], {
        runtimeHost, invoke: async () => { throw new Error("permission denied"); }
      }), /permission denied/);
    });
  }

  await assertAsyncTest("resolveWorkspaceDirectory rejects remote urls that do not match a configured profile", async () => {
    await assert.rejects(
      () =>
        resolveWorkspaceDirectory("sftp://cheng@192.168.1.12:6666/", [sftpProfile], {
          invoke: async () => {
            throw new Error("unexpected invoke");
          },
          runtimeHost
        }),
      /未找到远程连接配置/
    );
  });

  await assertAsyncTest("loadWorkspaceTreeChildren invokes local get_tree_children and maps nodes", async () => {
    const backendNodes: BackendTreeNode[] = [{
      path: "E:\\Workspace\\src",
      name: "src",
      hasChildren: false,
      isHidden: false,
      isSystem: false,
      isProtectedOperatingSystem: false
    }];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "get_tree_children");
      assert.deepEqual(args, { path: "E:\\Workspace" });
      return backendNodes as T;
    };

    const nodes = await loadWorkspaceTreeChildren("E:\\Workspace", [], {
      invoke,
      runtimeHost
    });

    assert.equal(nodes[0].label, "src");
    assert.equal(nodes[0].loaded, false);
  });

  await assertAsyncTest("listRemoteProfilesRequired uses the list_remote_profiles command", async () => {
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "list_remote_profiles");
      assert.deepEqual(args, {});
      return [sftpProfile] as T;
    };

    const profiles = await listRemoteProfilesRequired({
      invoke,
      runtimeHost
    });

    assert.deepEqual(profiles, [sftpProfile]);
  });
})();
