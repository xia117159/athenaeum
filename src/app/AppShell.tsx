import { WorkspaceView } from "../features/workspace/WorkspaceView";
import { SettingsWindowView } from "../features/workspace/SettingsWindowView";
import { CommentWindowView } from "../features/workspace/CommentWindowView";
import { AboutWindowView } from "../features/workspace/AboutWindowView";

function getAppView() {
  if (typeof window === "undefined") {
    return "workspace";
  }
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "settings" || view === "comment" || view === "about" ? view : "workspace";
}

export function AppShell() {
  const view = getAppView();

  if (view === "settings") {
    return <SettingsWindowView />;
  }

  if (view === "comment") {
    return <CommentWindowView />;
  }

  if (view === "about") {
    return <AboutWindowView />;
  }

  return <WorkspaceView />;
}
