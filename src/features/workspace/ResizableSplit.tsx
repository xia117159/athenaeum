import {
  Children,
  type CSSProperties,
  useEffect,
  type PointerEvent as ReactPointerEvent,
  type PropsWithChildren,
  useEffectEvent,
  useRef,
  useState
} from "react";

type SplitDirection = "horizontal" | "vertical";

interface ResizableSplitProps extends PropsWithChildren {
  direction: SplitDirection;
  ratio: number;
  min?: number;
  max?: number;
  minSizePx?: number;
  secondMinSizePx?: number;
  maxSizePx?: number;
  handleSize?: number;
  className?: string;
  onRatioChange: (value: number) => void;
}

export function ResizableSplit({
  direction,
  ratio,
  min = 0.2,
  max = 0.8,
  minSizePx,
  secondMinSizePx,
  maxSizePx,
  handleSize = 6,
  className,
  children,
  onRatioChange
}: ResizableSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeDragRef = useRef(false);
  const previewRatioRef = useRef<number | null>(null);
  const [previewRatio, setPreviewRatio] = useState<number | null>(null);
  const childArray = Children.toArray(children);
  const firstChild = childArray[0] ?? null;
  const secondChild = childArray[1] ?? null;

  const setPreviewRatioValue = useEffectEvent((value: number | null) => {
    previewRatioRef.current = value;
    setPreviewRatio((current) => (current === value ? current : value));
  });

  useEffect(() => {
    if (!activeDragRef.current && previewRatio !== null && Math.abs(previewRatio - ratio) <= 0.0001) {
      setPreviewRatioValue(null);
    }
  }, [previewRatio, ratio, setPreviewRatioValue]);

  const computeRatio = useEffectEvent((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }

    const containerSize = direction === "horizontal" ? rect.width : rect.height;
    const availableSize = Math.max(1, containerSize - handleSize);
    const pointerPosition = direction === "horizontal" ? clientX - rect.left : clientY - rect.top;
    const rawRatio = (pointerPosition - handleSize / 2) / availableSize;
    const computedMin = typeof minSizePx === "number" ? Math.max(min, minSizePx / availableSize) : min;
    const computedMax = [
      max,
      typeof maxSizePx === "number" ? maxSizePx / availableSize : max,
      typeof secondMinSizePx === "number" ? 1 - secondMinSizePx / availableSize : max
    ].reduce((current, value) => Math.min(current, value), 1);
    const safeMin = Math.min(computedMin, computedMax);
    const safeMax = Math.max(computedMin, computedMax);
    return Math.min(safeMax, Math.max(safeMin, rawRatio));
  });

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    activeDragRef.current = true;

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextRatio = computeRatio(moveEvent.clientX, moveEvent.clientY);
      if (nextRatio === null) {
        return;
      }
      setPreviewRatioValue(nextRatio);
    };

    const cleanup = (shouldCommit: boolean) => {
      activeDragRef.current = false;
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);

      const finalRatio = previewRatioRef.current;
      if (shouldCommit && finalRatio !== null && Math.abs(finalRatio - ratio) > 0.0001) {
        onRatioChange(finalRatio);
        return;
      }

      if (!shouldCommit || finalRatio === null || Math.abs(finalRatio - ratio) <= 0.0001) {
        setPreviewRatioValue(null);
      }
    };

    const handlePointerUp = () => {
      cleanup(true);
    };

    const handlePointerCancel = () => {
      cleanup(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  };

  const splitStyle = {
    "--split-handle-size": `${handleSize}px`
  } as CSSProperties;

  const displayedRatio = previewRatio ?? ratio;
  const remainingRatio = 1 - displayedRatio;
  const firstBasis = `calc(${displayedRatio * 100}% - ${(displayedRatio * handleSize).toFixed(3)}px)`;
  const secondBasis = `calc(${remainingRatio * 100}% - ${(remainingRatio * handleSize).toFixed(3)}px)`;
  const firstSegmentStyle = {
    flexBasis: firstBasis,
    flexGrow: 0,
    flexShrink: 0
  } satisfies CSSProperties;
  const secondSegmentStyle = {
    flexBasis: secondBasis,
    flexGrow: 0,
    flexShrink: 0
  } satisfies CSSProperties;

  return (
    <div
      ref={containerRef}
      className={`split-pane split-pane--${direction}${className ? ` ${className}` : ""}`}
      style={splitStyle}
    >
      <div className="split-pane__segment" style={firstSegmentStyle}>
        {firstChild}
      </div>
      <div
        className="split-pane__handle"
        data-testid="split-handle"
        role="separator"
        aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
        onPointerDown={handlePointerDown}
      />
      <div className="split-pane__segment split-pane__segment--fill" style={secondSegmentStyle}>
        {secondChild}
      </div>
    </div>
  );
}
