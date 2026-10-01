import assert from "node:assert/strict";
import { test } from "node:test";
import { autoDirectorySizeToggle, directorySizeAutoBadge, directorySizeBusy, directorySizeMenuState } from "./directorySizeMenu";
import { sizeFixture, sizeSnapshot } from "./directorySizeTestSupport";
import { isVolumeRootPath, normalizeAutoDirectorySizePath } from "./directorySizeAutoPaths";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";

test("a manual directory offers calculate, greyed while busy or without a visible size column", () => {
  const f = sizeFixture();
  assert.deepEqual(directorySizeMenuState(f.tab, []), { kind: "calculate", disabled: false });
  f.sizes.pending = true;
  assert.equal(directorySizeBusy(f.sizes), true);
  assert.deepEqual(directorySizeMenuState(f.tab, []), { kind: "calculate", disabled: true, title: "正在计算文件夹大小" });
  f.sizes.pending = false; f.sizes.snapshot = sizeSnapshot({ phase: "scanning" });
  assert.equal(directorySizeBusy(f.sizes), true);
  f.sizes.snapshot = sizeSnapshot({ phase: "complete" });
  assert.equal(directorySizeBusy(f.sizes), false);
  assert.equal(directorySizeBusy(undefined), false);
  f.tab.viewMode = "large-icons";
  assert.deepEqual(directorySizeMenuState(f.tab, []), { kind: "calculate", disabled: true, title: "需要在详细信息视图中显示大小列" });
  f.tab.viewMode = "details";
  f.tab.columns = f.tab.columns.map((column) => column.id === "size" ? { ...column, visible: false } : column);
  assert.deepEqual(directorySizeMenuState(f.tab, []), { kind: "calculate", disabled: true, title: "需要在详细信息视图中显示大小列" });
  f.tab.status = "loading";
  f.tab.columns = f.tab.columns.map((column) => column.id === "size" ? { ...column, visible: true } : column);
  assert.deepEqual(directorySizeMenuState(f.tab, []), { kind: "calculate", disabled: true, title: "文件夹加载完成后才能计算大小" },
    "a loading listing is not a hidden size column");
});

test("an automatic directory hides calculate and offers retry only after a failure", () => {
  const f = sizeFixture();
  assert.equal(directorySizeMenuState(f.tab, [f.path]), null);
  f.sizes.autoPaused = true; f.sizes.autoError = "拒绝访问";
  assert.deepEqual(directorySizeMenuState(f.tab, [f.path]), { kind: "retry" });
  f.sizes.autoPaused = false; f.sizes.autoError = undefined; f.sizes.snapshot = sizeSnapshot({ phase: "failed", reason: "磁盘错误" });
  assert.deepEqual(directorySizeMenuState(f.tab, [f.path]), { kind: "retry" });
  const parentRoot = "C:\\";
  f.sizes.snapshot = sizeSnapshot();
  assert.equal(directorySizeMenuState(f.tab, [parentRoot]), null, "inherited roots behave the same");
});

test("remote, virtual and non-directory tabs never become automatic", () => {
  const remote = sizeFixture("sftp");
  assert.equal(directorySizeMenuState(remote.tab, [remote.path])?.kind, "calculate");
  assert.equal(directorySizeAutoBadge(remote.tab, [remote.path]), undefined);
  assert.equal(autoDirectorySizeToggle(remote.tab, [remote.path]), null);
  const local = sizeFixture();
  local.tab.snapshot.location = { ...local.tab.snapshot.location, kind: "virtual" };
  assert.equal(directorySizeMenuState(local.tab, [local.path]), null);
  assert.equal(autoDirectorySizeToggle(local.tab, []), null);
  const nav = sizeFixture();
  nav.tab.kind = "navigation";
  assert.equal(directorySizeMenuState(nav.tab, []), null);
  assert.equal(autoDirectorySizeToggle(nav.tab, []), null);
});

test("the header badge names the covering root and the failure reason", () => {
  const f = sizeFixture();
  assert.equal(directorySizeAutoBadge(f.tab, []), undefined);
  assert.deepEqual(directorySizeAutoBadge(f.tab, [f.path]), { root: f.path, inherited: false });
  const parentRoot = "C:\\";
  assert.deepEqual(directorySizeAutoBadge(f.tab, [parentRoot]), { root: parentRoot, inherited: true });
  f.sizes.autoPaused = true; f.sizes.autoError = "拒绝访问";
  assert.deepEqual(directorySizeAutoBadge(f.tab, [f.path]), { root: f.path, inherited: false, failed: "拒绝访问" });
  f.sizes.autoPaused = false; f.sizes.autoError = undefined; f.sizes.snapshot = sizeSnapshot({ phase: "failed", reason: null });
  assert.deepEqual(directorySizeAutoBadge(f.tab, [f.path]), { root: f.path, inherited: false, failed: "自动计算失败" });
});

test("the tab toggle reflects coverage and greys inherited coverage", () => {
  const f = sizeFixture();
  const parentRoot = "C:\\";
  assert.deepEqual(autoDirectorySizeToggle(f.tab, []), { path: f.path, checked: false, inheritedFrom: null });
  assert.deepEqual(autoDirectorySizeToggle(f.tab, [f.path]), { path: f.path, checked: true, inheritedFrom: null });
  assert.deepEqual(autoDirectorySizeToggle(f.tab, [parentRoot]), { path: f.path, checked: true, inheritedFrom: parentRoot });
  f.tab.columns = f.tab.columns.map((column) => ({ ...column, visible: false }));
  assert.equal(autoDirectorySizeToggle(f.tab, [f.path])?.checked, true, "a hidden size column does not hide the toggle (D13)");
});

test("network share tabs match UNC entries, confirm share roots and never send an unusable path (D17)", () => {
  const at = (path: string) => { const f = sizeFixture(); f.tab.snapshot.location = { ...f.tab.snapshot.location, path }; f.tab.directorySizes = undefined; return f.tab; };
  const share = String.raw`\\server\share`;
  assert.deepEqual(autoDirectorySizeToggle(at(String.raw`\\server\share\docs`), [share]), { path: String.raw`\\server\share\docs`, checked: true, inheritedFrom: share });
  assert.deepEqual(directorySizeAutoBadge(at(String.raw`\\SERVER\share\docs`), [share]), { root: share, inherited: true });
  const verbatimRoot = autoDirectorySizeToggle(at(String.raw`\\?\UNC\server\share`), []);
  assert.deepEqual(verbatimRoot, { path: share, checked: false, inheritedFrom: null }, "the toggle sends the saved form of the path");
  assert.equal(isVolumeRootPath(verbatimRoot!.path), true, "enabling a share root asks for confirmation (E4)");
  assert.equal(directorySizeAutoBadge(at(String.raw`\server\share\docs`), [share]), undefined, "a drive-relative path is not the share");
  assert.equal(autoDirectorySizeToggle(at(String.raw`\server\share\docs`), [share]), null, "no toggle for a path the backend rejects");
  // The actual listing path must support D17, not merely hide an unusable command.
  const mapped = mapDirectoryListingToSnapshot({ location: { kind: "local", path: String.raw`\\?\UNC\server\share\docs` }, entries: [], parent: null, canGoUp: false } as never);
  const toggle = autoDirectorySizeToggle(at(mapped.location.path), [share]);
  assert.deepEqual(toggle, { path: share + "\\docs", checked: true, inheritedFrom: share });
  assert.equal(normalizeAutoDirectorySizePath(toggle!.path), toggle!.path);
});
