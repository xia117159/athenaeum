import { useEffect, useRef, type Dispatch } from "react";
import type { WorkspaceState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceGateway } from "./workspaceGateway";
import { collectDirectorySizeViews, DirectorySizeViewsPublisher } from "./directorySizeViews";

export function useDirectorySizeViews({ state, dispatch, workspaceGateway, enabled }: {
  state: WorkspaceState; dispatch: Dispatch<WorkspaceAction>; workspaceGateway: WorkspaceGateway; enabled: boolean;
}) {
  const latest = useRef(state); latest.current = state;
  const publisher = useRef<DirectorySizeViewsPublisher | undefined>(undefined);
  const gateway = workspaceGateway.directorySizes;
  useEffect(() => {
    if (!enabled || !gateway?.updateViews || !gateway.listenViewsFlush) return;
    const lane = new DirectorySizeViewsPublisher((request) => gateway.updateViews!(request), () => dispatch({ type: "directorySizeViewsFrozen" }));
    let closed = false; let dispose: (() => void) | undefined;
    // Install the final-manifest listener before registering this workspace.
    void gateway.listenViewsFlush((event) => {
      if (closed) return;
      lane.update(collectDirectorySizeViews(latest.current));
      lane.freeze(event);
    }).then((unsubscribe) => {
      if (closed) { unsubscribe(); return; }
      dispose = unsubscribe; publisher.current = lane;
      if (latest.current.status === "ready") lane.update(collectDirectorySizeViews(latest.current));
    }).catch((error: unknown) => console.warn("目录大小退出清单监听失败", error));
    return () => { closed = true; lane.close(); dispose?.(); if (publisher.current === lane) publisher.current = undefined; };
  }, [enabled, gateway, dispatch]);
  useEffect(() => {
    if (enabled && state.status === "ready") publisher.current?.update(collectDirectorySizeViews(state));
  }, [enabled, state.status, state.panels, state.layoutMode]);
}
