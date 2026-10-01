import assert from "node:assert/strict";
import { test } from "node:test";
import { getMarqueeEntryIds, isScrollbarPointer, toListingContentPoint } from "./fileListingMarquee";

const entries = Array.from({ length: 20_000 }, (_, index) => ({ id: `file-${index}`, inlineCreate: false }));
const measurements = Array.from({ length: 20_000 }, (_, index) => ({ index, start: 24 + index * 24, end: 48 + index * 24, size: 24 }));

test("marquee uses the scrolled body coordinate system and the sticky header offset", () => {
  const point = toListingContentPoint(15, 74, { left: 0, top: -240, right: 800, bottom: 480 });
  assert.deepEqual(point, { x: 15, y: 314 });
  assert.deepEqual(getMarqueeEntryIds({
    entries, measurements, rect: { left: 0, top: 312, right: 60, bottom: 336 },
    bodyWidth: 800, padding: 0, scrollMargin: 24, columns: 1, gap: 0
  }), ["file-13"]);
});

test("marquee checks only intersecting rows in a 20k list", () => {
  let reads = 0;
  const counted = new Proxy(measurements, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  const ids = getMarqueeEntryIds({
    entries, measurements: counted, rect: { left: 0, top: 12_000, right: 60, bottom: 12_048 },
    bodyWidth: 800, padding: 0, scrollMargin: 24, columns: 1, gap: 0
  });
  assert.deepEqual(ids, ["file-500", "file-501"]);
  assert.ok(reads < 50, `${reads} measurement reads for two rows`);
});

test("marquee uses card columns and body padding without selecting adjacent cells", () => {
  const grid = [{ index: 0, start: 0, end: 80, size: 80 }, { index: 1, start: 80, end: 160, size: 80 }];
  assert.deepEqual(getMarqueeEntryIds({
    entries, measurements: grid, rect: { left: 270, top: 8, right: 310, bottom: 84 },
    bodyWidth: 800, padding: 6, scrollMargin: 0, columns: 3, gap: 6
  }), ["file-1"]);
  assert.deepEqual(getMarqueeEntryIds({
    entries, measurements: grid, rect: { left: 6, top: 90, right: 30, bottom: 100 },
    bodyWidth: 800, padding: 6, scrollMargin: 0, columns: 3, gap: 6
  }), ["file-3"]);
});

test("scrollbar presses are recognised only inside the scroll container's scrollbar gutters", () => {
  // 400x200 border box at (100, 40) with 17px scrollbars on the right and bottom.
  const withScrollbars = {
    getBoundingClientRect: () => ({ left: 100, top: 40 }),
    offsetWidth: 400, clientWidth: 383, clientLeft: 0, offsetHeight: 200, clientHeight: 183, clientTop: 0
  } as unknown as HTMLElement;
  assert.equal(isScrollbarPointer(withScrollbars, 492, 120), true, "vertical scrollbar");
  assert.equal(isScrollbarPointer(withScrollbars, 300, 232), true, "horizontal scrollbar");
  assert.equal(isScrollbarPointer(withScrollbars, 470, 200), false, "content beside the scrollbars");
  const withoutScrollbars = { ...withScrollbars, clientWidth: 400, clientHeight: 200, getBoundingClientRect: withScrollbars.getBoundingClientRect } as unknown as HTMLElement;
  assert.equal(isScrollbarPointer(withoutScrollbars, 492, 120), false, "no gutter, no scrollbar press");
});
