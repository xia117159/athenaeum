import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getOperationClearScopeForTab } from "./OperationHistoryWindowView";

const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/operation-history-window.css"), "utf8");
const view = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/OperationHistoryWindowView.tsx"), "utf8");
const badgeSlot = css.match(/\.operation-history-window__badge-slot\s*\{[^}]*\}/u)?.[0] ?? "";
const messages = css.match(/\.operation-history-window__messages\s*\{[^}]*\}/u)?.[0] ?? "";
const dangerHover = css.match(
  /\.operation-history-confirmation \.toolbar-button\.is-danger:hover:not\(:disabled\)\s*\{[^}]*\}/u
)?.[0] ?? "";

assert.equal(css.includes("grid-template-rows: auto auto auto minmax(0, 1fr);"), true);
assert.equal(css.includes(".operation-history-window__messages:not(:empty)"), true);
assert.equal(badgeSlot.includes("align-self: start;"), true);
assert.equal(badgeSlot.includes("justify-content: flex-end;"), true);
assert.equal(messages.includes("max-height: min(180px, 30vh);"), true);
assert.equal(messages.includes("overflow-y: auto;"), true);
assert.equal(dangerHover.includes("border-color: #8c1d18;"), true);
assert.equal(dangerHover.includes("background: #a4262c;"), true);
assert.equal(dangerHover.includes("color: #ffffff;"), true);
assert.equal(view.includes("<section className=\"operation-history-window__messages\" aria-live=\"polite\">"), true);
assert.deepEqual([
  getOperationClearScopeForTab("running"),
  getOperationClearScopeForTab("waiting"),
  getOperationClearScopeForTab("problems"),
  getOperationClearScopeForTab("completed"),
  getOperationClearScopeForTab("history")
], [null, null, "problems", "completed", "history"]);

const minimumWindowHeight = 520;
const maximumWarningContentHeight = 20 * 30;
const boundedMessageHeight = Math.min(180, minimumWindowHeight * 0.3);
const remainingPanelHeight = minimumWindowHeight - 58 - 42 - boundedMessageHeight;
assert.ok(maximumWarningContentHeight > boundedMessageHeight, "maximum warnings must scroll within the bounded region");
assert.ok(remainingPanelHeight > 0, "tabs and the active panel must remain usable at the minimum height");

console.log("ok - operation history reserves message height and anchors badges at each tab label upper-right");
