import assert from "node:assert/strict";
import {
  MAX_WORKSPACE_SEARCH_HISTORY_ITEMS,
  normalizeSearchHistory,
  readSearchHistory,
  WORKSPACE_SEARCH_HISTORY_STORAGE_KEY,
  WORKSPACE_SEARCH_NAME_HISTORY_STORAGE_KEY,
  writeSearchHistory
} from "./workspaceSearchHistoryStore";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    snapshot() {
      return Object.fromEntries(values.entries());
    }
  };
}

assertTest("normalizeSearchHistory trims, deduplicates, and caps history at twenty items", () => {
  const history = normalizeSearchHistory([" alpha ", "beta", "ALPHA", ...Array.from({ length: 25 }, (_, index) => `item-${index}`)]);

  assert.equal(history.length, MAX_WORKSPACE_SEARCH_HISTORY_ITEMS);
  assert.deepEqual(history.slice(0, 3), ["alpha", "beta", "item-0"]);
});

assertTest("readSearchHistory tolerates missing and malformed storage values", () => {
  assert.deepEqual(readSearchHistory(undefined), []);
  assert.deepEqual(readSearchHistory("content", createStorage({ [WORKSPACE_SEARCH_HISTORY_STORAGE_KEY]: "{broken" })), []);
  assert.deepEqual(readSearchHistory("content", createStorage({ [WORKSPACE_SEARCH_HISTORY_STORAGE_KEY]: JSON.stringify({ value: "x" }) })), []);
});

assertTest("writeSearchHistory serializes normalized values under the stable key", () => {
  const storage = createStorage();

  writeSearchHistory("content", [" report ", "report", "error"], storage);

  const raw = storage.snapshot()[WORKSPACE_SEARCH_HISTORY_STORAGE_KEY];
  assert.ok(raw);
  assert.deepEqual(JSON.parse(raw), ["report", "error"]);
});

assertTest("readSearchHistory and writeSearchHistory keep name and content histories isolated", () => {
  const storage = createStorage({
    [WORKSPACE_SEARCH_HISTORY_STORAGE_KEY]: JSON.stringify(["content-one"]),
    [WORKSPACE_SEARCH_NAME_HISTORY_STORAGE_KEY]: JSON.stringify(["name-one"])
  });

  assert.deepEqual(readSearchHistory("content", storage), ["content-one"]);
  assert.deepEqual(readSearchHistory("name", storage), ["name-one"]);

  writeSearchHistory("name", [" report ", "REPORT", "archive"], storage);

  assert.deepEqual(readSearchHistory("content", storage), ["content-one"]);
  assert.deepEqual(readSearchHistory("name", storage), ["report", "archive"]);
});
