import type { RefObject } from "react";

export type ColumnPointerDropTarget<T extends string = string> = {
  targetElement: HTMLElement;
  targetId: T;
  placement: "before" | "after";
};

export type ColumnDragFollower = {
  visible: boolean;
  x: number;
  y: number;
  label: string;
};

export type ColumnDropIndicator<T extends string = string> = {
  targetId: T;
  placement: "before" | "after";
};

export const EMPTY_COLUMN_DRAG_FOLLOWER: ColumnDragFollower = {
  visible: false,
  x: 0,
  y: 0,
  label: ""
};

export function getColumnPointerDropTarget<T extends string>(
  element: Element | null,
  clientX: number,
  sourceId: T
): ColumnPointerDropTarget<T> | null {
  const targetElement = element?.closest("[data-column-id]") as HTMLElement | null;
  const targetId = targetElement?.dataset.columnId as T | undefined;
  if (!targetElement || !targetId || targetId === sourceId) {
    return null;
  }

  const rect = targetElement.getBoundingClientRect();
  return {
    targetElement,
    targetId,
    placement: clientX < rect.left + rect.width / 2 ? "before" : "after"
  };
}

function getColumnDropIndicatorLeft(header: HTMLElement, indicator: ColumnDropIndicator) {
  const targetElement = header.querySelector<HTMLElement>(`[data-column-id="${indicator.targetId}"]`);
  if (!targetElement) {
    return "0px";
  }

  const headerRect = header.getBoundingClientRect();
  const columns = Array.from(header.querySelectorAll<HTMLElement>("[data-column-id]"));
  const targetIndex = columns.indexOf(targetElement);
  const boundaryElement =
    indicator.placement === "before" && targetIndex > 0 ? columns[targetIndex - 1] : targetElement;
  const targetRect = targetElement.getBoundingClientRect();
  const boundaryRect = boundaryElement.getBoundingClientRect();
  const left =
    indicator.placement === "before" && targetIndex > 0
      ? boundaryRect.right - headerRect.left
      : indicator.placement === "before"
        ? targetRect.left - headerRect.left
        : targetRect.right - headerRect.left;
  return `${Math.round(left)}px`;
}

export function ColumnDropIndicatorView({
  headerRef,
  indicator,
  className = "file-listing__column-drop-indicator"
}: {
  headerRef: RefObject<HTMLDivElement | null>;
  indicator: ColumnDropIndicator | null;
  className?: string;
}) {
  if (!indicator || !headerRef.current) {
    return null;
  }

  return (
    <div
      className={`details-column-drop-indicator ${className}`}
      style={{
        left: getColumnDropIndicatorLeft(headerRef.current, indicator)
      }}
    />
  );
}

export function ColumnDragFollowerView({ follower }: { follower: ColumnDragFollower }) {
  if (!follower.visible) {
    return null;
  }

  return (
    <div
      className="column-drag-follower"
      style={{
        left: follower.x,
        top: follower.y
      }}
    >
      <div className="column-drag-follower__content">
        <span className="column-drag-follower__title">{follower.label}</span>
      </div>
    </div>
  );
}
