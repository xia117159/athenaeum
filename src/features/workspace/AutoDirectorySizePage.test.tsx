import assert from "node:assert/strict";
import React, { act } from "react";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  // react-dom detects input-event support at load time, so it must load after the DOM exists.
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const { AutoDirectorySizePage } = require("./AutoDirectorySizePage") as typeof import("./AutoDirectorySizePage");
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const tick = async (action: () => void | Promise<void>) => act(async () => { await action(); await flushEffects(); });
  const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text)!;
  const input = () => container.querySelector<HTMLInputElement>('[aria-label="要自动计算大小的文件夹路径"]')!;
  const type = (value: string) => tick(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  let paths = ["D:\\A", "D:\\A\\B"];
  const calls: string[] = []; let confirmAnswer = false; const confirms: string[] = [];
  window.confirm = (message?: string) => { confirms.push(message ?? ""); return confirmAnswer; };
  let chosen: string | null = null;
  const render = () => root.render(<AutoDirectorySizePage paths={paths}
    onAdd={async (path) => { calls.push(`add:${path}`); paths = [...paths, path]; render(); return paths; }}
    onRemove={async (path) => { calls.push(`remove:${path}`); paths = paths.filter((item) => item !== path); render(); return paths; }}
    onChoose={async () => chosen} />);
  try {
    await assertTest("rows show the saved list and which entries an ancestor already covers", async () => {
      await tick(render);
      assert.deepEqual(rows().map((row) => row.textContent), ["D:\\A", "D:\\A\\B已被上级覆盖（D:\\A）"]);
      assert.match(container.textContent ?? "", /修改立即生效/);
    });
    await assertTest("adding validates inline, selects duplicates, confirms volume roots and saves normalized paths", async () => {
      await type("relative");
      await tick(() => button("添加").click());
      assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /有效的本地或网络文件夹绝对路径/);
      await type("d:/a/b/");
      await tick(() => button("添加").click());
      assert.equal(calls.length, 0);
      assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /已存在/, container.innerHTML);
      assert.equal(rows()[1].getAttribute("aria-selected"), "true");
      await type("\\\\server\\share");
      await tick(() => button("添加").click());
      assert.equal(confirms.length, 1);
      assert.equal(calls.length, 0, "a declined confirmation adds nothing");
      confirmAnswer = true;
      await tick(() => button("添加").click());
      assert.deepEqual(calls, ["add:\\\\server\\share"]);
      await type("e:/data");
      await tick(() => button("添加").click());
      assert.deepEqual(calls.slice(1), ["add:E:\\data"]);
      assert.equal(input().value, "");
    });
    await assertTest("browsing adds the chosen folder and delete removes the selection", async () => {
      chosen = "F:\\Media";
      await tick(() => button("浏览…").click());
      assert.equal(calls.at(-1), "add:F:\\Media");
      await tick(() => rows()[0].click());
      await tick(() => button("删除").click());
      assert.equal(calls.at(-1), "remove:D:\\A");
    });
    await assertTest("arrow keys move the selection and focus through the list; Delete removes the focused row", async () => {
      const key = (row: HTMLElement, name: string) => tick(() => { row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true })); });
      await tick(() => rows()[0].focus());
      assert.equal(rows()[0].getAttribute("aria-selected"), "true");
      await key(rows()[0], "ArrowDown");
      assert.equal(rows()[1].getAttribute("aria-selected"), "true");
      assert.equal(document.activeElement, rows()[1]);
      await key(rows()[1], "End");
      assert.equal(document.activeElement, rows().at(-1));
      await key(rows().at(-1)!, "Home");
      assert.equal(document.activeElement, rows()[0]);
      await key(rows()[0], "ArrowUp");
      assert.equal(document.activeElement, rows()[0], "the first row stays selected");
      await key(rows()[0], "ArrowDown");
      const target = rows()[1].dataset.path!;
      await key(rows()[1], "Delete");
      assert.equal(calls.at(-1), `remove:${target}`);
    });
    await assertTest("command failures are shown inline", async () => {
      root.render(<AutoDirectorySizePage paths={[]} onAdd={async () => { throw new Error("自动计算目录最多支持 256 项"); }}
        onRemove={async () => []} onChoose={async () => null} />);
      await flushEffects();
      await type("G:\\x");
      await tick(() => button("添加").click());
      assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /最多支持 256 项/);
      assert.equal(button("删除").disabled, true);
    });
  } finally { await act(async () => root.unmount()); container.remove(); dom.window.close(); }
})();
