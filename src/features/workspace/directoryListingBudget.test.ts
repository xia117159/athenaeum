import assert from "node:assert/strict";
import { test } from "node:test";
import { getDirectoryListingBudget } from "./directoryListingBudget";

test("expansion and size-alignment reads share four slots per gateway, with idempotent releases", () => {
  const owner = {}; const budget = getDirectoryListingBudget(owner);
  assert.equal(getDirectoryListingBudget(owner), budget);
  const releases = Array.from({ length: 4 }, () => budget.tryAcquire()!);
  assert.equal(releases.every((release) => typeof release === "function"), true);
  assert.equal(budget.tryAcquire(), undefined);
  let wakes = 0; const stop = budget.listen(() => { wakes++; });
  releases[0](); releases[0](); assert.equal(wakes, 1);
  assert.equal(typeof budget.tryAcquire(), "function");
  assert.equal(budget.tryAcquire(), undefined);
  stop(); releases[1](); assert.equal(wakes, 1);
  assert.equal(typeof getDirectoryListingBudget({}).tryAcquire(), "function");
});
