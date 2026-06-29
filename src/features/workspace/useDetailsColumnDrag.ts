import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import {
  EMPTY_COLUMN_DRAG_FOLLOWER,
  getColumnPointerDropTarget,
  type ColumnDragFollower,
  type ColumnDropIndicator
} from "./fileListingColumnDrag";

type DetailsDragColumn<T extends string> = {
  id: T;
};

type ActiveColumnPointerDrag<T extends string> = {
  sourceId: T;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

const COLUMN_POINTER_DRAG_THRESHOLD_PX = 4;

function getElementFromPoint(clientX: number, clientY: number) {
  return typeof document.elementFromPoint === "function" ? document.elementFromPoint(clientX, clientY) : null;
}

export function useDetailsColumnDrag<T extends string, C extends DetailsDragColumn<T>>({
  onMoveColumn,
  getColumnLabel,
  resizerSelector
}: {
  onMoveColumn?: (sourceId: T, targetId: T, placement: "before" | "after") => void;
  getColumnLabel: (column: C) => string;
  resizerSelector: string;
}) {
  const [columnDragFollower, setColumnDragFollower] = useState<ColumnDragFollower>(EMPTY_COLUMN_DRAG_FOLLOWER);
  const [columnDropIndicator, setColumnDropIndicator] = useState<ColumnDropIndicator<T> | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const activeDragRef = useRef<ActiveColumnPointerDrag<T> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressNextClickRef = useRef<T | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const consumeSuppressedClick = (columnId: T, event: ReactMouseEvent<HTMLElement>) => {
    if (suppressNextClickRef.current !== columnId) {
      return false;
    }
    suppressNextClickRef.current = null;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const startColumnPointerDrag = (event: ReactPointerEvent<HTMLElement>, column: C) => {
    if (event.button !== 0 || !onMoveColumn) {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest(resizerSelector)) {
      return;
    }

    cleanupRef.current?.();
    const pointerDrag: ActiveColumnPointerDrag<T> = {
      sourceId: column.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };
    activeDragRef.current = pointerDrag;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      cleanupRef.current = null;
      document.body.classList.remove("is-column-pointer-dragging");
      setColumnDragFollower(EMPTY_COLUMN_DRAG_FOLLOWER);
      setColumnDropIndicator(null);
    };

    const finishDrag = (finishEvent: PointerEvent) => {
      const activeDrag = activeDragRef.current;
      cleanup();
      activeDragRef.current = null;
      if (!activeDrag || finishEvent.pointerId !== activeDrag.pointerId || !activeDrag.dragging) {
        return;
      }

      finishEvent.preventDefault();
      suppressNextClickRef.current = activeDrag.sourceId;
      window.setTimeout(() => {
        if (suppressNextClickRef.current === activeDrag.sourceId) {
          suppressNextClickRef.current = null;
        }
      }, 0);

      const dropTarget = getColumnPointerDropTarget(getElementFromPoint(finishEvent.clientX, finishEvent.clientY), finishEvent.clientX, activeDrag.sourceId);
      if (dropTarget) {
        onMoveColumn(activeDrag.sourceId, dropTarget.targetId, dropTarget.placement);
      }
    };

    function handlePointerMove(moveEvent: PointerEvent) {
      const activeDrag = activeDragRef.current;
      if (!activeDrag || moveEvent.pointerId !== activeDrag.pointerId) {
        return;
      }

      const deltaX = moveEvent.clientX - activeDrag.startX;
      const deltaY = moveEvent.clientY - activeDrag.startY;
      if (!activeDrag.dragging && Math.hypot(deltaX, deltaY) < COLUMN_POINTER_DRAG_THRESHOLD_PX) {
        return;
      }
      if (!activeDrag.dragging) {
        activeDrag.dragging = true;
        setColumnDragFollower({ visible: true, x: moveEvent.clientX, y: moveEvent.clientY, label: getColumnLabel(column) });
      }
      document.body.classList.add("is-column-pointer-dragging");
      moveEvent.preventDefault();
      setColumnDragFollower((previous) => ({ ...previous, x: moveEvent.clientX, y: moveEvent.clientY }));

      const dropTarget = getColumnPointerDropTarget(getElementFromPoint(moveEvent.clientX, moveEvent.clientY), moveEvent.clientX, activeDrag.sourceId);
      setColumnDropIndicator(dropTarget ? { targetId: dropTarget.targetId, placement: dropTarget.placement } : null);
    }

    function handlePointerUp(upEvent: PointerEvent) {
      finishDrag(upEvent);
    }

    function handlePointerCancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId === pointerDrag.pointerId) {
        cleanup();
        activeDragRef.current = null;
      }
    }

    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return {
    columnDragFollower,
    columnDropIndicator,
    consumeSuppressedClick,
    headerRef,
    startColumnPointerDrag
  };
}
