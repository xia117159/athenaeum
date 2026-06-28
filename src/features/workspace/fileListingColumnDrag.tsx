import type { RefObject } from "react";
import type { ColumnId } from "./types";

export type ColumnPointerDropTarget = {
  targetElement: HTMLElement;
  targetId: ColumnId;
  placement: "before" | "after";
};

export type ColumnDragFollower = {
  visible: boolean;
  x: number;
  y: number;
  label: string;
};

export type ColumnDropIndicator = {
  targetId: ColumnId;
  placement: "before" | "after";
};

export const EMPTY_COLUMN_DRAG_FOLLOWER: ColumnDragFollower = {
  visible: false,
  x: 0,
  y: 0,
  label: ""
};

export function getColumnPointerDropTarget(element: Element | null, clientX: number, sourceId: ColumnId): ColumnPointerDropTarget | null {
  const targetElement = element?.closest("[data-column-id]") as HTMLElement | null;
  const targetId = targetElement?.dataset.columnId as ColumnId | undefined;
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
  indicator
}: {
  headerRef: RefObject<HTMLDivElement | null>;
  indicator: ColumnDropIndicator | null;
}) {
  if (!indicator || !headerRef.current) {
    return null;
  }

  return (
    <div
      className="file-listing__column-drop-indicator"
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
