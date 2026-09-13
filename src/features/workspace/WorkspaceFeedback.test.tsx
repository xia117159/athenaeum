import assert from "node:assert/strict";
import React, { act } from "react";
import { WorkspaceFeedback } from "./WorkspaceFeedback";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { PendingFileOpen } from "./fileOpeningState";

export const completion = (async () => {
  installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const calls: string[] = [];
  const base: PendingFileOpen = {requestId:"request",path:"sftp://server/文件.txt",registered:false,cancelling:false,progress:{phase:"preparing"}};
  const render = async (open:PendingFileOpen) => act(async () => {
    root.render(<WorkspaceFeedback fileOpens={[open]} notifications={[]} onCancelOpen={id => calls.push(id)} onDismiss={() => {}} />);
    await flushEffects();
  });
  const button = () => document.querySelector<HTMLButtonElement>('button[aria-label="取消打开 文件.txt"]')!;
  try {
    await render(base); assert.ok(button()); assert.equal(button().disabled,true);
    await render({...base,registered:true,progress:{phase:"downloading",completedBytes:2048}});
    assert.equal(button().disabled,false); assert.match(document.body.textContent ?? "",/2 KB/);
    button().click(); assert.deepEqual(calls,["request"]);
    await render({...base,registered:true,progress:{phase:"opening"}}); assert.equal(button().disabled,true);
    await render({...base,registered:true,cancelling:true}); assert.equal(button().disabled,true);
    console.log("ok - file opening feedback has an accessible, phase-aware cancel action");
  } finally { await act(async () => root.unmount()); }
})();
