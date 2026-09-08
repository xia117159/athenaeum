import type { ColorFilterRule, ColorFilterRuleInput, RevisionToken } from "./colorFilterTypes";

const REVISION_PATTERN = /^(?:0|[1-9][0-9]*)$/;
export const COLOR_RULE_NAME_MAX_SCALARS = 128;
export const COLOR_RULE_EXPRESSION_MAX_SCALARS = 1024;

export function limitUnicodeScalars(value: string, maximum: number) {
  const scalars = Array.from(value);
  return scalars.length <= maximum ? value : scalars.slice(0, maximum).join("");
}

function assertRevisionToken(value: RevisionToken) {
  if (!REVISION_PATTERN.test(value)) {
    throw new Error(`Invalid revision token: ${value}`);
  }
}

export function compareRevisionTokens(left: RevisionToken, right: RevisionToken) {
  assertRevisionToken(left);
  assertRevisionToken(right);
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparableName(value: string) {
  return value.trim().toLocaleLowerCase("und");
}

export function getColorRuleNameErrors(rules: ColorFilterRule[]) {
  const comparableCounts = new Map<string, number>();
  for (const rule of rules) {
    const name = comparableName(rule.name);
    if (name) {
      comparableCounts.set(name, (comparableCounts.get(name) ?? 0) + 1);
    }
  }

  const errors: Record<string, string> = {};
  for (const rule of rules) {
    const name = comparableName(rule.name);
    if (!name) {
      errors[rule.id] = "规则名称不能为空。";
    } else if (Array.from(rule.name.trim()).length > COLOR_RULE_NAME_MAX_SCALARS) {
      errors[rule.id] = `规则名称不能超过 ${COLOR_RULE_NAME_MAX_SCALARS} 个 Unicode 字符。`;
    } else if ((comparableCounts.get(name) ?? 0) > 1) {
      errors[rule.id] = "规则名称必须唯一。";
    }
  }
  return errors;
}

export function hasColorRuleDraftChanges(
  rules: ColorFilterRule[],
  baselineRules: ColorFilterRule[],
  hasRawColorDraft: boolean
) {
  return hasRawColorDraft || JSON.stringify(rules) !== JSON.stringify(baselineRules);
}

function uniqueGeneratedName(
  rules: ColorFilterRule[],
  root: string,
  suffixForAttempt: (attempt: number) => string
) {
  const used = new Set(rules.map((rule) => comparableName(rule.name)));
  const rootScalars = Array.from(root.trim());
  for (let attempt = 1; ; attempt += 1) {
    const suffix = suffixForAttempt(attempt);
    const rootLimit = Math.max(0, COLOR_RULE_NAME_MAX_SCALARS - Array.from(suffix).length);
    const boundedRoot = rootScalars.slice(0, rootLimit).join("").trimEnd();
    const candidate = `${boundedRoot}${suffix}`;
    if (!used.has(comparableName(candidate))) {
      return candidate;
    }
  }
}

function normalizePriorities(rules: ColorFilterRule[]) {
  return rules.map((rule, index) => ({ ...rule, priority: index + 1 }));
}

export function addColorRule(rules: ColorFilterRule[], createId: () => string) {
  const nextRule: ColorFilterRule = {
    id: createId(),
    name: uniqueGeneratedName(rules, "新颜色规则", (attempt) => attempt === 1 ? "" : ` ${attempt}`),
    enabled: false,
    target: "any",
    expression: "",
    caseSensitive: false,
    foregroundColorHex: "#1f1f1f",
    backgroundColorHex: null,
    priority: rules.length + 1,
    migrationDiagnostic: null
  };
  return normalizePriorities([...rules, nextRule]);
}

export function duplicateColorRule(rules: ColorFilterRule[], id: string, createId: () => string) {
  const index = rules.findIndex((rule) => rule.id === id);
  if (index < 0) {
    return rules;
  }
  const source = rules[index];
  const duplicate: ColorFilterRule = {
    ...source,
    id: createId(),
    name: uniqueGeneratedName(
      rules,
      source.name,
      (attempt) => attempt === 1 ? " 副本" : ` 副本 ${attempt}`
    ),
    enabled: false,
    migrationDiagnostic: null
  };
  return normalizePriorities([...rules.slice(0, index + 1), duplicate, ...rules.slice(index + 1)]);
}

export function updateColorRule(
  rules: ColorFilterRule[],
  id: string,
  patch: Partial<Omit<ColorFilterRule, "id" | "priority">>
) {
  let changed = false;
  const updated = rules.map((rule) => {
    if (rule.id !== id) {
      return rule;
    }
    changed = true;
    const next = { ...rule, ...patch, migrationDiagnostic: null };
    if (!next.foregroundColorHex && !next.backgroundColorHex) {
      next.enabled = false;
    }
    return next;
  });
  return changed ? normalizePriorities(updated) : rules;
}

export function moveColorRule(rules: ColorFilterRule[], id: string, delta: -1 | 1) {
  const from = rules.findIndex((rule) => rule.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= rules.length) {
    return rules;
  }
  const next = [...rules];
  [next[from], next[to]] = [next[to], next[from]];
  return normalizePriorities(next);
}

export function deleteColorRule(rules: ColorFilterRule[], id: string) {
  const next = rules.filter((rule) => rule.id !== id);
  return next.length === rules.length ? rules : normalizePriorities(next);
}

export function toColorRuleInputs(rules: ColorFilterRule[]): ColorFilterRuleInput[] {
  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    target: rule.target,
    expression: rule.expression,
    caseSensitive: rule.caseSensitive,
    foregroundColorHex: rule.foregroundColorHex,
    backgroundColorHex: rule.backgroundColorHex
  }));
}
