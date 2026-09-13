import { WorkspaceView } from "../features/workspace/WorkspaceView";
import { SettingsWindowView } from "../features/workspace/SettingsWindowView";
import { CommentWindowView } from "../features/workspace/CommentWindowView";
import { AboutWindowView } from "../features/workspace/AboutWindowView";
import { OperationHistoryWindowView } from "../features/workspace/OperationHistoryWindowView";
import { ColorFilterHelpWindowView } from "../features/workspace/ColorFilterHelpWindowView";
import { BatchRenameHelpWindowView } from "../features/workspace/BatchRenameHelpWindowView";

function getAppView() {
  if (typeof window === "undefined") {
    return "workspace";
  }
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "settings" || view === "comment" || view === "about" || view === "operation-history" || view === "color-filter-help" || view === "batch-rename-help" ? view : "workspace";
}

export function AppShell() {
  const view = getAppView();
  if (view === "batch-rename-help") return <BatchRenameHelpWindowView />;

  if (view === "settings") {
    return <SettingsWindowView />;
  }

  if (view === "comment") {
    return <CommentWindowView />;
  }

  if (view === "about") {
    return <AboutWindowView />;
  }

  if (view === "operation-history") {
    return <OperationHistoryWindowView />;
  }

  if (view === "color-filter-help") {
    return <ColorFilterHelpWindowView />;
  }

  return <WorkspaceView />;
}
