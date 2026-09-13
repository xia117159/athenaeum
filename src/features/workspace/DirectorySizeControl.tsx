import type { DirectorySizeTabState } from "./directorySizeTypes";
import type { DirectorySnapshot } from "./types";
import { useEffect, useState, type SyntheticEvent } from "react";
import { Calculator, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { decimalBytes, formatDirectoryBytes } from "./directorySizes";

const stop = (event: SyntheticEvent) => event.stopPropagation();

export function DirectorySizeControl({ statistics, locationKind, onAction }: {
  statistics?: DirectorySizeTabState; locationKind: DirectorySnapshot["location"]["kind"]; onAction: (intent: "calculate" | "cancel") => void;
}) {
  const snapshot = statistics?.snapshot;
  const busy = statistics?.pending === true || snapshot?.phase === "queued" || snapshot?.phase === "scanning";
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    setDelayed(false);
    if (!busy) return;
    const timer = window.setTimeout(() => setDelayed(true), 200);
    return () => window.clearTimeout(timer);
  }, [busy, statistics?.requestVersion, snapshot?.generation]);
  const loading = busy && delayed;
  const failed = snapshot?.phase === "failed";
  const action = busy ? "cancel" : "calculate";
  const label = busy ? "取消大小计算" : snapshot || statistics?.manualStarted ? "重新计算目录大小" : "计算目录大小";
  const total = decimalBytes(snapshot?.totalBytes);
  const context = locationKind === "ftp"
    ? "FTP 手动计算，依据服务器元数据的时间点快照；跳过可识别的链接，未标识的链接目标可能被计入。"
    : locationKind === "sftp" ? "SFTP 手动递归计算，跳过链接，结果为时间点快照。" : "包含隐藏文件，跳过链接，不读取文件内容。";
  const phaseText = { queued: "等待计算", scanning: "正在计算", complete: "计算完成", partial: "统计不完整",
    stale: "统计已过期", cancelled: "计算已取消", failed: "计算失败" };
  const status = snapshot ? `${phaseText[snapshot.phase]}${total !== null ? `，总大小 ${formatDirectoryBytes(total)}` : ""}；` +
    `${snapshot.files} 个文件、${snapshot.directories} 个目录；跳过 ${snapshot.skippedLinks} 个链接、${snapshot.skippedSpecial} 个特殊条目。${snapshot.reason ?? ""}` : "";
  const Icon = failed || snapshot?.phase === "partial" ? TriangleAlert : loading ? Square : snapshot && !busy ? RefreshCw : Calculator;
  return <span className={`directory-size-control${loading ? " is-loading" : ""}${failed ? " is-error" : ""}`}
    onPointerDown={stop} onMouseDown={stop} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <button type="button" aria-label={label} title={`${label}。${context}${busy && !loading ? "" : status}`}
      onClick={(event) => { event.stopPropagation(); onAction(action); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!event.repeat) onAction(action); }
      }} onKeyUp={stop}>
      <Icon size={13} aria-hidden="true" />
    </button>
    {loading ? <span className="directory-size-control__status" role="status">正在计算目录大小…</span> : null}
  </span>;
}
