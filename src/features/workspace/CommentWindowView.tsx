import { useEffect, useMemo, useState } from "react";
import { getWorkspaceEntryComment, saveWorkspaceEntryComment } from "./workspaceSettingsGateway";
import type { EntryKind } from "./types";

type CommentWindowParams = {
  path: string;
  name: string;
  kind: EntryKind;
};

function getNameFromPath(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function getCommentWindowParams(): CommentWindowParams {
  if (typeof window === "undefined") {
    return {
      path: "",
      name: "",
      kind: "file"
    };
  }

  const params = new URLSearchParams(window.location.search);
  const path = params.get("path") ?? "";
  const name = params.get("name") || getNameFromPath(path);
  const kind = params.get("kind") === "folder" ? "folder" : "file";
  return { path, name, kind };
}

async function closeCommentWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return;
  } catch {
    // Browser fallback for local component development and tests.
  }

  try {
    window.close();
  } catch {
    // Closing a browser fallback window is best-effort.
  }
}

async function notifyEntryMetadataChanged(path: string) {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("entry_metadata_changed", [path]);
  } catch {
    // Browser fallback for local component development and tests.
  }

  const event = new window.CustomEvent("entry_metadata_changed", { detail: [path] });
  window.dispatchEvent(event);
  window.opener?.dispatchEvent(event);
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

export function CommentWindowView() {
  const params = useMemo(() => getCommentWindowParams(), []);
  const [draft, setDraft] = useState("");
  const [initialComment, setInitialComment] = useState("");
  const [loading, setLoading] = useState(Boolean(params.path));
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!params.path) {
      setDraft("");
      setInitialComment("");
      setLoading(false);
      return;
    }

    let disposed = false;
    setLoading(true);
    void getWorkspaceEntryComment(params.path)
      .then((comment) => {
        if (!disposed) {
          const loadedComment = comment ?? "";
          setDraft(loadedComment);
          setInitialComment(loadedComment);
          setErrorMessage(null);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setErrorMessage(getErrorMessage(error, "无法读取注释"));
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [params.path]);

  const handleConfirm = async () => {
    if (!params.path || saving) {
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    try {
      await saveWorkspaceEntryComment(params.path, draft);
      await notifyEntryMetadataChanged(params.path);
      await closeCommentWindow();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "无法保存注释"));
    } finally {
      setSaving(false);
    }
  };

  const handleDraftChange = (event: { currentTarget: HTMLTextAreaElement }) => {
    setDraft(event.currentTarget.value);
  };

  const handleCancel = async () => {
    if (saving) {
      return;
    }
    if (draft !== initialComment) {
      const confirmed = typeof window === "undefined" ? true : window.confirm("未保存的更改将丢失，确定取消？");
      if (!confirmed) {
        return;
      }
    }
    await closeCommentWindow();
  };

  const disabled = loading || saving || !params.path;

  return (
    <section className="comment-window" aria-labelledby="comment-window-title" aria-busy={disabled ? true : undefined}>
      <header className="comment-window__header">
        <h2 id="comment-window-title">编辑注释</h2>
      </header>

      <main className="comment-window__body">
        <div className="comment-window__field">
          <span>{params.kind === "folder" ? "文件夹名称" : "文件名称"}</span>
          <strong>{params.name || "--"}</strong>
        </div>
        <div className="comment-window__field">
          <span>完整路径</span>
          <code title={params.path}>{params.path || "--"}</code>
        </div>
        <label className="comment-window__editor">
          <span>注释</span>
          <textarea
            value={draft}
            onChange={handleDraftChange}
            onInput={handleDraftChange}
            disabled={disabled}
            autoFocus
          />
        </label>
      </main>

      <footer className="comment-window__footer">
        {errorMessage ? (
          <span className="comment-window__error" role="alert">
            {errorMessage}
          </span>
        ) : null}
        <button type="button" className="toolbar-button toolbar-button--ghost" onClick={() => void handleCancel()} disabled={saving}>
          取消
        </button>
        <button type="button" className="toolbar-button" onClick={() => void handleConfirm()} disabled={disabled}>
          {saving ? "正在保存" : "确认"}
        </button>
      </footer>
    </section>
  );
}
