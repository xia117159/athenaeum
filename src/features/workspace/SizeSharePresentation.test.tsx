import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { DirectorySizeControl } from "./DirectorySizeControl";
import { SizeShareCell } from "./SizeShareCell";
import { projectEntrySize } from "./directorySizes";
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
    await assertTest("FTP alone discloses server-hidden links before calculation and on complete or partial results", async () => {
      for (const locationKind of ["ftp", "sftp", "local"] as const) for (const phase of [undefined, "complete", "partial"] as const) {
        const props = { locationKind,
          statistics: phase ? { ...f.sizes, snapshot: sizeSnapshot({ phase, totalBytes: phase === "complete" ? "100" : null }) } : undefined,
          onAction: () => undefined };
        await render(<DirectorySizeControl {...props} />);
        const title = container.querySelector("button")?.title ?? "";
        if (locationKind === "ftp") {
          assert.match(title, /服务器元数据/);
          assert.match(title, /跳过可识别的链接/);
          assert.match(title, /未标识的链接目标可能被计入/);
        } else {
          assert.doesNotMatch(title, /未标识的链接|FTP.*服务器元数据/);
        }
      }
    });
    await assertTest("size cells retain text and truthful widths, use a whole-bar shade and never announce per-row task progress", async () => {
      await render(<><SizeShareCell entry={projectEntrySize(f.tab, f.parent)} /><SizeShareCell entry={projectEntrySize(f.tab, f.a)} /></>);
      assert.equal(container.textContent, "60 B30 B");
      const bars = [...container.querySelectorAll<HTMLElement>(".size-share-bar")];
      assert.deepEqual(bars.map((bar) => bar.style.getPropertyValue("--size-share")), ["60%", "30%"]);
      assert.equal(container.querySelector('[role="progressbar"]'), null);
      assert.equal(container.querySelectorAll('.size-share-track[aria-hidden="true"]').length, 2);
      assert.match(container.querySelector(".size-share-value")?.getAttribute("title") ?? "", /60 字节/);
      f.sizes.snapshot = sizeSnapshot({ phase: "partial", totalBytes: null });
      await render(<SizeShareCell entry={projectEntrySize(f.tab, f.parent)} />);
      assert.ok(container.querySelector(".size-share-bar"));
      await render(<SizeShareCell entry={f.a} />); assert.equal(container.textContent, "30 B");
      const css = readWorkspaceCss();
      assert.match(css, /\.size-share-bar\s*\{[^}]*width:\s*var\(--size-share\)/);
      assert.match(css, /\.size-share-bar\s*\{[^}]*color-mix\(in srgb,/);
      assert.match(css, /\.size-share-track\s*\{[^}]*position:\s*absolute/);
      assert.match(css, /\.size-share-track\s*\{[^}]*inset:\s*2px/);
      assert.match(css, /\.size-share-track\s*\{[^}]*height:\s*calc\(var\(--details-row-height\) - 4px\)/);
      assert.match(css, /\.size-share-value\s*\{[^}]*position:\s*relative/);
      assert.match(css, /size-share-label--fill/);
      assert.match(css, /\.size-share-label--fill\s*\{[^}]*top:\s*-2px[^}]*height:\s*var\(--details-row-height\)/);
      assert.match(css, /clip-path:\s*inset\(0 calc\(100% - var\(--size-share\)\) 0 0\)/);
      assert.match(css, /\.size-share-track\s*\{[^}]*pointer-events:\s*none/);
      assert.doesNotMatch(css.match(/\.size-share-bar\s*\{([^}]*)\}/)?.[1] ?? "", /min-width|linear-gradient/);
    });

    await assertTest("one listing loading hint waits 200ms, fast results never flash, failures are immediate", async () => {
      const originalSet = window.setTimeout; const originalClear = window.clearTimeout;
      const timers = new Map<number, () => void>(); let timerId = 0;
      window.setTimeout = ((callback: TimerHandler, delay: number) => { assert.equal(delay, 200); const id = ++timerId; timers.set(id, callback as () => void); return id; }) as typeof window.setTimeout;
      window.clearTimeout = ((id?: number) => { if (id !== undefined) timers.delete(id); }) as typeof window.clearTimeout;
      const control = () => <DirectorySizeControl statistics={f.sizes} locationKind="local" onAction={(intent) => actions.push(intent)} />;
      try {
        f.sizes.snapshot = sizeSnapshot({ phase: "queued", totalBytes: null });
        await render(control());
        assert.equal(timers.size, 1);
        assert.equal(container.querySelector('[role="status"]'), null);
        f.sizes.snapshot = sizeSnapshot(); await render(control());
        assert.equal(timers.size, 0); assert.equal(container.querySelector('[role="status"]'), null);
        f.sizes.snapshot = sizeSnapshot({ phase: "scanning", generation: 2, totalBytes: null }); await render(control());
        await act(async () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); await flushEffects(); });
        assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /正在计算/);
        await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
        assert.deepEqual(actions, ["cancel"]);
        f.sizes.snapshot = sizeSnapshot({ phase: "failed", reason: "permission denied" }); await render(control());
        assert.equal(timers.size, 0);
        assert.ok(container.querySelector(".directory-size-control.is-error"));
        assert.match(container.querySelector("button")?.title ?? "", /permission denied/);
      } finally { window.setTimeout = originalSet; window.clearTimeout = originalClear; }
    });
  } finally { await act(async () => root.unmount()); container.remove(); dom.window.close(); }
})();
