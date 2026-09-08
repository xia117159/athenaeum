import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLOR_RULE_EXPRESSION_MAX_SCALARS,
  COLOR_RULE_NAME_MAX_SCALARS,
  addColorRule,
  compareRevisionTokens,
  duplicateColorRule,
  getColorRuleNameErrors,
  hasColorRuleDraftChanges,
  limitUnicodeScalars,
  moveColorRule,
  toColorRuleInputs,
  updateColorRule
} from "./colorFilterEditorModel";
import type { ColorFilterRule } from "./colorFilterTypes";

const baseRule: ColorFilterRule = {
  id: "rule-1",
  name: "Logs",
  enabled: true,
  target: "any",
  expression: "*.log",
  caseSensitive: false,
  foregroundColorHex: "#ffffff",
  backgroundColorHex: "#a4262c",
  priority: 1,
  migrationDiagnostic: null
};

test("revision tokens compare exactly beyond JavaScript safe integers", () => {
  assert.equal(compareRevisionTokens("9007199254740992", "9007199254740991"), 1);
  assert.equal(compareRevisionTokens("18446744073709551615", "18446744073709551615"), 0);
  assert.equal(compareRevisionTokens("9", "10"), -1);
  assert.throws(() => compareRevisionTokens("01", "1"), /revision/i);
});

test("repeated add and duplicate actions create collision-free names", () => {
  let rules: ColorFilterRule[] = [];
  rules = addColorRule(rules, () => "new-1");
  rules = addColorRule(rules, () => "new-2");
  rules = duplicateColorRule([baseRule, ...rules], "rule-1", () => "copy-1");
  rules = duplicateColorRule(rules, "rule-1", () => "copy-2");

  assert.deepEqual(
    rules.map((rule) => rule.name),
    ["Logs", "Logs 副本 2", "Logs 副本", "新颜色规则", "新颜色规则 2"]
  );
  assert.equal(rules[1].enabled, false);
  assert.deepEqual(rules.map((rule) => rule.priority), [1, 2, 3, 4, 5]);
});

test("clearing both colors disables a rule and adding one back keeps it disabled", () => {
  let rules = updateColorRule([baseRule], "rule-1", { foregroundColorHex: null });
  assert.equal(rules[0].enabled, true);

  rules = updateColorRule(rules, "rule-1", { backgroundColorHex: null });
  assert.equal(rules[0].enabled, false);

  rules = updateColorRule(rules, "rule-1", { foregroundColorHex: "#1f1f1f" });
  assert.equal(rules[0].enabled, false);
});

test("move preserves stable order and contiguous priorities", () => {
  const rules = [
    baseRule,
    { ...baseRule, id: "rule-2", name: "Text", priority: 2 },
    { ...baseRule, id: "rule-3", name: "Large", priority: 3 }
  ];

  const moved = moveColorRule(rules, "rule-3", -1);
  assert.deepEqual(moved.map((rule) => rule.id), ["rule-1", "rule-3", "rule-2"]);
  assert.deepEqual(moved.map((rule) => rule.priority), [1, 2, 3]);
  assert.equal(moveColorRule(moved, "rule-1", -1), moved);
});

test("rule names are required and unique after trim and case folding", () => {
  const errors = getColorRuleNameErrors([
    { ...baseRule, id: "blank", name: "   " },
    { ...baseRule, id: "first", name: " Personal " },
    { ...baseRule, id: "second", name: "personal" },
    { ...baseRule, id: "unicode-a", name: "Ä" },
    { ...baseRule, id: "unicode-b", name: "ä" }
  ]);

  assert.match(errors.blank ?? "", /不能为空/);
  assert.match(errors.first ?? "", /必须唯一/);
  assert.match(errors.second ?? "", /必须唯一/);
  assert.match(errors["unicode-a"] ?? "", /必须唯一/);
  assert.match(errors["unicode-b"] ?? "", /必须唯一/);
});

test("rule name validation uses trimmed Unicode scalar length", () => {
  const atLimit = ` ${"x".repeat(COLOR_RULE_NAME_MAX_SCALARS)} `;
  const overLimit = "x".repeat(COLOR_RULE_NAME_MAX_SCALARS + 1);
  const astralOverLimit = "\u{1f642}".repeat(COLOR_RULE_NAME_MAX_SCALARS + 1);
  const errors = getColorRuleNameErrors([
    { ...baseRule, id: "at-limit", name: atLimit },
    { ...baseRule, id: "over-limit", name: overLimit },
    { ...baseRule, id: "astral-over-limit", name: astralOverLimit }
  ]);

  assert.equal(errors["at-limit"], undefined);
  assert.match(errors["over-limit"] ?? "", /128/);
  assert.match(errors["astral-over-limit"] ?? "", /128/);
});

test("duplicating a maximum-length rule creates a bounded unique name", () => {
  const source = { ...baseRule, name: "x".repeat(COLOR_RULE_NAME_MAX_SCALARS) };
  let rules = duplicateColorRule([source], source.id, () => "copy-1");
  rules = duplicateColorRule(rules, source.id, () => "copy-2");

  assert.equal(new Set(rules.map((rule) => rule.name.trim().toLocaleLowerCase("und"))).size, 3);
  assert.equal(rules.every((rule) => Array.from(rule.name.trim()).length <= COLOR_RULE_NAME_MAX_SCALARS), true);
  assert.deepEqual(getColorRuleNameErrors(rules), {});
});

test("raw invalid color edits participate in the rule draft conflict contract", () => {
  assert.equal(hasColorRuleDraftChanges([baseRule], [baseRule], false), false);
  assert.equal(hasColorRuleDraftChanges([baseRule], [baseRule], true), true);
  assert.equal(
    hasColorRuleDraftChanges([{ ...baseRule, expression: "*.txt" }], [baseRule], false),
    true
  );
});

test("replacement inputs use an explicit editable-field allowlist", () => {
  const backendRule = {
    ...baseRule,
    schemaVersion: 2,
    migrationSource: { future: true }
  };

  assert.deepEqual(toColorRuleInputs([backendRule]), [{
    id: "rule-1",
    name: "Logs",
    enabled: true,
    target: "any",
    expression: "*.log",
    caseSensitive: false,
    foregroundColorHex: "#ffffff",
    backgroundColorHex: "#a4262c"
  }]);
});

test("editor limits count Unicode scalar values", () => {
  const name = "😀".repeat(COLOR_RULE_NAME_MAX_SCALARS + 1);
  const expression = "😀".repeat(COLOR_RULE_EXPRESSION_MAX_SCALARS + 1);

  assert.equal(
    Array.from(limitUnicodeScalars(name, COLOR_RULE_NAME_MAX_SCALARS)).length,
    COLOR_RULE_NAME_MAX_SCALARS
  );
  assert.equal(
    Array.from(limitUnicodeScalars(expression, COLOR_RULE_EXPRESSION_MAX_SCALARS)).length,
    COLOR_RULE_EXPRESSION_MAX_SCALARS
  );
});
