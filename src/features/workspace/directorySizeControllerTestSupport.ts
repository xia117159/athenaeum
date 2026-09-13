import React, { act, useCallback, useState } from "react";
import ReactDOM from "react-dom/client";
import { useDirectorySizeController } from "./useDirectorySizeController";
import { useFolderExpansionController } from "./useFolderExpansionController";
import { workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { createTestGateway, flushEffects } from "./workspaceControllerTestHarness";
import { expansionInteractions } from "./folderExpansionTestSupport";
import { sizeFixture, sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import type { DirectorySizeSnapshot, DirectorySizesGateway, LookupDirectorySizesRequest, SubscribeDirectorySizesRequest } from "./directorySizeTypes";
import type { WorkspaceState } from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";

export function controllerFixture(kind: "local" | "ftp" | "sftp" = "local") {
  const f = sizeFixture(kind);
  f.tab.directorySizes = undefined;
  if (kind !== "local") f.state.remoteProfiles = [{ id: "remote-size", name: "Sizes", protocol: kind,
    host: "server", port: kind === "ftp" ? 21 : 22, username: "alice", rootPath: "/home", authKind: "password",
    password: "must-not-be-sent", passiveMode: true, ignoreHostKey: false, connectTimeoutSecs: 15, commandTimeoutSecs: 30 }];
  return f;
}

export function sizeTransport(overrides: Partial<DirectorySizesGateway> = {}) {
  const subscribed: SubscribeDirectorySizesRequest[] = [];
  const released: string[] = []; const lookedUp: LookupDirectorySizesRequest[] = [];
  const listeners = new Set<(snapshot: DirectorySizeSnapshot) => void>();
  const gateway: DirectorySizesGateway = {
    subscribe: async (request) => { subscribed.push(request); return sizeSnapshot({ consumerId: request.consumerId }); },
    release: async (consumerId) => { released.push(consumerId); },
    listen: async (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    lookup: async (request) => {
      lookedUp.push(request);
      return { ...request, sequence: 2, stale: false, directories: request.paths.map((path) =>
        /[\\/]parent$/.test(path) ? sizeRecord(path, "60", "parent-stamp") : sizeRecord(path, "100", "root-stamp")) };
    }, ...overrides
  };
  return { gateway, subscribed, released, lookedUp, listeners,
    emit(snapshot: DirectorySizeSnapshot) { for (const listener of listeners) listener(snapshot); } };
}

export async function mountSizes(initial: WorkspaceState, transport: DirectorySizesGateway, options: {
  enabled?: boolean; resolveDirectory?: WorkspaceGateway["resolveDirectory"]; expansions?: boolean;
} = {}) {
  const interactions = expansionInteractions();
  const gateway = createTestGateway(() => undefined, interactions, { resolveDirectory: options.resolveDirectory });
  gateway.directorySizes = transport;
  let state = initial; let dispatch!: (action: WorkspaceAction) => void;
  let update!: (updater: (previous: WorkspaceState) => WorkspaceState) => void;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  function Harness() {
    const [value, setValue] = useState(initial);
    state = value; update = setValue;
    dispatch = useCallback((action: WorkspaceAction) => setValue((previous) => workspaceReducer(previous, action)), []);
    useDirectorySizeController({ state: value, dispatch, workspaceGateway: gateway, enabled: options.enabled });
    // Both hooks stay mounted; disable expansion scheduling only in the fixture model.
    useFolderExpansionController({ state: options.expansions ? value : { ...value, settings: {
      ...value.settings, model: { ...value.settings.model, folderExpansionEnabled: false }
    } }, dispatch, workspaceGateway: gateway });
    return React.createElement("div");
  }
  await act(async () => { root.render(React.createElement(Harness)); await flushEffects(); });
  return {
    get state() { return state; }, get tab() { return state.panels["panel-1"].tabs[0]; }, gateway, interactions,
    async change(updater: (previous: WorkspaceState) => WorkspaceState) { await act(async () => { update(updater); await flushEffects(); }); },
    async dispatch(action: WorkspaceAction) { await act(async () => { dispatch(action); await flushEffects(); }); },
    async request(intent: "calculate" | "cancel" | "refresh") {
      await act(async () => { dispatch({ type: "directorySizeRequested", payload: { panelId: "panel-1", tabId: state.panels["panel-1"].tabs[0].id,
        rootPath: state.panels["panel-1"].tabs[0].snapshot.location.path, intent } }); await flushEffects(); });
    },
    async close() { await act(async () => { root.unmount(); await flushEffects(); }); container.remove(); }
  };
}
