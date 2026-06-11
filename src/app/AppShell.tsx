import { WorkspaceView } from "../features/workspace/WorkspaceView";
import { SettingsWindowView } from "../features/workspace/SettingsWindowView";

function getAppView() {
  if (typeof window === "undefined") {
    return "workspace";
  }
  return new URLSearchParams(window.location.search).get("view") === "settings" ? "settings" : "workspace";
}

export function AppShell() {
  if (getAppView() === "settings") {
    return <SettingsWindowView />;
  }

  return <WorkspaceView />;
}
