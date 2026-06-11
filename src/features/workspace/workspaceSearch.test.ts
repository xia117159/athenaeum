import assert from "node:assert/strict";
import {
  cancelWorkspaceSearch,
  createBackendSearchQuery,
  mapSearchResult,
  resolveSearchRoots,
  runWorkspaceSearch
} from "./workspaceSearch";
import type { RemoteProfile as BackendRemoteProfile, SearchResult as BackendSearchResult } from "../../app/types";
import type { SearchQuery as WorkspaceSearchQuery } from "./types";
import type { WorkspaceListen } from "./workspaceSearch";

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

const sftpProfile = {
  id: "remote-test",
  name: "Test SFTP",
  protocol: "sftp",
  host: "127.0.0.1",
  port: 6666,
  username: "cheng",
  rootPath: "/home/cheng"
} satisfies BackendRemoteProfile;

function createWorkspaceSearchQuery(overrides: Partial<WorkspaceSearchQuery> = {}): WorkspaceSearchQuery {
  return {
    name: "",
    content: "",
    nameMode: "normal",
    contentMode: "normal",
    extensionFilterText: "",
    extensionFilterMode: "include",
    includeFolders: false,
    recursive: true,
    caseSensitive: false,
    scope: "active-panel",
    ...overrides
  };
}

assertTest("resolveSearchRoots keeps local roots and excludes remote profile roots", () => {
  assert.deepEqual(
    resolveSearchRoots(
      ["\\\\?\\E:\\Workspace", "sftp://cheng@127.0.0.1:6666/home/cheng/releases"],
      [sftpProfile]
    ),
    ["E:\\Workspace"]
  );
});

assertTest("createBackendSearchQuery trims patterns and uses nulls for empty filters", () => {
  assert.deepEqual(
    createBackendSearchQuery("search-1", ["E:\\Workspace"], {
      ...createWorkspaceSearchQuery({
        name: " report ",
        content: " ",
        nameMode: "wildcard",
        contentMode: "regex",
        extensionFilterText: " .ts ;tsx; md ",
      extensionFilterMode: "exclude",
      includeFolders: true,
      recursive: false,
      caseSensitive: true
      })
    }),
    {
      searchId: "search-1",
      roots: ["E:\\Workspace"],
      namePattern: "report",
      contentPattern: null,
      nameMode: "wildcard",
      contentMode: "regex",
      extensions: ["ts", "tsx", "md"],
      extensionFilterMode: "exclude",
      includeFolders: true,
      recursive: false,
      includeHidden: false,
      caseSensitive: true,
      maxFileSizeBytes: 1024 * 1024
    }
  );
});

assertTest("mapSearchResult converts backend search payloads to workspace results", () => {
  const result = mapSearchResult({
    searchId: "search-1",
    path: "\\\\?\\E:\\Workspace\\report.txt",
    name: "report.txt",
    parent: "\\\\?\\E:\\Workspace",
    isDirectory: false,
    matchedOn: ["name"],
    excerpt: null
  });

  assert.equal(result.id, "search-1:\\\\?\\E:\\Workspace\\report.txt");
  assert.equal(result.path, "E:\\Workspace\\report.txt");
  assert.equal(result.parentPath, "E:\\Workspace");
  assert.equal(result.openPath, "E:\\Workspace");
  assert.equal(result.match, "name");
});

