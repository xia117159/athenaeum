import assert from "node:assert/strict";
import { getDetailsColumnPixelWidth, getDetailsGridMetrics, parseDetailsPixelWidth } from "./detailsGridMetrics";
import { getTextMeasureUnits } from "./textMeasure";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

assertTest("getTextMeasureUnits counts CJK text as double-width for header estimates", () => {
  assert.equal(getTextMeasureUnits("Name"), 4);
  assert.equal(getTextMeasureUnits("\u540d\u79f0"), 4);
  assert.equal(getTextMeasureUnits("A\u540d"), 3);
});

assertTest("parseDetailsPixelWidth accepts only fixed px column widths", () => {
  assert.equal(parseDetailsPixelWidth("112px"), 112);
  assert.equal(parseDetailsPixelWidth("112.4px"), 112.4);
  assert.equal(Number.isNaN(parseDetailsPixelWidth("1fr")), true);
  assert.equal(Number.isNaN(parseDetailsPixelWidth("auto")), true);
});

assertTest("getDetailsColumnPixelWidth clamps fallback and explicit widths to the column minimum", () => {
  const column = { id: "name", width: "1fr" };
  assert.equal(getDetailsColumnPixelWidth({ column, minWidth: 64, fallbackWidth: 40 }), 64);
  assert.equal(getDetailsColumnPixelWidth({ column: { ...column, width: "48px" }, minWidth: 64, fallbackWidth: 120 }), 64);
  assert.equal(getDetailsColumnPixelWidth({ column: { ...column, width: "88.6px" }, minWidth: 64, fallbackWidth: 120 }), 89);
});

assertTest("getDetailsGridMetrics materializes fixed tracks and includes inter-column gaps", () => {
  const columns = [
    { id: "name", width: "240px" },
    { id: "kind", width: "1fr" },
    { id: "size", width: "42px" }
  ];
  const metrics = getDetailsGridMetrics({
    columns,
    gap: 4,
    getColumnPixelWidth: (column) =>
      getDetailsColumnPixelWidth({
        column,
        minWidth: column.id === "kind" ? 64 : 40,
        fallbackWidth: column.id === "kind" ? 112 : 120
      })
  });

  assert.deepEqual(metrics, {
    gridTemplateColumns: "240px 112px 42px",
    width: 402
  });
});
