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
  if (getAppView() === "settings") {
    return <SettingsWindowView />;
  }

  if (getAppView() === "comment") {
    return <CommentWindowView />;
  }

  if (getAppView() === "about") {
    return <AboutWindowView />;
  }

  return <WorkspaceView />;
}