export const workspaceSearchTests = (async () => {
  await assertAsyncTest("cancelWorkspaceSearch invokes the backend cancel command with the active search id", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];

    await cancelWorkspaceSearch("search-42", {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return undefined as T;
      }
    });

    assert.deepEqual(calls, [
      {
        command: "cancel_search",
        args: {
          searchId: "search-42"
        }
      }
    ]);
  });

  await assertAsyncTest("runWorkspaceSearch returns early for empty filters without starting IPC", async () => {
    let invoked = false;

    const results = await runWorkspaceSearch(
      createWorkspaceSearchQuery({ name: " ", content: "" }),
      ["E:\\Workspace"],
      [],
      {
        createSearchId: () => "search-1",
        invoke: async <T>() => {
          invoked = true;
          return undefined as T;
        },
        listen: async () => () => undefined
      }
    );

    assert.deepEqual(results, []);
    assert.equal(invoked, false);
  });

  await assertAsyncTest("runWorkspaceSearch can use a caller supplied search id for cancellation tracking", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    let invokedArgs: Record<string, unknown> | undefined;

    const listen: WorkspaceListen = async (eventName, handler) => {
      handlers.set(eventName, handler as (event: { payload: unknown }) => void);
      return () => undefined;
    };

    const resultsPromise = runWorkspaceSearch(
      createWorkspaceSearchQuery({ content: "needle" }),
      ["E:\\Workspace"],
      [],
      {
        searchId: "search-from-controller",
        createSearchId: () => "wrong-search-id",
        listen,
        invoke: async <T>(_command: string, args: Record<string, unknown>) => {
          invokedArgs = args;
          handlers.get("search_finished")?.({
            payload: {
              searchId: "search-from-controller",
              cancelled: true,
              scannedEntries: 20,
              matchedEntries: 0
            }
          });
          return { searchId: "search-from-controller" } as T;
        }
      }
    );

    await resultsPromise;
    assert.deepEqual(invokedArgs, {
      query: createBackendSearchQuery("search-from-controller", ["E:\\Workspace"], {
        ...createWorkspaceSearchQuery({ content: "needle" })
      })
    });
  });

  await assertAsyncTest("runWorkspaceSearch resolves matching event payloads and disposes listeners", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const disposed: string[] = [];

    const listen: WorkspaceListen = async (eventName, handler) => {
      handlers.set(eventName, handler as (event: { payload: unknown }) => void);
      return () => {
        disposed.push(eventName);
      };
    };

    const backendResult: BackendSearchResult = {
      searchId: "search-1",
      path: "E:\\Workspace\\report.txt",
      name: "report.txt",
      parent: "E:\\Workspace",
      isDirectory: false,
      matchedOn: ["name"],
      excerpt: "report"
    };

    const resultsPromise = runWorkspaceSearch(
      createWorkspaceSearchQuery({ name: "report" }),
      ["E:\\Workspace"],
      [],
      {
        createSearchId: () => "search-1",
        listen,
        invoke: async <T>(command: string, args: Record<string, unknown>) => {
          assert.equal(command, "start_search");
          assert.deepEqual(args, {
            query: createBackendSearchQuery("search-1", ["E:\\Workspace"], {
              ...createWorkspaceSearchQuery({ name: "report" })
            })
          });

          handlers.get("search_result")?.({
            payload: {
              ...backendResult,
              searchId: "other-search"
            }
          });
          handlers.get("search_result")?.({ payload: backendResult });
          handlers.get("search_finished")?.({
            payload: {
              searchId: "search-1",
              cancelled: false,
              scannedEntries: 1,
              matchedEntries: 1
            }
          });
          return { searchId: "search-1" } as T;
        }
      }
    );

    const results = await resultsPromise;
    assert.equal(results.length, 1);
    assert.equal(results[0].path, "E:\\Workspace\\report.txt");
    assert.deepEqual(disposed.sort(), ["search_failed", "search_finished", "search_progress", "search_result"]);
  });

  await assertAsyncTest("runWorkspaceSearch forwards progress and finished payloads for the active search id", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const progressEvents: Array<{
      searchId?: string;
      scannedEntries: number;
      matchedEntries: number;
      cancelled: boolean;
      statusText: string;
    }> = [];

    const listen: WorkspaceListen = async (eventName, handler) => {
      handlers.set(eventName, handler as (event: { payload: unknown }) => void);
      return () => undefined;
    };

    const resultsPromise = runWorkspaceSearch(
      {
        ...createWorkspaceSearchQuery({
          content: "error",
          contentMode: "wildcard",
          caseSensitive: true
        })
      },
      ["E:\\Workspace"],
      [],
      {
        createSearchId: () => "search-2",
        listen,
        onProgress: (progress) => {
          progressEvents.push(progress);
        },
        invoke: async <T>() => {
          handlers.get("search_progress")?.({
            payload: {
              searchId: "other-search",
              scannedEntries: 10,
              matchedEntries: 1
            }
          });
          handlers.get("search_progress")?.({
            payload: {
              searchId: "search-2",
              scannedEntries: 200,
              matchedEntries: 3
            }
          });
          handlers.get("search_finished")?.({
            payload: {
              searchId: "search-2",
              cancelled: false,
              scannedEntries: 240,
              matchedEntries: 4
            }
          });
          return { searchId: "search-2" } as T;
        }
      }
    );

    await resultsPromise;
    assert.deepEqual(progressEvents, [
      {
        searchId: "search-2",
        scannedEntries: 200,
        matchedEntries: 3,
        cancelled: false,
        statusText: "已扫描 200 项，匹配 3 项"
      },
      {
        searchId: "search-2",
        scannedEntries: 240,
        matchedEntries: 4,
        cancelled: false,
        statusText: "搜索完成：已扫描 240 项，匹配 4 项"
      }
    ]);
  });
})();
