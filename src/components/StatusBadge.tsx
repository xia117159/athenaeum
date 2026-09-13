import type { CSSProperties } from "react";
import "./status-badge.css";

type StatusBadgeStyle = CSSProperties & {
  "--status-badge-background": string;
  "--status-badge-color": string;
  "--status-badge-size": string;
};

export type StatusBadgeProps = {
  content: string | number;
  backgroundColor?: string;
  color?: string;
  size?: number;
  ariaLabel?: string;
  className?: string;
};

function normalizeSize(size?: number) {
  if (!Number.isFinite(size)) {
    return 16;
  }
  return Math.min(32, Math.max(12, Math.round(size!)));
}

export function StatusBadge({
  content,
  backgroundColor = "#5c5c5c",
  color = "#ffffff",
  size,
  ariaLabel,
  className
}: StatusBadgeProps) {
  const style: StatusBadgeStyle = {
    "--status-badge-background": backgroundColor,
    "--status-badge-color": color,
    "--status-badge-size": `${normalizeSize(size)}px`
  };

  return (
    <span
      className={`status-badge${className ? ` ${className}` : ""}`}
      style={style}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : "true"}
    >
      {content}
    </span>
  );
}
