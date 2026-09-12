import assert from "node:assert/strict";
import React, { act, useCallback, useState } from "react";
import { useFileOpeningController } from "./useFileOpeningController";
import { createWorkspaceState, workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { expansionInteractions } from "./folderExpansionTestSupport";
import { createRemoteRootUri } from "./remoteUri";
import { toBackendRemoteProfile } from "./workspaceBackendDtos";
import type { FileOpenProgress, FileOpenRequest, FileOpenResult } from "../../app/fileAssociations";

export const completion = (async () => {
  installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const initial = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  const path = createRemoteRootUri(toBackendRemoteProfile(initial.remoteProfiles[0])) + "/文件.txt";
  const gateway = createTestGateway(() => {}, expansionInteractions());
  const calls: FileOpenRequest[] = []; const cancels: string[] = []; const notifications: string[] = [];
  let progress!: (value: FileOpenProgress) => void;
  let finish!: (value: FileOpenResult) => void;
  gateway.openFile = (request, handler) => {
    calls.push(request); progress = handler;
    return new Promise(resolve => { finish = resolve; });
  };
  gateway.cancelFileOpen = async requestId => { cancels.push(requestId); return true; };
  let state = initial;
  let api!: ReturnType<typeof useFileOpeningController>;
  function Harness() {
    const [value, set] = useState(initial); state = value;
    const dispatch = useCallback((action: WorkspaceAction) => set(previous => workspaceReducer(previous, action)),[]);
    api = useFileOpeningController({state:value,dispatch,gateway,enabled:true,notify:(_intent,message) => notifications.push(message)});
    return React.createElement("div");
  }
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (action: () => void) => act(async () => {action(); await flushEffects();});
  try {
    await tick(() => root.render(React.createElement(Harness)));
    let result!: Promise<boolean>;
    await tick(() => {result = api.openFile(path);});
    assert.equal(calls[0]?.target.kind,"remote");
    const id = calls[0].requestId;
    assert.equal(state.fileOpens?.[0].registered,false);
    await tick(() => {void api.actions.cancelFileOpen(id);});
    assert.equal(cancels.length,0,"cancel must wait for the backend registration acknowledgement");
    await tick(() => progress({phase:"preparing"}));
    await tick(() => {void api.actions.cancelFileOpen(id);});
    assert.deepEqual(cancels,[id]); assert.equal(state.fileOpens?.[0].cancelling,true);
    const late = progress;
    await tick(() => finish({status:"cancelled"}));
    assert.equal(await result,false); assert.equal(state.fileOpens?.length,0);
    await tick(() => late({phase:"downloading",completedBytes:100}));
    assert.equal(state.fileOpens?.length,0);
    assert.ok(notifications.some(message => message.includes("取消")));
    await tick(() => {result = api.openFile(path);});
    await tick(() => progress({phase:"opening"}));
    await tick(() => {void api.actions.cancelFileOpen(calls[1].requestId);});
    assert.equal(cancels.length,1,"launching requests are not cancellable");
    await tick(() => finish({status:"opened",localPath:"C:\\Temp\\文件.txt",associationId:"first"}));
    assert.equal(await result,true);
    assert.ok(notifications.some(message => message.includes("临时副本")));
    // Unmount before preparing: retain just enough ownership to cancel once registration arrives.
    await tick(() => {result = api.openFile(path);});
    await tick(() => root.unmount());
    progress({phase:"preparing"}); await flushEffects();
    assert.equal(cancels.at(-1),calls[2].requestId);
    finish({status:"cancelled"}); await result;
    console.log("ok - remote pending, cancel registration, terminal phases, late channels and unmount");
  } finally { await tick(() => root.unmount()); }
})();
