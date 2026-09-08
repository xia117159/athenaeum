import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getFileColorPresentation, getFileColorRowAttributes } from "./fileColorStyle";

function test(name: string, run: () => void) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("file color presentation resolves both channels when enabled", () => {
  assert.deepEqual(
    getFileColorPresentation(
      { foregroundColorHex: "#ffffff", backgroundColorHex: "#a4262c" },
      true
    ),
    {
      className: "has-color-filter has-color-filter--foreground has-color-filter--background",
      style: {
        "--entry-rule-foreground": "#ffffff",
        "--entry-rule-background": "#a4262c"
      }
    }
  );
  assert.deepEqual(
    getFileColorPresentation({ foregroundColorHex: "#005a9e", backgroundColorHex: null }, true),
    {
      className: "has-color-filter has-color-filter--foreground",
      style: { "--entry-rule-foreground": "#005a9e" }
    }
  );
  assert.deepEqual(
    getFileColorPresentation({ foregroundColorHex: null, backgroundColorHex: "#fff4ce" }, true),
    {
      className: "has-color-filter has-color-filter--background",
      style: { "--entry-rule-background": "#fff4ce" }
    }
  );
});

test("file color presentation keeps decorations dormant while globally disabled", () => {
  assert.deepEqual(
    getFileColorPresentation(
      { foregroundColorHex: "#ffffff", backgroundColorHex: "#a4262c" },
      false
    ),
    { className: "", style: undefined }
  );
});

test("file color row attributes preserve the icon accent and expose an optional class suffix", () => {
  assert.deepEqual(
    getFileColorRowAttributes(
      {
        accentColor: "#29659f",
        foregroundColorHex: "#ffffff",
        backgroundColorHex: "#a4262c"
      },
      true
    ),
    {
      classNameSuffix: " has-color-filter has-color-filter--foreground has-color-filter--background",
      style: {
        "--row-accent": "#29659f",
        "--entry-rule-foreground": "#ffffff",
        "--entry-rule-background": "#a4262c"
      }
    }
  );
  assert.deepEqual(
    getFileColorRowAttributes(
      {
        accentColor: "#29659f",
        foregroundColorHex: "#ffffff",
        backgroundColorHex: "#a4262c"
      },
      false
    ),
    {
      classNameSuffix: "",
      style: { "--row-accent": "#29659f" }
    }
  );
});

test("configured list colors keep one resolved pair on hover and standard operational states", () => {
  const css = fs.readFileSync(
    path.join(process.cwd(), "src/features/workspace/workspace.listing.css"),
    "utf8"
  );
  assert.match(css, /\.file-row\.has-color-filter--background \.file-row__grid,[\s\S]*background:\s*var\(--entry-rule-background\)/);
  assert.match(css, /\.file-row:not\(\.has-color-filter\):hover \.file-row__grid/);
  assert.match(css, /\.file-row\.has-color-filter:hover \.file-row__grid,[\s\S]*box-shadow:\s*inset 0 0 0 1px/);
  assert.doesNotMatch(css, /var\(--entry-rule-background,\s*#ffffff\)/);
  assert.match(css, /\.file-row\.is-selected \.file-row__grid,[\s\S]*box-shadow:\s*none/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*background:\s*Canvas;[\s\S]*color:\s*CanvasText/);
  assert.match(css, /\.tag-stack span\s*\{[\s\S]*?color:\s*#38516b;[\s\S]*?background:\s*#eef3f8;/);
});
