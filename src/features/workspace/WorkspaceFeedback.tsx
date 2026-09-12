import type { NotificationItem } from "./types";
import type { PendingFileOpen } from "./fileOpeningState";
import { X } from "lucide-react";
import "./file-opening.css";

export interface WorkspaceFeedbackProps {
  notifications: NotificationItem[];
  fileOpens: PendingFileOpen[];
  onCancelOpen: (requestId: string) => void;
  onDismiss: (id: string) => void;
}
function downloadedSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function WorkspaceFeedback({ notifications, fileOpens, onCancelOpen, onDismiss }: WorkspaceFeedbackProps) {
  if (!notifications.length && !fileOpens.length) return null;
  return <div className="workspace-notification-stack" role="region" aria-label="通知">
    {fileOpens.map(open => {
      const name = open.path.split(/[\\/]/).at(-1) || open.path;
      const opening = open.progress.phase === "opening";
      const status = opening ? "正在启动程序…" : open.cancelling ? "正在取消…"
        : open.progress.phase === "downloading" ? `正在下载 · ${downloadedSize(open.progress.completedBytes ?? 0)}` : "正在准备…";
      return <div key={open.requestId} className="workspace-notification workspace-file-open" role="status">
        <div className="workspace-file-open__text"><span title={open.path}>{name}</span><span className="workspace-file-open__progress">{status}</span></div>
        <button type="button" className="workspace-file-open__cancel" aria-label={`取消打开 ${name}`}
          disabled={!open.registered || open.cancelling || opening} onClick={() => onCancelOpen(open.requestId)}>取消</button>
      </div>;
    })}
    {notifications.map(notification => <div key={notification.id}
      className={`workspace-notification workspace-notification--${notification.intent}`}
      role={notification.intent === "danger" ? "alert" : "status"}>
      <span>{notification.message}</span>
      <button type="button" className="workspace-notification__close" title="关闭通知" aria-label="关闭通知"
        onClick={() => onDismiss(notification.id)}><X size={12} strokeWidth={2} aria-hidden="true" /></button>
    </div>)}
  </div>;
}
