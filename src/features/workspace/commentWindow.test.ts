import assert from "node:assert/strict";
import {
  COMMENT_WINDOW_LABEL,
  createCommentWindowUrl,
  openCommentWindow,
  type CommentWindowAdapter,
  type CommentWindowConstructor,
  type CommentWindowHandle,
  type CommentWindowOptions
} from "./commentWindow";

function assertTest(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function createWindowHandle(events: string[], rejectCreated = false): CommentWindowHandle {
  return {
    async show() {
      events.push("show");
    },
    async setFocus() {
      events.push("setFocus");
    },
    async close() {
      events.push("close");
    },
    async once(event, handler) {
      events.push(`once:${event}`);
      if (event === "tauri://created" && !rejectCreated) {
        queueMicrotask(() => handler({ event, id: 1, payload: undefined } as Parameters<typeof handler>[0]));
      }
      if (event === "tauri://error" && rejectCreated) {
        queueMicrotask(() => handler({ event, id: 1, payload: "permission denied" } as Parameters<typeof handler>[0]));
      }
      return () => undefined;
    }
  };
}

function createAdapter({
  existing,
  tauri = true,
  rejectCreated = false,
  createdOptions
}: {
  existing?: CommentWindowHandle | null;
  tauri?: boolean;
  rejectCreated?: boolean;
  createdOptions?: CommentWindowOptions[];
}) {
  const events: string[] = [];
  const browserOpens: Array<{ url: string; target: string; features: string }> = [];
  const adapter: CommentWindowAdapter = {
    hasTauriRuntime: () => tauri,
    openBrowserWindow(url, target, features) {
      browserOpens.push({ url, target, features });
    },
    async loadWebviewWindow() {
      const Constructor = function WebviewWindow(label: string, options: CommentWindowOptions) {
        events.push(`create:${label}`);
        createdOptions?.push(options);
        return createWindowHandle(events, rejectCreated);
      } as unknown as CommentWindowConstructor & {
        getByLabel: (label: string) => Promise<CommentWindowHandle | null>;
      };
      Constructor.getByLabel = async (label: string) => {
        events.push(`getByLabel:${label}`);
        return existing ?? null;
      };
      return { WebviewWindow: Constructor };
    }
  };

  return { adapter, events, browserOpens };
}

const request = {
  path: "D:\\Projects\\report.txt",
  name: "report.txt",
  kind: "file" as const
};

export const completion = (async () => {
  await assertTest("createCommentWindowUrl encodes the edited item identity", () => {
    const url = createCommentWindowUrl(request);

    assert.equal(url.startsWith("/?"), true);
    const params = new URLSearchParams(url.slice(2));
    assert.equal(params.get("view"), "comment");
    assert.equal(params.get("path"), request.path);
    assert.equal(params.get("name"), request.name);
    assert.equal(params.get("kind"), request.kind);
  });

  await assertTest("openCommentWindow recreates the single comment editor with the requested item", async () => {
    const existingEvents: string[] = [];
    const existing = createWindowHandle(existingEvents);
    const createdOptions: CommentWindowOptions[] = [];
    const { adapter, events } = createAdapter({ existing, createdOptions });

    await openCommentWindow(request, adapter);

    assert.deepEqual(events, [
      `getByLabel:${COMMENT_WINDOW_LABEL}`,
      `create:${COMMENT_WINDOW_LABEL}`,
      "once:tauri://created",
      "once:tauri://error"
    ]);
    assert.deepEqual(existingEvents, ["close"]);
    assert.equal(createdOptions[0].url, createCommentWindowUrl(request));
    assert.equal(createdOptions[0].title, "编辑注释 - report.txt");
    assert.equal(createdOptions[0].decorations, true);
  });

  await assertTest("openCommentWindow uses browser fallback outside Tauri", async () => {
    const { adapter, browserOpens } = createAdapter({ tauri: false });

    await openCommentWindow(request, adapter);

    assert.deepEqual(browserOpens, [
      {
        url: createCommentWindowUrl(request),
        target: COMMENT_WINDOW_LABEL,
        features: "width=560,height=420,resizable=yes"
      }
    ]);
  });

  await assertTest("openCommentWindow reports Tauri creation failures", async () => {
    const { adapter } = createAdapter({ rejectCreated: true });

    await assert.rejects(
      () => openCommentWindow(request, adapter),
      (error) => error instanceof Error && error.message.includes("permission denied")
    );
  });
})();
