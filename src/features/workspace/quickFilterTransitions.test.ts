import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyQuickFilterApplied,
  applyQuickFilterCleared,
  applyQuickFilterMode,
  applyQuickFilterSyntax,
  applyQuickFilterText
} from "./quickFilterState";
import type { QuickFilterState } from "./quickFilterTypes";

const PATH = "C:\\files";
const KEY = "c:\\files";
const OTHER = "D:\\other";

function stateWith(entries: Record<string, { text: string; appliedText: string; error: string | null }>, overrides: Partial<QuickFilterState> = {}): QuickFilterState {
  return { mode: "highlight", syntax: "substring", byPath: entries, ...overrides };
}

// ---------------------------------------------------------------------------
// spec §5.7 状态机表格逐行覆盖
// ---------------------------------------------------------------------------

test("textChanged under substring/wildcard applies immediately", () => {
  for (const syntax of ["substring", "wildcard"] as const) {
    const next = applyQuickFilterText(stateWith({}, { syntax }), PATH, "pro");
    assert.deepEqual(next.byPath[KEY], { text: "pro", appliedText: "pro", error: null }, syntax);
  }
});

test("textChanged under regex keeps appliedText until the debounced compile lands", () => {
  const started = stateWith({ [KEY]: { text: "pro", appliedText: "pro", error: null } }, { syntax: "regex" });
  const next = applyQuickFilterText(started, PATH, "pro2");
  assert.equal(next.byPath[KEY].text, "pro2", "the input text updates immediately");
  assert.equal(next.byPath[KEY].appliedText, "pro", "the effective match lags until compile succeeds");
  assert.equal(next.byPath[KEY].error, null);
});

test("empty text clears appliedText and error unconditionally in every syntax (review S3)", () => {
  for (const syntax of ["substring", "wildcard", "regex"] as const) {
    const dirty = stateWith({ [KEY]: { text: "a(1", appliedText: "old", error: "正则表达式无效：x" } }, { syntax });
    const next = applyQuickFilterText(dirty, PATH, "");
    assert.deepEqual(next.byPath[KEY], { text: "", appliedText: "", error: null }, `${syntax} must fully clear`);
  }
});

test("quickFilterApplied ignores a stale dispatch whose text no longer matches the entry", () => {
  const current = stateWith({ [KEY]: { text: "newest", appliedText: "old", error: null } }, { syntax: "regex" });
  const stale = applyQuickFilterApplied(current, PATH, { text: "older", ok: true, message: null });
  assert.equal(stale, current, "a stale dispatch must be a no-op and keep the identical reference");
});

test("quickFilterApplied on success promotes the text and clears the error", () => {
  const pending = stateWith({ [KEY]: { text: "pro", appliedText: "old", error: "正则表达式无效：x" } }, { syntax: "regex" });
  const next = applyQuickFilterApplied(pending, PATH, { text: "pro", ok: true, message: null });
  assert.deepEqual(next.byPath[KEY], { text: "pro", appliedText: "pro", error: null });
});

test("quickFilterApplied on failure keeps the previous effective match and records the message", () => {
  const pending = stateWith({ [KEY]: { text: "a(1", appliedText: "keep-me", error: null } }, { syntax: "regex" });
  const next = applyQuickFilterApplied(pending, PATH, { text: "a(1", ok: false, message: "正则表达式无效：x" });
  assert.equal(next.byPath[KEY].appliedText, "keep-me", "the list must not change on an invalid pattern (D12)");
  assert.equal(next.byPath[KEY].error, "正则表达式无效：x");
  assert.equal(next.byPath[KEY].text, "a(1");
});

test("modeChanged touches only the session mode", () => {
  const started = stateWith({ [KEY]: { text: "pro", appliedText: "pro", error: null } });
  const next = applyQuickFilterMode(started, "exclude");
  assert.equal(next.mode, "exclude");
  assert.deepEqual(next.byPath, started.byPath);
  assert.equal(applyQuickFilterMode(started, "highlight"), started, "an unchanged mode keeps the reference");
});

test("switching to a non-regex syntax recomputes every cached path immediately", () => {
  const started = stateWith(
    { [KEY]: { text: "pro", appliedText: "pro", error: null }, [OTHER.toLowerCase()]: { text: "doc", appliedText: "", error: "err" } },
    { syntax: "regex" }
  );
  const next = applyQuickFilterSyntax(started, "substring");
  assert.equal(next.syntax, "substring");
  assert.deepEqual(next.byPath[KEY], { text: "pro", appliedText: "pro", error: null });
  assert.deepEqual(next.byPath[OTHER.toLowerCase()], { text: "doc", appliedText: "doc", error: null }, "the error clears because substring cannot fail");
});

test("switching to regex invalidates appliedText because validity does not carry across syntaxes", () => {
  const started = stateWith({ [KEY]: { text: "a(1", appliedText: "a(1", error: null } });
  const next = applyQuickFilterSyntax(started, "regex");
  assert.equal(next.syntax, "regex");
  assert.equal(next.byPath[KEY].appliedText, "", "the old text was never validated as a regex");
  assert.equal(next.byPath[KEY].error, null, "no error until the controller reports the compile result");
  assert.equal(next.byPath[KEY].text, "a(1", "the user's input is preserved");
});

test("cleared resets one path only and keeps mode/syntax", () => {
  const started = stateWith(
    { [KEY]: { text: "pro", appliedText: "pro", error: "err" }, [OTHER.toLowerCase()]: { text: "doc", appliedText: "doc", error: null } },
    { mode: "include", syntax: "wildcard" }
  );
  const next = applyQuickFilterCleared(started, PATH);
  assert.deepEqual(next.byPath[KEY], { text: "", appliedText: "", error: null });
  assert.deepEqual(next.byPath[OTHER.toLowerCase()], { text: "doc", appliedText: "doc", error: null });
  assert.equal(next.mode, "include");
  assert.equal(next.syntax, "wildcard");
});

test("no-op transitions keep the identical reference so downstream memo stays valid", () => {
  const started = stateWith({ [KEY]: { text: "pro", appliedText: "pro", error: null } });
  assert.equal(applyQuickFilterText(started, PATH, "pro"), started);
  assert.equal(applyQuickFilterCleared(started, OTHER), started, "clearing an unknown path changes nothing");
  assert.equal(applyQuickFilterSyntax(started, "substring"), started);
});
