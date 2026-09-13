import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseSizeShareTextColor, compositeOverWhite, parseCssColor, sizeShareTextTone } from "./sizeShareContrast";

test("size share contrast chooses readable light and dark labels", () => {
  assert.equal(sizeShareTextTone("#ffffff", "#ffffff", 0.5), "dark");
  assert.equal(sizeShareTextTone("#111111", "#111111", 0.5), "light");
  assert.equal(chooseSizeShareTextColor(parseCssColor("#000000")), "light");
  assert.equal(chooseSizeShareTextColor(parseCssColor("#ffffff")), "dark");
});

test("size share contrast composites alpha colors over the ordinary white cell", () => {
  const color = parseCssColor("#00000080");
  assert.ok(color);
  const composited = compositeOverWhite(color);
  assert.ok(composited.r > 120 && composited.r < 140);
  assert.equal(composited.a, 1);
});
