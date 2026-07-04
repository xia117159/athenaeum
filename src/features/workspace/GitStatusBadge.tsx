import { memo } from "react";
import type { GitFileStatus } from "./types";

const BADGE_COLORS: Record<GitFileStatus, string> = {
  modified: "#da3633",
  added: "#2ea043",
  deleted: "#da3633",
  renamed: "#2ea043",
  untracked: "#388bfd",
  conflict: "#e8922a",
  clean: "#2ea043"
};

const BADGE_SYMBOLS: Record<GitFileStatus, string> = {
  modified: "!",
  added: "+",
  deleted: "−",
  renamed: "R",
  untracked: "?",
  conflict: "!",
  clean: "✓"
};

export const GitStatusBadge = memo(function GitStatusBadge({ status }: { status: GitFileStatus }) {
  const color = BADGE_COLORS[status];
  const symbol = BADGE_SYMBOLS[status];

  return (
    <svg
      className="git-status-badge"
      viewBox="0 0 16 16"
      focusable="false"
      aria-label={`git ${status}`}
    >
      <circle cx="8" cy="8" r="7" fill={color} />
      <text
        x="8"
        y="8"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffffff"
        fontSize="10"
        fontWeight="bold"
        fontFamily="Segoe UI, sans-serif"
      >
        {symbol}
      </text>
    </svg>
  );
});
