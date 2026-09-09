import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getFileColorLabelAttributes, getFileColorPresentation, getFileColorRowAttributes } from "./fileColorStyle";

function test(name: string, run: () => void) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("file color presentation keeps rule foreground on the entry and rule background on the name label", () => {
  assert.deepEqual(
    getFileColorPresentation(
      { foregroundColorHex: "#ffffff", backgroundColorHex: "#a4262c" },
      true
    ),
    {
      className: "has-color-filter has-color-filter--foreground",
      style: { "--entry-rule-foreground": "#ffffff" },
      labelClassName: "entry-name__label--rule-background",
      labelStyle: { "--entry-rule-background": "#a4262c" }
    }
  );
  assert.deepEqual(
    getFileColorPresentation({ foregroundColorHex: "#005a9e", backgroundColorHex: null }, true),
    {
      className: "has-color-filter has-color-filter--foreground",
      style: { "--entry-rule-foreground": "#005a9e" },
      labelClassName: "",
      labelStyle: undefined
    }
  );
  assert.deepEqual(
    getFileColorPresentation({ foregroundColorHex: null, backgroundColorHex: "#fff4ce" }, true),
    {
      className: "has-color-filter",
      style: undefined,
      labelClassName: "entry-name__label--rule-background",
      labelStyle: { "--entry-rule-background": "#fff4ce" }
    }
  );
  assert.deepEqual(
    getFileColorPresentation({ foregroundColorHex: null, backgroundColorHex: null }, true),
    {
      className: "",
      style: undefined,
      labelClassName: "",
      labelStyle: undefined
    }
  );
});

test("file color presentation keeps decorations dormant while globally disabled", () => {
  assert.deepEqual(
    getFileColorPresentation(
      { foregroundColorHex: "#ffffff", backgroundColorHex: "#a4262c" },
      false
    ),
    { className: "", style: undefined, labelClassName: "", labelStyle: undefined }
  );
});

