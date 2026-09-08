export type RevisionToken = string;
export type ColorRuleTarget = "any" | "file" | "directory";

export interface ColorFilterRule {
  id: string;
  name: string;
  enabled: boolean;
  target: ColorRuleTarget;
  expression: string;
  caseSensitive: boolean;
  foregroundColorHex: string | null;
  backgroundColorHex: string | null;
  priority: number;
  migrationDiagnostic?: string | null;
}

export type ColorFilterRuleInput = Omit<ColorFilterRule, "migrationDiagnostic" | "priority">;

export interface ColorFilterConfigSnapshot {
  enabled: boolean;
  rules: ColorFilterRule[];
  revision: RevisionToken;
  rulesRevision: RevisionToken;
}

export interface ColorFilterMutationResult {
  snapshot: ColorFilterConfigSnapshot;
  warnings: string[];
}

export interface ColorFilterValidationSpan {
  start: number;
  end: number;
}

export interface ColorFilterValidationResult {
  valid: boolean;
  message: string | null;
  span: ColorFilterValidationSpan | null;
}

export interface ReplaceColorRulesRequest {
  rules: ColorFilterRuleInput[];
  baseRulesRevision: RevisionToken;
  force: boolean;
}

export interface ReplaceColorRulesResult {
  status: "applied" | "conflict";
  snapshot: ColorFilterConfigSnapshot;
  warnings: string[];
}
