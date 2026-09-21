import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState, getActiveTab } from "./workspaceReducer";
import { applyQuickFilterText, resolveQuickFilterEntry } from "./quickFilterState";
import { assertTest } from "./workspaceControllerTestHarness";
import { decideQuickFilterTypeahead, type QuickFilterTypeaheadInput } from "./useQuickFilterTypeahead";
import type { WorkspaceState } from "./types";

/** 真实单调时钟（performance.now()）量级，保证 `now - 0 > 1500` 成立。 */
const T0 = 1_000_000;

function fixture() {
  const state = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  const tab = getActiveTab(state.panels[state.activePanelId]);
  return { state, tab, path: tab.snapshot.location.path };
}

function press(state: WorkspaceState, path: string, key: string,
  overrides: Partial<QuickFilterTypeaheadInput> = {}): ReturnType<typeof decideQuickFilterTypeahead> {
  return decideQuickFilterTypeahead({ key, state, activePath: path, now: T0 + 100, lastAt: T0, ...overrides });
}

export const completion = (async () => {
  await assertTest("typeahead accepts every printable ASCII character and rejects the rest", async () => {
    const f = fixture();
    for (const key of ["a", "Z", "9", "-", "_", ":", "*", "?", "~", "!"]) {
      assert.equal(press(f.state, f.path, key).kind, "type", `${JSON.stringify(key)} must type`);
    }
    // 空格留给「展开/折叠文件夹」快捷键，中文/功能键/导航键都不是键盘直输。
    for (const key of [" ", "中", "Enter", "ArrowDown", "ArrowUp", "Tab", "F5", "Shift", "Delete"]) {
      assert.equal(press(f.state, f.path, key).kind, "ignore", `${JSON.stringify(key)} must be ignored`);
    }
  });

  await assertTest("typeahead ignores modified, composing and auto-repeating keys", async () => {
    const f = fixture();
    assert.equal(press(f.state, f.path, "p", { ctrlKey: true }).kind, "ignore");
    assert.equal(press(f.state, f.path, "p", { altKey: true }).kind, "ignore");
    assert.equal(press(f.state, f.path, "p", { metaKey: true }).kind, "ignore");
    assert.equal(press(f.state, f.path, "p", { isComposing: true }).kind, "ignore");
    assert.equal(press(f.state, f.path, "p", { repeat: true }).kind, "ignore");
  });

  await assertTest("typeahead never steals keys from editable targets", async () => {
    const f = fixture();
    for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true }]) {
      assert.equal(press(f.state, f.path, "p", { target }).kind, "ignore", JSON.stringify(target));
    }
    assert.equal(press(f.state, f.path, "p", { target: { tagName: "DIV" } }).kind, "type");
    assert.equal(press(f.state, f.path, "p", { target: null }).kind, "type");
  });

  await assertTest("typeahead stays out of the way while overlays or a non-ready workspace are active", async () => {
    const f = fixture();
    assert.equal(press({ ...f.state, status: "loading" }, f.path, "p").kind, "ignore");
    f.tab.status = "loading";
    assert.equal(press(f.state, f.path, "p").kind, "ignore");
    f.tab.status = "ready";
    f.tab.inlineEdit = { mode: "rename", entryId: "x", kind: "file" } as never;
    assert.equal(press(f.state, f.path, "p").kind, "ignore");
    f.tab.inlineEdit = undefined;
    const withMenu = { ...f.state, contextMenu: { panelId: "panel-1", tabId: f.tab.id, mode: "custom",
      scope: "selection", x: 0, y: 0 } } as WorkspaceState;
    // 菜单/对话框打开时既有守卫已 consume 按键，直输不得再写入。
    assert.equal(press(withMenu, f.path, "p").kind, "ignore");
  });

  await assertTest("consecutive keys aggregate and a 1500ms gap restarts the aggregation", async () => {
    const f = fixture();
    let lastAt = 0;
    let now = T0;
    for (const key of ["p", "r", "o", "j", "e", "c", "t"]) {
      const decision = decideQuickFilterTypeahead({ key, state: f.state, activePath: f.path, now, lastAt });
      assert.equal(decision.kind, "type");
      if (decision.kind !== "type") throw new Error("unreachable");
      f.state.quickFilter = applyQuickFilterText(f.state.quickFilter, f.path, decision.text);
      lastAt = decision.resetAt;
      now += 100;
    }
    assert.equal(resolveQuickFilterEntry(f.state, f.path).text, "project");

    // 超过聚合超时后按「新聚合」处理：替换而不是追加。
    const restarted = decideQuickFilterTypeahead({ key: "x", state: f.state, activePath: f.path,
      now: lastAt + 1501, lastAt });
    assert.equal(restarted.kind === "type" && restarted.text, "x");
  });

  await assertTest("a tab or path change restarts the aggregation even inside the 1500ms window", async () => {
    const f = fixture();
    f.state.quickFilter = applyQuickFilterText(f.state.quickFilter, f.path, "project");
    // 控制器在激活标签页身份/路径变化时把 lastAt 重置为 0（B16）。
    const decision = decideQuickFilterTypeahead({ key: "x", state: f.state, activePath: f.path,
      now: T0 + 100, lastAt: 0 });
    assert.equal(decision.kind === "type" && decision.text, "x", "reset must replace instead of append");
  });

  await assertTest("Escape clears a non-empty filter and otherwise falls through to the list", async () => {
    const f = fixture();
    assert.equal(press(f.state, f.path, "Escape", { lastAt: 0 }).kind, "ignore");

    f.state.quickFilter = applyQuickFilterText(f.state.quickFilter, f.path, "project");
    assert.equal(press(f.state, f.path, "Escape", { lastAt: 0 }).kind, "clearFilter");
  });

  await assertTest("the filter text of one path never leaks into another path", async () => {
    const f = fixture();
    f.state.quickFilter = applyQuickFilterText(f.state.quickFilter, f.path, "project");
    const other = { path: "D:\\Projects\\Atlas\\other", entries: [], locationKind: "local" } as never;
    f.state.panels["panel-1"].tabs[0].snapshot = { ...f.tab.snapshot, location: other };
    const decision = decideQuickFilterTypeahead({ key: "x", state: f.state,
      activePath: "D:\\Projects\\Atlas\\other", now: T0 + 100, lastAt: 0 });
    assert.equal(decision.kind === "type" && decision.text, "x", "a new path starts from an empty filter");
  });
})();
