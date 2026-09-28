import assert from "node:assert/strict";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";
import { autoDirectorySizeToggle, directorySizeAutoBadge } from "./directorySizeMenu";
import { confirmAutoDirectorySizeRoot } from "./AutoDirectorySizePage";
import { assertTest, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("a mapped UNC listing participates in automatic sizing, including share-root confirmation (D17)", async () => {
      const share = "\\\\server\\share";
      for (const suffix of ["", "\\Docs"]) {
        const f = controllerFixture("local", { auto: false });
        f.tab.snapshot = mapDirectoryListingToSnapshot({
          location: { kind: "local", path: "\\\\?\\UNC\\server\\share" + suffix },
          entries: [], canGoUp: suffix !== "", sizeFingerprint: "stamp"
        });
        f.tab.folderExpansion = undefined;
        f.state.settings.model.autoDirectorySizePaths = [share];
        assert.deepEqual(autoDirectorySizeToggle(f.tab, [share]),
          { path: share + suffix, checked: true, inheritedFrom: suffix ? share : null });
        assert.deepEqual(directorySizeAutoBadge(f.tab, [share]), { root: share, inherited: suffix !== "" });
        const confirmations: string[] = [];
        window.confirm = (message) => { confirmations.push(message ?? ""); return false; };
        assert.equal(confirmAutoDirectorySizeRoot(f.tab.snapshot.location.path), suffix !== "");
        assert.equal(confirmations.length, suffix ? 0 : 1);
        const wire = sizeTransport();
        const h = await mountSizes(f.state, wire.gateway);
        try {
          assert.equal(wire.subscribed.length, 1);
          assert.equal(wire.subscribed[0].intent, "auto");
          assert.deepEqual(wire.subscribed[0].target, { kind: "local", path: share + suffix });
          assert.equal(h.tab.directorySizes?.mode, "auto");
        } finally { await h.close(); }
      }
    });
  } finally { dom.window.close(); }
})();
