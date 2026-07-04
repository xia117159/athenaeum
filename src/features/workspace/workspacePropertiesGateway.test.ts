import assert from "node:assert/strict";
import {
  createItemPropertiesRequest,
  getWorkspaceItemProperties
} from "./workspacePropertiesGateway";
import type { RemoteProfile } from "../../app/types";

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

const profiles: RemoteProfile[] = [
  {
    id: "remote-sftp-edge-01",
    name: "edge-01",
    protocol: "sftp",
    host: "edge-01",
    port: 22,
    username: "deploy",
    rootPath: "/releases"
  }
];

assertTest("createItemPropertiesRequest builds canonical local request args", () => {
  const request = createItemPropertiesRequest(
    {
      requestId: "properties-1",
      path: "\\\\?\\D:\\Projects\\Atlas\\report.txt"
    },
    profiles
  );

  assert.deepEqual(request, {
    requestId: "properties-1",
    target: {
      kind: "local",
      path: "D:\\Projects\\Atlas\\report.txt"
    },
    includeDirectorySize: false
  });
});

assertTest("createItemPropertiesRequest builds remote targets without password or display path leakage", () => {
  const request = createItemPropertiesRequest(
    {
      requestId: "properties-remote",
      path: "sftp://deploy@edge-01/releases/2026-04-18/manifest.yml",
      includeDirectorySize: true
    },
    profiles
  );

  assert.deepEqual(request, {
    requestId: "properties-remote",
    target: {
      kind: "remote",
      protocol: "sftp",
      profileId: "remote-sftp-edge-01",
      remotePath: "/releases/2026-04-18/manifest.yml",
      displayPath: "sftp://deploy@edge-01/releases/2026-04-18/manifest.yml"
    },
    includeDirectorySize: true
  });
  assert.equal("password" in request.target, false);
});

assertTest("createItemPropertiesRequest rejects remote urls without a matching profile", () => {
  assert.throws(
    () =>
      createItemPropertiesRequest(
        {
          requestId: "properties-missing",
          path: "sftp://deploy@unknown-host/releases/file.txt"
        },
        profiles
      ),
    /未找到远程连接配置/
  );
});

export const workspacePropertiesGatewayTests = (async () => {
  await assertAsyncTest("getWorkspaceItemProperties invokes get_item_properties with the canonical request", async () => {
    let invokedCommand = "";
    let invokedArgs: Record<string, unknown> | undefined;

    const item = await getWorkspaceItemProperties(
      {
        requestId: "properties-ipc",
        path: "D:\\Projects\\Atlas\\report.txt"
      },
      profiles,
      {
        runtimeHost: { __TAURI_INTERNALS__: {} },
        invoke: async <T>(command: string, args: Record<string, unknown>) => {
          invokedCommand = command;
          invokedArgs = args;
          return {
            requestId: "properties-ipc",
            target: {
              kind: "local",
              path: "D:\\Projects\\Atlas\\report.txt"
            },
            displayPath: "D:\\Projects\\Atlas\\report.txt",
            actualPath: "D:\\Projects\\Atlas\\report.txt",
            parentPath: "D:\\Projects\\Atlas",
            name: "report.txt",
            extension: ".txt",
            kind: "file",
            sizeBytes: 1024,
            allocatedBytes: null,
            createdAt: null,
            modifiedAt: "2026-06-10T08:00:00Z",
            accessedAt: null,
            isHidden: false,
            isReadOnly: false,
            isSymlink: false,
            directorySizeState: {
              state: "notApplicable"
            },
            fieldStates: []
          } as T;
        }
      }
    );

    assert.equal(invokedCommand, "get_item_properties");
    assert.deepEqual(invokedArgs, {
      request: {
        requestId: "properties-ipc",
        target: {
          kind: "local",
          path: "D:\\Projects\\Atlas\\report.txt"
        },
        includeDirectorySize: false
      }
    });
    assert.equal(item.kind, "file");
    assert.equal(item.sizeBytes, 1024);
  });

  await assertAsyncTest("getWorkspaceItemProperties maps backend directory kind to frontend folder kind", async () => {
    const item = await getWorkspaceItemProperties(
      {
        requestId: "properties-directory",
        path: "D:\\Projects\\Atlas"
      },
      profiles,
      {
        runtimeHost: { __TAURI_INTERNALS__: {} },
        invoke: async <T>() =>
          ({
            requestId: "properties-directory",
            target: {
              kind: "local",
              path: "D:\\Projects\\Atlas"
            },
            displayPath: "D:\\Projects\\Atlas",
            actualPath: "D:\\Projects\\Atlas",
            parentPath: "D:\\Projects",
            name: "Atlas",
            extension: "",
            kind: "directory",
            sizeBytes: null,
            allocatedBytes: null,
            createdAt: null,
            modifiedAt: null,
            accessedAt: null,
            isHidden: false,
            isReadOnly: false,
            isSymlink: false,
            directorySizeState: {
              state: "notComputed"
            },
            fieldStates: [{ field: "directorySize", state: "notComputed" }]
          }) as T
      }
    );

    assert.equal(item.kind, "folder");
    assert.equal(item.directorySizeState.state, "notComputed");
  });

  await assertAsyncTest("getWorkspaceItemProperties browser fallback returns structured unavailable field states", async () => {
    const item = await getWorkspaceItemProperties(
      {
        requestId: "properties-browser",
        path: "D:\\Projects\\Atlas\\report.txt"
      },
      profiles
    );

    assert.equal(item.requestId, "properties-browser");
    assert.equal(item.target.kind, "local");
    assert.equal(item.name, "report.txt");
    assert.equal(item.fieldStates.some((field) => field.field === "createdAt" && field.state === "notAvailable"), true);
  });
})();
