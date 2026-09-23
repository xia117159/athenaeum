import assert from "node:assert/strict";
import { test } from "node:test";
import { compileLinearRegex } from "./regexEngine";
import { assertMedianDurationWithin } from "./timingTestSupport";
import { expansionFixture } from "./folderExpansionTestSupport";
import { createWorkspaceState, getActiveTab, workspaceReducer } from "./workspaceReducer";
import { resolveActiveQuickFilterProgram } from "./quickFilterState";
import { getFolderListingRows } from "./folderExpansion";
import { evaluateQuickFilter } from "./quickFilterEvaluator";

test("regex late-success highlighting does not rescan from every possible start", () => {
  const result = compileLinearRegex("(a{1,20}){1,20}$|x");
  assert.ok(result.ok);
  const names = Array.from({ length: 10 }, (_, i) => "a".repeat(235) + i + "x");
  assertMedianDurationWithin(() => {
    for (const name of names) assert.deepEqual(result.matchRanges(name), [{ start: 236, end: 237 }]);
  }, 300, "ten distinct long filenames with a late matching alternative");
});

test("regex uses standard alternation, lazy quantifiers and Unicode characters", () => {
  for (const [source, name, expected] of [
    ["a|ab", "ab", [{ start: 0, end: 1 }]],
    ["a+?", "aaa", [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]],
    ["^.$", "😀", [{ start: 0, end: 2 }]]
  ] as const) {
    const result = compileLinearRegex(source);
    assert.ok(result.ok);
    assert.deepEqual(result.matchRanges(name), expected);
  }
});

test("regex evaluation is exposed through the Worker evaluator", () => {
  const result = evaluateQuickFilter({ text: "^2026-.*\\.pdf$", fallbackText: "", names: ["2026-report.pdf", "2025-report.pdf"], includeRanges: true });
  assert.equal(result.evaluation?.matches["2026-report.pdf"].matched, true);
  assert.deepEqual(result.evaluation?.matches["2026-report.pdf"].ranges, [{ start: 0, end: 15 }]);
});

test("whitespace input immediately disables every filter mode and syntax", () => {
  const f = expansionFixture();
  for (const mode of ["highlight", "include", "exclude"] as const) {
    for (const syntax of ["substring", "wildcard", "regex"] as const) {
      let state = createWorkspaceState(f.bootstrap);
      state = workspaceReducer(state, { type: "quickFilterModeChanged", payload: { mode } });
      state = workspaceReducer(state, { type: "quickFilterSyntaxChanged", payload: { syntax } });
      if (syntax === "regex") {
        const before = state.quickFilter.byPath[f.path.toLowerCase()];
        state = { ...state, quickFilter: { ...state.quickFilter, byPath: {
          ...state.quickFilter.byPath, [f.path.toLowerCase()]: { ...before, appliedText: "pro", regexEvaluation: {
            text: "pro", matches: Object.fromEntries(getActiveTab(state.panels[state.activePanelId]).snapshot.entries.map(entry =>
              [entry.name, { matched: entry.name.includes("pro"), ranges: [] }]))
          } }
        } } };
      }
      state = workspaceReducer(state, { type: "quickFilterTextChanged", payload: { path: f.path, text: "   " } });
      const tab = getActiveTab(state.panels[state.activePanelId]);
      const program = resolveActiveQuickFilterProgram(state);
      assert.equal(program, null, `${mode}/${syntax}: whitespace means no program`);
      assert.equal(getFolderListingRows(tab, state.fileVisibility, program, false).length, 2);
    }
  }
});