test("file color row attributes carry the icon accent and foreground but never the row background variable", () => {
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
      classNameSuffix: " has-color-filter has-color-filter--foreground",
      style: {
        "--row-accent": "#29659f",
        "--entry-rule-foreground": "#ffffff"
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

test("file color label attributes expose only the name-label background", () => {
  assert.deepEqual(
    getFileColorLabelAttributes(
      { foregroundColorHex: "#ffffff", backgroundColorHex: "#a4262c" },
      true
    ),
    {
      className: "entry-name__label--rule-background",
      style: { "--entry-rule-background": "#a4262c" }
    }
  );
  assert.deepEqual(
    getFileColorLabelAttributes({ foregroundColorHex: "#005a9e", backgroundColorHex: null }, true),
    { className: "", style: undefined }
  );
  assert.deepEqual(
    getFileColorLabelAttributes(
      { foregroundColorHex: "#ffffff", backgroundColorHex: "#a4262c" },
      false
    ),
    { className: "", style: undefined }
  );
});

test("configured list colors paint the name-label background and keep foreground on entry text", () => {
  const css = fs.readFileSync(
    path.join(process.cwd(), "src/features/workspace/workspace.listing.css"),
    "utf8"
  );
  // 背景只涂在名称标签，宽度即名称内容宽度，且多行卡片标题按行克隆背景。
  assert.match(css, /\.entry-name__label--rule-background\s*\{[^}]*background:\s*var\(--entry-rule-background\)/);
  assert.match(css, /\.entry-name__label--rule-background\s*\{[^}]*box-decoration-break:\s*clone/);
  // 行/卡片/网格表面不再消费规则背景变量。
  assert.doesNotMatch(css, /\.file-row\.has-color-filter--background[^{]*\{/);
  assert.doesNotMatch(css, /\.file-card\.has-color-filter--background[^{]*\{/);
  assert.doesNotMatch(css, /\.file-list-item\.has-color-filter--background[^{]*\{/);
  assert.doesNotMatch(css, /\.file-content-item\.has-color-filter--background[^{]*\{/);
  // 选中态只作用于周围表面，配置前景在选中后仍然保留。
  assert.match(css, /\.file-row\.is-selected \.file-row__grid,[\s\S]*?background:\s*#cfe8ff/);
  assert.match(css, /\.has-color-filter--foreground\.is-selected[^{]*\{[^}]*color:\s*var\(--entry-rule-foreground\)/);
  assert.match(css, /\.has-color-filter--foreground\.is-selected:hover[^{]*\{[^}]*color:\s*var\(--entry-rule-foreground\)/);
  // details 视图：选中/拖放/内联编辑的文本覆盖作用于 .file-row__grid（含 :hover 组合，0,5,0），
  // 网格级前景回写必须位于所有这些覆盖之后，才能按级联源顺序取胜。
  const selectedGridOverride = css.indexOf(".file-row.is-selected .file-row__grid");
  const selectedHoverOverride = css.indexOf(".file-row.has-color-filter.is-selected:hover .file-row__grid");
  const dropHoverOverride = css.indexOf(".file-row.has-color-filter.is-drop-target:hover .file-row__grid");
  const inlineHoverOverride = css.indexOf(".file-row.has-color-filter.is-inline-editing:hover .file-row__grid");
  const gridForegroundRestore = css.indexOf(
    ".file-row.has-color-filter--foreground.is-selected .file-row__grid"
  );
  assert.ok(gridForegroundRestore > selectedGridOverride, "grid-level foreground restore must follow the selection text override");
  assert.ok(gridForegroundRestore > selectedHoverOverride, "grid-level foreground restore must follow the selection:hover override");
  assert.ok(gridForegroundRestore > dropHoverOverride, "grid-level foreground restore must follow the drop-target:hover override");
  assert.ok(gridForegroundRestore > inlineHoverOverride, "grid-level foreground restore must follow the inline-editing:hover override");
  assert.ok(css.indexOf("@media (forced-colors: active)") > gridForegroundRestore, "forced-colors overrides stay after the restore block");
  assert.match(css, /\.file-row\.has-color-filter--foreground\.is-selected \.file-row__grid[^{]*\{[^}]*color:\s*var\(--entry-rule-foreground\)/);
  assert.match(css, /\.file-row\.has-color-filter--foreground\.is-selected:hover \.file-row__grid[^{]*\{[^}]*color:\s*var\(--entry-rule-foreground\)/);
  assert.match(css, /\.file-row\.has-color-filter--foreground\.is-drop-target \.file-row__grid[^{]*\{[^}]*color:\s*var\(--entry-rule-foreground\)/);
  assert.match(css, /\.file-row\.has-color-filter--foreground\.is-drop-target:hover \.file-row__grid[^{]*\{[^}]*color:\s*var\(--entry-rule-foreground\)/);
  assert.match(css, /\.file-row\.has-color-filter--foreground\.is-system-drop-target:hover \.file-row__grid[^{]*\{[^}]*color:\s*var\(--entry-rule-foreground\)/);
  assert.match(css, /\.file-row\.has-color-filter--foreground\.is-inline-editing:hover \.file-row__grid[^{]*\{[^}]*color:\s*var\(--entry-rule-foreground\)/);
  // 元数据文本继续继承规则前景。
  assert.match(css, /\.has-color-filter--foreground \.file-card__tile-type/);
  assert.match(css, /\.has-color-filter--foreground \.file-content-item__meta/);
  assert.doesNotMatch(css, /var\(--entry-rule-background,\s*#ffffff\)/);
  assert.match(css, /\.file-row\.is-selected \.file-row__grid,[\s\S]*box-shadow:\s*none/);
  // forced-colors：名称标签背景回退到系统色。
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*background:\s*Canvas;[\s\S]*color:\s*CanvasText/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.entry-name__label--rule-background\s*\{[^}]*background:\s*Canvas/);
  assert.match(css, /\.tag-stack span\s*\{[\s\S]*?color:\s*#38516b;[\s\S]*?background:\s*#eef3f8;/);
});

test("rule name-label background extends one space on the left and three on the right without moving the text", () => {
  const css = fs.readFileSync(
    path.join(process.cwd(), "src/features/workspace/workspace.listing.css"),
    "utf8"
  );
  // 背景块左扩 1 个空格、右扩 3 个空格：padding 扩展背景，负 margin 等量回缩保持文字对齐。
  // 四值简写显式区分左右（双值简写会错误地让左右相等）。
  // 底部额外 +1px/-1px：字体 ascent 到字冠的间隙比基线到底部大 ~1px（12px 字号），
  // 补齐后文字在背景区域内垂直居中。
  const labelBlock = css.match(/\.entry-name__label--rule-background\s*\{[^}]*\}/)![0];
  assert.match(labelBlock, /padding:\s*0\s+0\.75em\s+1px\s+0\.25em/);
  assert.match(labelBlock, /margin:\s*0\s+-0\.75em\s+-1px\s+-0\.25em/);
});

test("file listing resolves selection membership through a Set without row-level color-rule evaluation", () => {
  const listingSource = fs.readFileSync(
    path.join(process.cwd(), "src/features/workspace/FileListing.tsx"),
    "utf8"
  );
  assert.match(listingSource, /new Set\(selectedEntryIds\)/);
  assert.doesNotMatch(listingSource, /selectedEntryIds\.includes\(/);
  // 选择路径不得重新执行颜色规则求值：列表只消费已解析的条目颜色字段。
  assert.doesNotMatch(listingSource, /matchColorFilter|evaluateColorRules|colorRuleMatcher/);
  assert.doesNotMatch(listingSource, /entrySelectionChanged/);
});
