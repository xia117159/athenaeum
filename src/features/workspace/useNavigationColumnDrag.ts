import type { NavigationColumnDefinition, NavigationColumnId } from "./types";
import { useDetailsColumnDrag } from "./useDetailsColumnDrag";

export function useNavigationColumnDrag(
  onMoveColumn: (sourceId: NavigationColumnId, targetId: NavigationColumnId, placement: "before" | "after") => void
) {
  const detailsColumnDrag = useDetailsColumnDrag<NavigationColumnId, NavigationColumnDefinition>({
    onMoveColumn,
    getColumnLabel: (column) => column.label,
    resizerSelector: ".navigation-header-resizer"
  });

  return {
    ...detailsColumnDrag,
    navigationHeaderRef: detailsColumnDrag.headerRef
  };
}
