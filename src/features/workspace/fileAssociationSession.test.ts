import assert from "node:assert/strict";
import type { FileAssociationRule } from "../../app/fileAssociations";
import { createMockWorkspaceBootstrap } from "./mockData";
import { mergeBootstrapWithSession } from "./workspaceBootstrapSession";
import { createWorkspaceState } from "./workspaceReducer";
import { toPersistedSession } from "./workspaceSessionStore";

const rules: FileAssociationRule[] = [
  { id: "first", patterns: "*.txt;.md", executablePath: String.raw`C:\Program Files\编辑器.exe`, argumentsTemplate: '--new-window "{file}"' },
  { id: "second", patterns: "txt", executablePath: String.raw`D:\other.exe`, argumentsTemplate: "" }
];

export const completion = (async () => {
  const cases = [
    { name: "new rules override an empty cache", saved: rules, cached: [] },
    { name: "deleted rules cannot be revived by cache", saved: [], cached: rules },
    { name: "legacy cache cannot erase rules", saved: rules, cached: undefined },
    { name: "absent backend rules cannot be revived by cache", saved: undefined, cached: rules },
    { name: "saved edits and ordering override old rules", saved: [rules[1], { ...rules[0], argumentsTemplate: "--reuse {file}" }], cached: rules }
  ];
  for (const source of ["tauri", "mock"] as const) {
    for (const scenario of cases) {
      const base = createMockWorkspaceBootstrap(source);
      base.settingsModel.fileAssociations = structuredClone(scenario.saved);
      const session = toPersistedSession(createWorkspaceState(base));
      session.settingsModel = { ...session.settingsModel, fileAssociations: structuredClone(scenario.cached) };
      for (const panel of Object.values(session.panels)) panel.tabs = [];
      const before = structuredClone({ base, session });
      const merged = await mergeBootstrapWithSession(base, session, []);
      const expected = (source === "tauri" ? scenario.saved : scenario.cached) ?? [];
      assert.deepEqual(merged.settingsModel.fileAssociations, expected, `${source}: ${scenario.name}`);
      assert.deepEqual({ base, session }, before, "restoring must not mutate either input");
    }
  }
  const base = createMockWorkspaceBootstrap("tauri");
  base.settingsModel.fileAssociations = rules;
  assert.equal(await mergeBootstrapWithSession(base, null, []), base);
  console.log("ok - desktop association recovery uses backend rules; browser sessions retain their existing rules");
})();
