import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, HelpCircle, Plus, Trash2, X } from "lucide-react";
import { HexColorPicker } from "react-colorful";
import type { ColorFilterRule, ColorFilterValidationResult } from "./colorFilterTypes";
import {
  COLOR_RULE_EXPRESSION_MAX_SCALARS,
  addColorRule,
  deleteColorRule,
  duplicateColorRule,
  getColorRuleNameErrors,
  limitUnicodeScalars,
  moveColorRule,
  updateColorRule
} from "./colorFilterEditorModel";
import "./color-rules.css";

type RuleValidationMap = Record<string, ColorFilterValidationResult>;

export type ColorRulesPageProps = {
  colorRules: ColorFilterRule[];
  disabled: boolean;
  conflict?: boolean;
  onChange: (rules: ColorFilterRule[]) => void;
  onHelp: () => void;
  onReload?: () => void;
  onOverwrite?: () => void;
  onValidationChange?: (valid: boolean) => void;
  onDraftDirtyChange?: (dirty: boolean) => void;
  resetToken?: string | number;
  validateRule: (expression: string) => Promise<ColorFilterValidationResult>;
};

function createRuleId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `color-rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeHex(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function luminance(color: string) {
  const values = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const linear = values.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function ColorControl({
  controlKey,
  label,
  value,
  disabled,
  onChange,
  onValidityChange,
  onDraftDirtyChange,
  resetToken
}: {
  controlKey: string;
  label: string;
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
  onValidityChange: (key: string, valid: boolean) => void;
  onDraftDirtyChange: (key: string, dirty: boolean) => void;
  resetToken: string | number;
}) {
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(value ?? "");
  const pickerValue = value ?? "#ffffff";
  const invalid = draftValue.length > 0 && !normalizeHex(draftValue);
  const diagnosticId = `color-rule-color-error-${controlKey}`;
  useEffect(() => {
    setDraftValue(value ?? "");
    onValidityChange(controlKey, true);
    onDraftDirtyChange(controlKey, false);
  }, [value, resetToken]);
  useEffect(() => () => {
    onValidityChange(controlKey, true);
    onDraftDirtyChange(controlKey, false);
  }, [controlKey]);
  return (
    <div className="color-rule-color-control">
      <button
        type="button"
        className="color-rule-swatch"
        aria-label={`${label}：${value ?? "未设置"}`}
        title={`选择${label}`}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span style={{ backgroundColor: value ?? "transparent" }} />
      </button>
      <input
        aria-label={`${label}十六进制值`}
        aria-describedby={invalid ? diagnosticId : undefined}
        aria-invalid={invalid}
        value={draftValue}
        placeholder="未设置"
        disabled={disabled}
        onInput={(event) => {
          const nextValue = event.currentTarget.value;
          setDraftValue(nextValue);
          onDraftDirtyChange(controlKey, nextValue !== (value ?? ""));
          const normalized = normalizeHex(nextValue);
          onValidityChange(controlKey, Boolean(normalized) || !nextValue);
          if (normalized) {
            onChange(normalized);
          } else if (!nextValue) {
            onChange(null);
          }
        }}
      />
      <button
        type="button"
        className="color-rule-icon-button"
        aria-label={`清除${label}`}
        title={`清除${label}`}
        disabled={disabled || !draftValue}
        onClick={() => {
          setDraftValue("");
          onValidityChange(controlKey, true);
          onDraftDirtyChange(controlKey, Boolean(value));
          onChange(null);
        }}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="color-rule-picker" role="dialog" aria-label={`${label}选择器`}>
          <HexColorPicker color={pickerValue} onChange={(nextValue) => {
            setDraftValue(nextValue);
            onValidityChange(controlKey, true);
            onDraftDirtyChange(controlKey, nextValue !== (value ?? ""));
            onChange(nextValue);
          }} />
        </div>
      ) : null}
      {invalid ? (
        <span id={diagnosticId} className="color-rule-color-diagnostic" role="status">
          颜色必须使用 #RRGGBB 格式。
        </span>
      ) : null}
    </div>
  );
}

export function ColorRulesPage({
  colorRules,
  disabled,
  conflict = false,
  onChange,
  onHelp,
  onReload,
  onOverwrite,
  onValidationChange,
  onDraftDirtyChange,
  resetToken = 0,
  validateRule
}: ColorRulesPageProps) {
  const [validation, setValidation] = useState<RuleValidationMap>({});
  const [validationError, setValidationError] = useState(false);
  const [validationRetryToken, setValidationRetryToken] = useState(0);
  const [invalidColorInputs, setInvalidColorInputs] = useState<Set<string>>(() => new Set());
  const [dirtyColorInputs, setDirtyColorInputs] = useState<Set<string>>(() => new Set());
  const validationRun = useRef(0);
  const untouchedNewRules = useRef(new Map<string, ColorFilterRule>());
  const nameErrors = useMemo(() => getColorRuleNameErrors(colorRules), [colorRules]);

  useEffect(() => {
    setInvalidColorInputs(new Set());
    setDirtyColorInputs(new Set());
  }, [resetToken]);

  useEffect(() => {
    onDraftDirtyChange?.(dirtyColorInputs.size > 0);
  }, [dirtyColorInputs, onDraftDirtyChange]);

  useEffect(() => () => onDraftDirtyChange?.(false), []);

  useEffect(() => {
    const run = ++validationRun.current;
    onValidationChange?.(false);
    setValidationError(false);
    const timer = window.setTimeout(() => {
      void Promise.all(
        colorRules.map(async (rule) => [rule.id, await validateRule(rule.expression)] as const)
      ).then((results) => {
        if (run !== validationRun.current) return;
        const next = Object.fromEntries(results);
        setValidation(next);
        setValidationError(false);
        onValidationChange?.(
          colorRules.every((rule) => !rule.enabled || next[rule.id]?.valid === true) &&
          Object.keys(nameErrors).length === 0 &&
          invalidColorInputs.size === 0
        );
      }).catch(() => {
        if (run !== validationRun.current) return;
        setValidationError(true);
        onValidationChange?.(false);
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [
    colorRules,
    invalidColorInputs,
    nameErrors,
    onValidationChange,
    validateRule,
    validationRetryToken
  ]);

  useEffect(() => {
    const liveIds = new Set(colorRules.map((rule) => rule.id));
    for (const id of untouchedNewRules.current.keys()) {
      if (!liveIds.has(id)) untouchedNewRules.current.delete(id);
    }
  }, [colorRules]);

  const update = (id: string, patch: Partial<Omit<ColorFilterRule, "id" | "priority">>) => {
    onChange(updateColorRule(colorRules, id, patch));
  };

  const updateColorValidity = (key: string, valid: boolean) => {
    setInvalidColorInputs((current) => {
      const hasKey = current.has(key);
      if (hasKey === !valid) return current;
      const next = new Set(current);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updateColorDraftDirty = (key: string, dirty: boolean) => {
    setDirtyColorInputs((current) => {
      const hasKey = current.has(key);
      if (hasKey === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const addRule = () => {
    const next = addColorRule(colorRules, createRuleId);
    const added = next.find((rule) => !colorRules.some((current) => current.id === rule.id));
    if (added) untouchedNewRules.current.set(added.id, added);
    onChange(next);
  };

  const deleteRule = (rule: ColorFilterRule) => {
    const untouched = untouchedNewRules.current.get(rule.id);
    const requiresConfirmation = !untouched || JSON.stringify(untouched) !== JSON.stringify(rule);
    if (requiresConfirmation && !window.confirm(`确定删除颜色规则“${rule.name}”吗？`)) return;
    untouchedNewRules.current.delete(rule.id);
    onChange(deleteColorRule(colorRules, rule.id));
  };

  return (
    <div className="settings-page color-rules-page">
      <header className="color-rules-commandbar">
        <div>
          <strong>颜色过滤规则</strong>
        </div>
        <div className="color-rules-commandbar__actions">
          <button type="button" className="toolbar-button toolbar-button--ghost" onClick={onHelp} disabled={disabled}>
            <HelpCircle size={15} aria-hidden="true" />
            帮助
          </button>
          <button
            type="button"
            className="toolbar-button"
            disabled={disabled || colorRules.length >= 256}
            onClick={addRule}
          >
            <Plus size={15} aria-hidden="true" />
            新增规则
          </button>
        </div>
      </header>

      {conflict ? (
        <div className="color-rules-conflict" role="alert">
          <span>规则已在其他窗口中修改。可重新加载远端版本，或明确覆盖。</span>
          <button type="button" className="toolbar-button toolbar-button--ghost" onClick={onReload} disabled={disabled}>重新加载</button>
          <button type="button" className="toolbar-button" onClick={onOverwrite} disabled={disabled}>覆盖保存</button>
        </div>
      ) : null}

      {validationError ? (
        <div className="color-rules-validation-error" role="alert">
          <span>规则验证失败，请重试。</span>
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            disabled={disabled}
            onClick={() => setValidationRetryToken((current) => current + 1)}
          >
            重试
          </button>
        </div>
      ) : null}

      <div className="color-rules-table-wrap">
        <table className="color-rules-table">
          <thead>
            <tr>
              <th className="color-rules-table__enabled">启用</th>
              <th className="color-rules-table__order">优先级</th>
              <th>名称和范围</th>
              <th>匹配表达式</th>
              <th>文字色</th>
              <th>背景色</th>
              <th className="color-rules-table__actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {colorRules.length === 0 ? (
              <tr><td colSpan={7} className="color-rules-empty">暂无颜色规则</td></tr>
            ) : colorRules.map((rule, index) => {
              const result = validation[rule.id];
              const diagnostic = rule.migrationDiagnostic ?? (result?.valid === false ? result.message : null);
              const diagnosticId = `color-rule-expression-error-${rule.id}`;
              const nameError = nameErrors[rule.id];
              const nameErrorId = `color-rule-name-error-${rule.id}`;
              const foreground = rule.foregroundColorHex ?? "#1f1f1f";
              const background = rule.backgroundColorHex ?? "#ffffff";
              const lowContrast = contrastRatio(foreground, background) < 4.5;
              return (
                <tr key={rule.id} className={!rule.enabled ? "is-disabled" : undefined}>
                  <td className="color-rules-table__enabled">
                    <input
                      type="checkbox"
                      aria-label={`启用规则 ${rule.name}`}
                      checked={rule.enabled}
                      disabled={disabled || (!rule.foregroundColorHex && !rule.backgroundColorHex)}
                      onChange={(event) => update(rule.id, { enabled: event.currentTarget.checked })}
                    />
                  </td>
                  <td className="color-rules-table__order">{index + 1}</td>
                  <td>
                    <input
                      className={nameError ? "color-rule-name is-invalid" : "color-rule-name"}
                      aria-label={`规则 ${index + 1} 名称`}
                      aria-describedby={nameError ? nameErrorId : undefined}
                      aria-invalid={Boolean(nameError)}
                      value={rule.name}
                      disabled={disabled}
                      onChange={(event) => update(rule.id, {
                        name: event.currentTarget.value
                      })}
                    />
                    {nameError ? <span id={nameErrorId} className="color-rule-diagnostic" role="status">{nameError}</span> : null}
                    <div className="color-rule-inline-options">
                      <select
                        aria-label={`规则 ${rule.name} 目标`}
                        value={rule.target}
                        disabled={disabled}
                        onChange={(event) => update(rule.id, { target: event.currentTarget.value as ColorFilterRule["target"] })}
                      >
                        <option value="any">文件和文件夹</option>
                        <option value="file">仅文件</option>
                        <option value="directory">仅文件夹</option>
                      </select>
                      <label>
                        <input
                          type="checkbox"
                          checked={rule.caseSensitive}
                          disabled={disabled}
                          onChange={(event) => update(rule.id, { caseSensitive: event.currentTarget.checked })}
                        />
                        区分大小写
                      </label>
                    </div>
                  </td>
                  <td>
                    <input
                      className={diagnostic ? "color-rule-expression is-invalid" : "color-rule-expression"}
                      aria-label={`规则 ${rule.name} 表达式`}
                      aria-describedby={diagnostic ? diagnosticId : undefined}
                      aria-invalid={Boolean(diagnostic)}
                      value={rule.expression}
                      disabled={disabled}
                      onChange={(event) => update(rule.id, {
                        expression: limitUnicodeScalars(
                          event.currentTarget.value,
                          COLOR_RULE_EXPRESSION_MAX_SCALARS
                        )
                      })}
                    />
                    {diagnostic ? <span id={diagnosticId} className="color-rule-diagnostic" role="status">{diagnostic}</span> : null}
                    {lowContrast ? <span className="color-rule-contrast">文字与背景对比度较低</span> : null}
                    <span className="color-rule-preview" style={{ color: foreground, backgroundColor: background }}>示例文件.txt</span>
                  </td>
                  <td><ColorControl controlKey={`${rule.id}-foreground`} label="文字颜色" value={rule.foregroundColorHex} disabled={disabled} onChange={(value) => update(rule.id, { foregroundColorHex: value })} onValidityChange={updateColorValidity} onDraftDirtyChange={updateColorDraftDirty} resetToken={resetToken} /></td>
                  <td><ColorControl controlKey={`${rule.id}-background`} label="背景颜色" value={rule.backgroundColorHex} disabled={disabled} onChange={(value) => update(rule.id, { backgroundColorHex: value })} onValidityChange={updateColorValidity} onDraftDirtyChange={updateColorDraftDirty} resetToken={resetToken} /></td>
                  <td className="color-rules-table__actions">
                    <button type="button" className="color-rule-icon-button" aria-label={`上移规则 ${rule.name}`} title="上移" disabled={disabled || index === 0} onClick={() => onChange(moveColorRule(colorRules, rule.id, -1))}><ArrowUp size={15} /></button>
                    <button type="button" className="color-rule-icon-button" aria-label={`下移规则 ${rule.name}`} title="下移" disabled={disabled || index === colorRules.length - 1} onClick={() => onChange(moveColorRule(colorRules, rule.id, 1))}><ArrowDown size={15} /></button>
                    <button type="button" className="color-rule-icon-button" aria-label={`复制规则 ${rule.name}`} title="复制" disabled={disabled || colorRules.length >= 256} onClick={() => onChange(duplicateColorRule(colorRules, rule.id, createRuleId))}><Copy size={15} /></button>
                    <button type="button" className="color-rule-icon-button color-rule-icon-button--danger" aria-label={`删除规则 ${rule.name}`} title="删除" disabled={disabled} onClick={() => deleteRule(rule)}><Trash2 size={15} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
