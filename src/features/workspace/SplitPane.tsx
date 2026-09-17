import {
  Children,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from "react";
import {
  Group,
  type Layout,
  type LayoutChangedMeta,
  Panel,
  Separator,
  useGroupRef
} from "react-resizable-panels";

type SplitDirection = "horizontal" | "vertical";

interface SplitPaneProps {
  direction: SplitDirection;
  /** Share of the container taken by the first pane, 0..1. */
  ratio: number;
  /** Fractional floor/ceiling for the first pane; combined with the pixel floors below. */
  min?: number;
  max?: number;
  /** Pixel floor for the first pane. */
  minSizePx?: number;
  /** Pixel floor for the second pane; caps how far the first pane can grow. */
  secondMinSizePx?: number;
  handleSize?: number;
  className?: string;
  onRatioChange: (value: number) => void;
  children?: ReactNode;
}

export interface SplitConstraintInput {
  /** Size of the split axis in pixels, excluding the handle. Zero until the group has been measured. */
  availableSize: number;
  min: number;
  max: number;
  minSizePx?: number;
  secondMinSizePx?: number;
}

export interface SplitConstraints {
  firstMinSize: number | string;
  firstMaxSize: number | string;
  secondMinSize: number | string | undefined;
}

function toPercentage(fraction: number) {
  return `${fraction * 100}%`;
}

/**
 * react-resizable-panels accepts a single min/max per panel, expressed either as
 * pixels or as a percentage. The workspace declares both (a fractional band for
 * the ratio plus pixel floors so panes stay usable), so translate them into the
 * stricter pixel bound once the group size is known. Before measurement, fall
 * back to the fractional bounds and let the library convert the pixel floors.
 */
export function resolveSplitConstraints({
  availableSize,
  min,
  max,
  minSizePx,
  secondMinSizePx
}: SplitConstraintInput): SplitConstraints {
  if (availableSize <= 0) {
    return {
      firstMinSize: minSizePx ?? toPercentage(min),
      firstMaxSize: toPercentage(max),
      secondMinSize: secondMinSizePx
    };
  }

  const floor = Math.max(min * availableSize, minSizePx ?? 0);
  const ceiling = Math.min(max * availableSize, availableSize - (secondMinSizePx ?? 0));
  return {
    firstMinSize: floor,
    firstMaxSize: Math.max(floor, ceiling),
    secondMinSize: secondMinSizePx
  };
}

/**
 * Read the ratio the workspace should adopt from a group layout change.
 * Returns null when the change was not caused by the user (mount, group resize,
 * a programmatic setLayout), so only real divider moves reach the reducer.
 */
export function readCommittedRatio(
  layout: Layout,
  firstPanelId: string,
  meta: LayoutChangedMeta
): number | null {
  if (!meta.isUserInteraction) {
    return null;
  }
  const percentage = layout[firstPanelId];
  return typeof percentage === "number" ? percentage / 100 : null;
}

export function SplitPane({
  direction,
  ratio,
  min = 0.2,
  max = 0.8,
  minSizePx,
  secondMinSizePx,
  handleSize = 4,
  className,
  onRatioChange,
  children
}: SplitPaneProps) {
  const groupRef = useGroupRef();
  const groupId = useId();
  const firstPanelId = `${groupId}first`;
  const secondPanelId = `${groupId}second`;
  const committedRatioRef = useRef(ratio);
  const [availableSize, setAvailableSize] = useState(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const attachGroupElement = useCallback(
    (element: HTMLDivElement | null) => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (!element) {
        return;
      }

      const update = () => {
        const size = direction === "horizontal" ? element.clientWidth : element.clientHeight;
        const next = Math.max(0, size - handleSize);
        setAvailableSize((current) => (current === next ? current : next));
      };

      update();
      if (typeof ResizeObserver === "undefined") {
        return;
      }

      const observer = new ResizeObserver(update);
      observer.observe(element);
      resizeObserverRef.current = observer;
    },
    [direction, handleSize]
  );

  // Track every layout the library reports, not just user ones: the sync effect
  // below compares the ratio prop against this ref, so a group resize that moved
  // the divider must not look like an external change and get pushed back.
  const handleLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    committedRatioRef.current = (layout[firstPanelId] ?? 0) / 100;
    const committed = readCommittedRatio(layout, firstPanelId, meta);
    if (committed !== null) {
      onRatioChange(committed);
    }
  };

  // The ratio prop stays authoritative: any change that the divider did not cause
  // itself (bootstrap restore, a clamped commit, a future reset action) is pushed
  // back into the library instead of being ignored.
  useEffect(() => {
    if (Math.abs(ratio - committedRatioRef.current) <= 0.0001) {
      return;
    }
    committedRatioRef.current = ratio;
    groupRef.current?.setLayout({
      [firstPanelId]: ratio * 100,
      [secondPanelId]: (1 - ratio) * 100
    });
  }, [ratio, firstPanelId, secondPanelId, groupRef]);

  const childArray = Children.toArray(children);
  const firstChild = childArray[0] ?? null;
  const secondChild = childArray[1] ?? null;
  const constraints = resolveSplitConstraints({
    availableSize,
    min,
    max,
    minSizePx,
    secondMinSizePx
  });

  return (
    <Group
      className={`split-group split-group--${direction}${className ? ` ${className}` : ""}`}
      orientation={direction}
      defaultLayout={{
        [firstPanelId]: ratio * 100,
        [secondPanelId]: (1 - ratio) * 100
      }}
      onLayoutChanged={handleLayoutChanged}
      groupRef={groupRef}
      elementRef={attachGroupElement}
    >
      <Panel id={firstPanelId} minSize={constraints.firstMinSize} maxSize={constraints.firstMaxSize}>
        <div className="split-group__pane">{firstChild}</div>
      </Panel>
      <Separator
        className="split-group__handle"
        style={{ "--split-handle-size": `${handleSize}px` } as CSSProperties}
      />
      <Panel id={secondPanelId} minSize={constraints.secondMinSize}>
        <div className="split-group__pane">{secondChild}</div>
      </Panel>
    </Group>
  );
}
