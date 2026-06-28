import type { Event } from "@tauri-apps/api/event";
import { WebviewWindow as TauriWebviewWindow, type WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { EntryKind } from "./types";

export const COMMENT_WINDOW_LABEL = "comment-editor";

export type CommentWindowRequest = {
  path: string;
  name: string;
  kind: EntryKind;
};

export type CommentWindowHandle = Pick<WebviewWindow, "show" | "setFocus" | "once" | "close">;
export type CommentWindowConstructor = new (label: string, options: CommentWindowOptions) => CommentWindowHandle;

export type CommentWindowOptions = {
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  decorations: boolean;
  focus: boolean;
  center: boolean;
};

export type CommentWindowAdapter = {
  hasTauriRuntime: () => boolean;
  openBrowserWindow: (url: string, target: string, features: string) => void;
  loadWebviewWindow: () => Promise<{
    WebviewWindow: CommentWindowConstructor & {
      getByLabel: (label: string) => Promise<CommentWindowHandle | null>;
    };
  }>;
};

const COMMENT_WINDOW_FEATURES = "width=560,height=420,resizable=yes";

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const defaultCommentWindowAdapter: CommentWindowAdapter = {
  hasTauriRuntime,
  openBrowserWindow(url, target, features) {
    window.open(url, target, features);
  },
  loadWebviewWindow() {
    return Promise.resolve({ WebviewWindow: TauriWebviewWindow });
  }
};

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

export function createCommentWindowUrl(request: CommentWindowRequest) {
  const params = new URLSearchParams({
    view: "comment",
    path: request.path,
    name: request.name,
    kind: request.kind
  });
  return `/?${params.toString()}`;
}

function waitForWindowCreation(windowHandle: CommentWindowHandle) {
  return new Promise<void>((resolve, reject) => {
    void windowHandle.once("tauri://created", () => resolve());
    void windowHandle.once("tauri://error", (event: Event<unknown>) => {
      reject(new Error(`无法打开注释编辑窗口：${toErrorMessage(event.payload)}`));
    });
  });
}

export async function openCommentWindow(
  request: CommentWindowRequest,
  adapter: CommentWindowAdapter = defaultCommentWindowAdapter
) {
  const url = createCommentWindowUrl(request);
  if (!adapter.hasTauriRuntime()) {
    adapter.openBrowserWindow(url, COMMENT_WINDOW_LABEL, COMMENT_WINDOW_FEATURES);
    return;
  }

  const { WebviewWindow } = await adapter.loadWebviewWindow();
  const existingWindow = await WebviewWindow.getByLabel(COMMENT_WINDOW_LABEL);
  if (existingWindow) {
    await existingWindow.close();
  }

  const commentWindow = new WebviewWindow(COMMENT_WINDOW_LABEL, {
    url,
    title: `编辑注释 - ${request.name}`,
    width: 560,
    height: 420,
    minWidth: 480,
    minHeight: 340,
    resizable: true,
    decorations: true,
    focus: true,
    center: true
  });

  await waitForWindowCreation(commentWindow);
}
