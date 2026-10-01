import type { DirectorySizeTabState } from "./directorySizeTypes";
import type { DirectorySnapshot } from "./types";
import { useEffect, useState, type SyntheticEvent } from "react";
import { Calculator, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { decimalBytes, formatDirectoryBytes } from "./directorySizes";
import { directorySizeBusy, type DirectorySizeAutoBadge } from "./directorySizeMenu";

const stop = (event: SyntheticEvent) => event.stopPropagation();

export function DirectorySizeControl({ statistics, locationKind, onAction, background = false, auto }: {
  statistics?: DirectorySizeTabState; locationKind: DirectorySnapshot["location"]["kind"]; onAction: (intent: "calculate" | "cancel") => void;
  background?: boolean;
  /** Automatic directories show a badge and no button (D2, E3). */
  auto?: DirectorySizeAutoBadge;
}) {
  const snapshot = statistics?.snapshot;
  const busy = directorySizeBusy(statistics);
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    setDelayed(false);
    if (!busy) return;
    const timer = window.setTimeout(() => setDelayed(true), 200);
    return () => window.clearTimeout(timer);
  }, [busy, statistics?.requestVersion, snapshot?.generation]);
  const loading = busy && delayed;
  const failed = snapshot?.phase === "failed" || auto?.failed !== undefined;
  // Only a real content change is worded as one; leaving the view or a lost watcher keep the snapshot's reason (§6.4).
  const invalidated = snapshot?.invalidated === true;
  const action = busy ? "cancel" : "calculate";
  const label = busy ? "取消大小计算" : snapshot || statistics?.manualStarted ? "重新计算目录大小" : "计算目录大小";
  const total = decimalBytes(snapshot?.totalBytes);
  const context = locationKind === "ftp"
    ? "FTP 手动计算，依据服务器元数据的时间点快照；跳过可识别的链接，未标识的链接目标可能被计入。"
    : locationKind === "sftp" ? "SFTP 手动递归计算，跳过链接，结果为时间点快照。" : "包含隐藏文件，跳过链接，不读取文件内容。";
  const phaseText = { queued: "等待计算", scanning: "正在计算", complete: "计算完成", partial: "统计不完整",
    stale: "统计已过期", cancelled: "计算已取消", failed: "计算失败" };
  const phaseLabel = snapshot && invalidated && !auto ? "统计已过期（目录内容已变化），可重新计算" : snapshot ? phaseText[snapshot.phase] : "";
  const status = snapshot ? `${phaseLabel}${total !== null ? `，总大小 ${formatDirectoryBytes(total)}` : ""}；` +
    `${snapshot.files} 个文件、${snapshot.directories} 个目录；跳过 ${snapshot.skippedLinks} 个链接、${snapshot.skippedSpecial} 个特殊条目。${snapshot.reason ?? ""}` : "";
  const Icon = failed || snapshot?.phase === "partial" && !invalidated ? TriangleAlert : loading ? Square : snapshot && !busy ? RefreshCw : Calculator;
  const autoTitle = auto ? `自动计算文件夹大小已启用${auto.inherited ? `（继承自 ${auto.root}）` : ""}，包含所有子文件夹。${busy && !loading ? "" : status}` +
    (auto.failed !== undefined ? `自动计算失败：${auto.failed}。可在表头右键菜单或“查看”菜单中选择“重试自动计算”。` : "") : "";
  return <span className={`directory-size-control${loading ? " is-loading" : ""}${failed ? " is-error" : ""}`}
    onPointerDown={stop} onMouseDown={stop} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    {auto ? <span className="directory-size-control__auto" role="img" aria-label={autoTitle} title={autoTitle}>自动</span> :
    <button type="button" aria-label={label} title={`${label}。${context}${busy && !loading ? "" : status}`}
      onClick={(event) => { event.stopPropagation(); onAction(action); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!event.repeat) onAction(action); }
      }} onKeyUp={stop}>
      <Icon size={13} aria-hidden="true" />
    </button>}
    {loading && !background ? <span className="directory-size-control__status" role="status">正在计算目录大小…</span> : null}
  </span>;
}
