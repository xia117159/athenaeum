import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { DirectorySizeControl } from "./DirectorySizeControl";
import { sizeFixture, sizeSnapshot } from "./directorySizeTestSupport";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { readWorkspaceCss } from "./workspaceCssTestUtils";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const f = sizeFixture(); const actions: string[] = [];
  const render = async (node: React.ReactNode) => act(async () => { root.render(node); await flushEffects(); });
  try {
    await assertTest("an automatic directory shows a badge instead of the calculate button", async () => {
      await render(<DirectorySizeControl statistics={f.sizes} locationKind="local" onAction={(intent) => actions.push(intent)}
        auto={{ root: "C:\\files", inherited: false }} />);
      assert.equal(container.querySelector("button"), null, "no button (D2, E3)");
      const badge = container.querySelector<HTMLElement>(".directory-size-control__auto")!;
      assert.equal(badge.getAttribute("role"), "img");
      assert.equal(badge.textContent, "自动");
      assert.match(badge.title, /^自动计算文件夹大小已启用，包含所有子文件夹。计算完成/);
      assert.equal(badge.getAttribute("aria-label"), badge.title);
      await render(<DirectorySizeControl statistics={f.sizes} locationKind="local" onAction={() => undefined}
        auto={{ root: "C:\\", inherited: true }} />);
      assert.match(container.querySelector<HTMLElement>(".directory-size-control__auto")!.title, /^自动计算文件夹大小已启用（继承自 C:\\），包含所有子文件夹。/);
      assert.match(readWorkspaceCss(), /\.directory-size-control__auto\s*\{[^}]*var\(--accent/);
    });
    await assertTest("a failed automatic calculation explains the reason and how to retry", async () => {
      await render(<DirectorySizeControl statistics={{ ...f.sizes, snapshot: sizeSnapshot({ phase: "failed", reason: "拒绝访问" }) }}
        locationKind="local" onAction={() => undefined} auto={{ root: "C:\\files", inherited: false, failed: "拒绝访问" }} />);
      const badge = container.querySelector<HTMLElement>(".directory-size-control__auto")!;
      assert.match(badge.title, /自动计算失败：拒绝访问。可在表头右键菜单或“查看”菜单中选择“重试自动计算”。$/);
      assert.ok(container.querySelector(".directory-size-control.is-error"));
    });
    await assertTest("a manual directory whose result went stale offers a recalculation", async () => {
      await render(<DirectorySizeControl statistics={{ ...f.sizes, snapshot: sizeSnapshot({ phase: "stale", invalidated: true }) }}
        locationKind="local" onAction={(intent) => actions.push(intent)} />);
      const button = container.querySelector("button")!;
      assert.match(button.title, /统计已过期（目录内容已变化），可重新计算/);
      await act(async () => { button.click(); await flushEffects(); });
      assert.deepEqual(actions, ["calculate"]);
    });
    await assertTest("a stale result without a content change keeps its own reason (§6.4)", async () => {
      await render(<DirectorySizeControl statistics={{ ...f.sizes, snapshot: sizeSnapshot({ phase: "stale", reason: "视图已离开，返回后恢复显示" }) }}
        locationKind="local" onAction={() => undefined} />);
      const title = container.querySelector("button")!.title;
      assert.doesNotMatch(title, /目录内容已变化/);
      assert.match(title, /统计已过期.*视图已离开，返回后恢复显示/);
    });
  } finally { await act(async () => root.unmount()); container.remove(); dom.window.close(); }
})();
