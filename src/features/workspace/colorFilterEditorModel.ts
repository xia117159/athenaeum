import type { ColorFilterRule, ColorFilterRuleInput, RevisionToken } from "./colorFilterTypes";

const REVISION_PATTERN = /^(?:0|[1-9][0-9]*)$/;
export const COLOR_RULE_NAME_MAX_SCALARS = 128;
export const COLOR_RULE_EXPRESSION_MAX_SCALARS = 1024;
export const COLOR_RULE_LIMIT = 256;

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

/**
 * 删除后的确定性选中：删除索引 i 后优先选择现在占据 i 的规则（原下一条）；
 * i 是末条时选择前一条；列表为空时清除选择。被删除 id 不存在时返回 null，
 * 由调用方保留其当前选择。
 */
export function getColorRuleSelectionAfterDelete(rules: ColorFilterRule[], deletedId: string): string | null {
  const index = rules.findIndex((rule) => rule.id === deletedId);
  if (index < 0) {
    return null;
  }
  const survivors = rules.filter((rule) => rule.id !== deletedId);
  if (survivors.length === 0) {
    return null;
  }
  const nextIndex = Math.min(index, survivors.length - 1);
  return survivors[nextIndex].id;
}

/**
 * 权威重置时的选中收敛：selectedId 仍存在则保留；否则回退到
 * clamp 后的最近存活索引；列表为空时清除选择。
 */
export function resolveColorRuleSelection(
  rules: ColorFilterRule[],
  selectedId: string | null,
  fallbackIndex = 0
): string | null {
  if (selectedId && rules.some((rule) => rule.id === selectedId)) {
    return selectedId;
  }
  if (rules.length === 0) {
    return null;
  }
  const index = Math.min(Math.max(Math.trunc(fallbackIndex), 0), rules.length - 1);
  return rules[index].id;
}

export type ColorRuleOperationEnablement = {
  canAdd: boolean;
  atLimit: boolean;
  canOperateSelected: boolean;
};

/** V2 操作面板启用逻辑：新建受可编辑状态与 256 上限约束；其余操作要求存在选中规则。 */
export function getColorRuleOperationEnablement(options: {
  ruleCount: number;
  hasSelection: boolean;
  editable: boolean;
}): ColorRuleOperationEnablement {
  const atLimit = options.ruleCount >= COLOR_RULE_LIMIT;
  return {
    canAdd: options.editable && !atLimit,
    atLimit,
    canOperateSelected: options.editable && options.hasSelection
  };
}
