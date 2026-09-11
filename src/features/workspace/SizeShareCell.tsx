import type { EntryViewModel } from "./types";
import type { CSSProperties } from "react";

export function SizeShareCell({ entry }: { entry: EntryViewModel }) {
  const display = entry.sizeDisplay;
  if (!display) return entry.sizeLabel;
  const share = display.share;
  return <span className="size-share-value" data-size-state={display.state} title={display.title}>
    {display.label}
    {share !== null && Number.isFinite(share) && share >= 0 && share <= 1 ? (
      <span className="size-share-track" aria-hidden="true">
        <span className="size-share-bar" style={{ "--size-share": `${share * 100}%` } as CSSProperties} />
      </span>
    ) : null}
  </span>;
}
