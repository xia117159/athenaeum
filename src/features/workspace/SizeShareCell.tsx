import type { EntryViewModel } from "./types";
import type { CSSProperties } from "react";
import { sizeShareTextTone } from "./sizeShareContrast";

export function SizeShareCell({ entry, sizeBarLow, sizeBarHigh }: { entry: EntryViewModel; sizeBarLow?: string; sizeBarHigh?: string }) {
  const display = entry.sizeDisplay;
  if (!display) return <span className="size-share-value">{entry.sizeLabel}</span>;
  const share = display.share;
  const tone = share !== null && Number.isFinite(share) ? sizeShareTextTone(sizeBarLow, sizeBarHigh, share) : "dark";
  return <span className="size-share-value" data-size-state={display.state} title={display.title}>
    <span className="size-share-label">{display.label}</span>
    {share !== null && Number.isFinite(share) && share >= 0 && share <= 1 ? (
      <span className="size-share-track" aria-hidden="true">
        <span className="size-share-bar" style={{ "--size-share": `${share * 100}%` } as CSSProperties} />
        <span className={`size-share-label--fill size-share-label--fill-${tone}`} data-label={display.label} style={{ "--size-share": `${share * 100}%` } as CSSProperties} />
      </span>
    ) : null}
  </span>;
}
