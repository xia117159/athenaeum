import { act } from "react";
import { controllerFixture, sizeTransport } from "./directorySizeControllerTestSupport";
import { flushEffects } from "./workspaceControllerTestHarness";
import type { DirectorySizeSnapshot } from "./directorySizeTypes";
import type { WorkspaceState } from "./types";

export function moveFixture(auto = false, sourceAuto = false) {
  const f = controllerFixture("local", { auto });
  const plain = (id: string, path: string) => ({ ...f.tab, id, folderExpansion: undefined, directorySizes: undefined,
    snapshot: { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, path }, entries: [] } });
  f.state.layoutMode = "dual";
  f.state.panels["panel-1"].tabs.push(plain("stay", "C:\\stay"));
  // An actual destination ID collision exercises the reducer's tab rename.
  f.state.panels["panel-2"] = { ...f.state.panels["panel-1"], id: "panel-2", tabs: [plain(f.tab.id, "C:\\right")], activeTabId: f.tab.id };
  if (sourceAuto) f.state.settings.model.autoDirectorySizePaths = [...(f.state.settings.model.autoDirectorySizePaths ?? []), "C:\\stay"];
  return f;
}
export function movedTab(state: WorkspaceState, path: string) {
  return Object.values(state.panels).flatMap((panel) => panel.tabs).find((tab) => tab.snapshot.location.path === path)!;
}
export const moveRight = (tabId: string) => ({ type: "tabMoved" as const,
  payload: { sourcePanelId: "panel-1" as const, targetPanelId: "panel-2" as const, tabId, targetIndex: 1 } });

export function gateReplacement(wire: ReturnType<typeof sizeTransport>, beforeSubscribe = false) {
  const subscribe = wire.gateway.subscribe, listen = wire.gateway.listen;
  let listens = 0;
  let open!: () => void, reject!: (error: Error) => void;
  const gate = new Promise<void>((resolve, fail) => { open = resolve; reject = fail; });
  if (beforeSubscribe) wire.gateway.listen = async (listener) => { if (++listens === 2) await gate; return listen(listener); };
  else wire.gateway.subscribe = async (request) => {
    const value = subscribe(request);
    if (wire.subscribed.length === 2) await gate;
    return value;
  };
  return { async finish(error?: string) { await act(async () => {
    if (error) reject(new Error(error)); else open();
    await flushEffects();
  }); } };
}
export async function emitSize(wire: ReturnType<typeof sizeTransport>, snapshot: DirectorySizeSnapshot) {
  await act(async () => { wire.emit(snapshot); await flushEffects(); });
}
