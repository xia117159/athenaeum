import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowDown, ArrowUp, HelpCircle, Pencil, Plus, Trash2 } from "lucide-react";
import type { ColorFilterRule, ColorFilterValidationResult } from "./colorFilterTypes";
import { ColorRuleColorControl } from "./ColorRuleColorControl";
import {
  COLOR_RULE_EXPRESSION_MAX_SCALARS,
  addColorRule,
  deleteColorRule,
  getColorRuleNameErrors,
  getColorRuleOperationEnablement,
  getColorRuleSelectionAfterDelete,
  limitUnicodeScalars,
  moveColorRule,
  resolveColorRuleSelection,
  updateColorRule
} from "./colorFilterEditorModel";
import "./color-rules.css";

type RuleValidationMap = Record<string, ColorFilterValidationResult>;
type ExpressionEditingState = { id: string; draft: string } | null;

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExpressionEditingState>(null);
  const [validation, setValidation] = useState<RuleValidationMap>({});
  const [validationError, setValidationError] = useState(false);
  const [validationRetryToken, setValidationRetryToken] = useState(0);
  const [invalidColorInputs, setInvalidColorInputs] = useState<Set<string>>(() => new Set());
  const [dirtyColorInputs, setDirtyColorInputs] = useState<Set<string>>(() => new Set());
  // 同页颜色弹层互斥展开：记录唯一展开的控件 key（null 表示全部关闭）。
  const [openColorControlKey, setOpenColorControlKey] = useState<string | null>(null);
  const validationRun = useRef(0);
  const untouchedNewRules = useRef(new Map<string, ColorFilterRule>());
  const editingRef = useRef<ExpressionEditingState>(null);
  const expressionInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const previousSelectedIndexRef = useRef(0);
  const focusRowAfterCommitRef = useRef(false);
  const selectedIndex = colorRules.findIndex((rule) => rule.id === selectedId);
  const selectedRule = selectedIndex >= 0 ? colorRules[selectedIndex] : null;
  const nameErrors = useMemo(() => getColorRuleNameErrors(colorRules), [colorRules]);
  const enablement = getColorRuleOperationEnablement({
    ruleCount: colorRules.length,
    hasSelection: selectedRule !== null,
    editable: !disabled
  });
  editingRef.current = editing;

  useEffect(() => {
    if (selectedRule) {
      previousSelectedIndexRef.current = selectedIndex;
    }
  }, [selectedRule, selectedIndex]);

  // 权威重置：清除未提交的颜色草稿，并关闭表达式编辑态与颜色弹层（规格：重置收尾关闭编辑），
  // 防止失效草稿在重载快照上通过 blur 提交。
  useEffect(() => {
    setInvalidColorInputs((current) => (current.size === 0 ? current : new Set()));
    setDirtyColorInputs((current) => (current.size === 0 ? current : new Set()));
    if (editingRef.current) {
      editingRef.current = null;
      setEditing(null);
    }
    setOpenColorControlKey(null);
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
        // 过期运行的拒绝不得覆盖更新运行的结果（run 不匹配时静默忽略）。
        if (run !== validationRun.current) return;
        setValidationError(true);
        onValidationChange?.(false);
      });
    }, 220);
    return () => window.clearTimeout(timer);
    // onValidationChange/validateRule 为 controller 透传引用；nameErrors 与
    // invalidColorInputs 的内容变化已通过 useMemo/Set 反映，刻意收窄依赖避免
    // 每次父级渲染都重置验证状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorRules, invalidColorInputs, nameErrors, validationRetryToken]);

  useEffect(() => {
    const liveIds = new Set(colorRules.map((rule) => rule.id));
    for (const id of untouchedNewRules.current.keys()) {
      if (!liveIds.has(id)) untouchedNewRules.current.delete(id);
    }
  }, [colorRules]);

  // 权威重置/外部快照：已消失的选中 id 收敛到最近存活索引并关闭编辑态；
  // 从未选中时保持未选中，不自动选择第一条。
  useEffect(() => {
    setSelectedId((current) => {
      if (current === null) return null;
      if (colorRules.some((rule) => rule.id === current)) return current;
      return resolveColorRuleSelection(colorRules, current, previousSelectedIndexRef.current);
    });
    setEditing((current) => (current && colorRules.some((rule) => rule.id === current.id) ? current : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorRules]);

  // 编辑输入框挂载后聚焦（新建/编辑/双击入口共用）。
  useEffect(() => {
    if (!editing) return;
    const input = expressionInputRef.current;
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }, [editing]);

  // 键盘提交/取消后焦点回到表达式行；指针提交保留指针目标焦点。
  useEffect(() => {
    if (editing || !focusRowAfterCommitRef.current) return;
    focusRowAfterCommitRef.current = false;
    const currentId = selectedId;
    if (!currentId) return;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-rule-id]") ?? [])
      .find((element) => element.dataset.ruleId === currentId);
    row?.focus();
  }, [editing, selectedId]);

  const update = (id: string, patch: Partial<Omit<ColorFilterRule, "id" | "priority">>) => {
    onChange(updateColorRule(colorRules, id, patch));
  };

  const updateColorValidity = (key: string, valid: boolean) => {
    setInvalidColorInputs((current) => {
      // 内容未变化时必须返回原实例，避免无意义的重渲染重启验证计时器。
      if (valid) {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      }
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  };

  const updateColorDraftDirty = (key: string, dirty: boolean) => {
    setDirtyColorInputs((current) => {
      if (dirty) {
        if (current.has(key)) return current;
        const next = new Set(current);
        next.add(key);
        return next;
      }
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const startEditing = (id: string) => {
    if (disabled) return;
    const rule = colorRules.find((candidate) => candidate.id === id);
    if (!rule) return;
    setSelectedId(id);
    setOpenColorControlKey(null);
    setEditing({ id, draft: rule.expression });
  };

  const closeEditing = (options?: { cancel?: boolean }) => {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null;
    setEditing(null);
    if (options?.cancel) return;
    const rule = colorRules.find((candidate) => candidate.id === current.id);
    if (!rule || rule.expression === current.draft) return;
    update(current.id, { expression: current.draft });
  };

  const selectRule = (id: string) => {
    if (disabled) return;
    setSelectedId(id);
  };

  const addRule = () => {
    if (!enablement.canAdd) return;
    const next = addColorRule(colorRules, createRuleId);
    const added = next.find((rule) => !colorRules.some((current) => current.id === rule.id));
    if (added) {
      untouchedNewRules.current.set(added.id, added);
      setSelectedId(added.id);
      setEditing({ id: added.id, draft: added.expression });
    }
    onChange(next);
  };

  const deleteSelectedRule = () => {
    if (!selectedRule) return;
    const untouched = untouchedNewRules.current.get(selectedRule.id);
    const requiresConfirmation = !untouched || JSON.stringify(untouched) !== JSON.stringify(selectedRule);
    // 确认文案使用表达式而不是内部 name（V2 不再展示规则名称）。
    if (requiresConfirmation && !window.confirm(`确定删除颜色规则“${selectedRule.expression || "（空表达式）"}”吗？`)) return;
    untouchedNewRules.current.delete(selectedRule.id);
    const nextSelection = getColorRuleSelectionAfterDelete(colorRules, selectedRule.id);
    if (editingRef.current?.id === selectedRule.id) {
      editingRef.current = null;
      setEditing(null);
    }
    setSelectedId(nextSelection);
    onChange(deleteColorRule(colorRules, selectedRule.id));
  };

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>, rule: ColorFilterRule) => {
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && target.closest("input,button,select")) {
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      startEditing(rule.id);
      return;
    }
    if (event.key === " " && !disabled && (rule.foregroundColorHex || rule.backgroundColorHex)) {
      event.preventDefault();
      update(rule.id, { enabled: !rule.enabled });
    }
  };

  const statusMessage = !disabled
    ? enablement.atLimit
      ? `已达到 ${colorRules.length} 条规则上限，无法继续新建。`
      : colorRules.length === 0
        ? "暂无颜色规则，选择“新建”创建第一条。"
        : selectedRule
          ? `已选择第 ${selectedIndex + 1} 条规则。`
          : "请选择一个规则以使用右侧操作。"
    : "设置当前不可编辑。";
  const statusId = "color-rules-operations-status";

  const getExpressionLabelStyle = (rule: ColorFilterRule): CSSProperties => {
    const style: CSSProperties = {};
    if (rule.foregroundColorHex) style.color = rule.foregroundColorHex;
    if (rule.backgroundColorHex) style.backgroundColor = rule.backgroundColorHex;
    return style;
  };

  const lowContrast = selectedRule && selectedRule.foregroundColorHex && selectedRule.backgroundColorHex
    ? contrastRatio(
        selectedRule.foregroundColorHex || "#1f1f1f",
        selectedRule.backgroundColorHex || "#ffffff"
      ) < 4.5
    : false;

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

      <div className="color-rules-content" data-testid="color-rules-content">
        <div className="color-rules-list-wrap">
          {colorRules.length === 0 ? (
            <div className="color-rules-empty">暂无颜色规则</div>
          ) : (
            <ul className="color-rules-list" role="listbox" aria-label="颜色规则列表" ref={listRef}>
              {colorRules.map((rule, index) => {
                const isSelected = rule.id === selectedId;
                const isEditing = editing?.id === rule.id;
                const result = validation[rule.id];
                const diagnostic = rule.migrationDiagnostic
                  ?? nameErrors[rule.id]
                  ?? (result?.valid === false ? result.message : null);
                const diagnosticId = `color-rule-expression-error-${rule.id}`;
                return (
                  <li
                    key={rule.id}
                    role="option"
                    aria-selected={isSelected}
                    aria-invalid={diagnostic ? true : undefined}
                    className={`color-rules-list-row${isSelected ? " is-selected" : ""}${isEditing ? " is-editing" : ""}${rule.enabled ? "" : " is-disabled"}`}
                    tabIndex={isSelected || (selectedId === null && index === 0) ? 0 : -1}
                    data-rule-id={rule.id}
                    onClick={() => selectRule(rule.id)}
                    onDoubleClick={() => startEditing(rule.id)}
                    onKeyDown={(event) => handleRowKeyDown(event, rule)}
                  >
                    <input
                      type="checkbox"
                      className="color-rules-list-row__enabled"
                      aria-label={`启用规则 ${index + 1}`}
                      checked={rule.enabled}
                      disabled={disabled || (!rule.foregroundColorHex && !rule.backgroundColorHex)}
                      onClick={(event: ReactMouseEvent<HTMLInputElement>) => event.stopPropagation()}
                      onChange={(event) => update(rule.id, { enabled: event.currentTarget.checked })}
                    />
                    {isEditing && editing ? (
                      <input
                        ref={expressionInputRef}
                        type="text"
                        className="color-rules-expression-input"
                        aria-label={`编辑规则 ${index + 1} 表达式`}
                        value={editing.draft}
                        onChange={(event) => setEditing({
                          id: editing.id,
                          draft: limitUnicodeScalars(event.currentTarget.value, COLOR_RULE_EXPRESSION_MAX_SCALARS)
                        })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.stopPropagation();
                            focusRowAfterCommitRef.current = true;
                            closeEditing();
                            return;
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            focusRowAfterCommitRef.current = true;
                            closeEditing({ cancel: true });
                          }
                        }}
                        onBlur={() => closeEditing()}
                      />
                    ) : (
                      <span className="color-rule-expression-label" style={getExpressionLabelStyle(rule)}>
                        {rule.expression || "（空表达式）"}
                      </span>
                    )}
                    {diagnostic ? <span id={diagnosticId} className="color-rule-diagnostic" role="status">{diagnostic}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <aside className="color-rules-operations" aria-label="规则操作">
          <p id={statusId} className="color-rules-operations__status" role="status">{statusMessage}</p>
          <div className="color-rules-operations__commands">
            <button
              type="button"
              className="toolbar-button"
              data-action="add-color-rule"
              disabled={disabled || !enablement.canAdd}
              aria-describedby={enablement.atLimit ? statusId : undefined}
              title={enablement.atLimit ? `规则数量已达上限 ${colorRules.length}` : undefined}
              onClick={addRule}
            >
              <Plus size={15} aria-hidden="true" />
              新建
            </button>
            <button
              type="button"
              className="toolbar-button"
              data-action="edit-color-rule"
              disabled={!enablement.canOperateSelected || editing !== null}
              onClick={() => selectedRule && startEditing(selectedRule.id)}
            >
              <Pencil size={15} aria-hidden="true" />
              编辑
            </button>
            <button
              type="button"
              className="toolbar-button toolbar-button--danger"
              data-action="delete-color-rule"
              disabled={!enablement.canOperateSelected}
              onClick={deleteSelectedRule}
            >
              <Trash2 size={15} aria-hidden="true" />
              删除
            </button>
          </div>
          <div className="color-rules-operations__commands color-rules-operations__commands--secondary">
            <button
              type="button"
              className="toolbar-button"
              data-action="move-color-rule-up"
              disabled={!enablement.canOperateSelected || selectedIndex <= 0}
              onClick={() => selectedRule && onChange(moveColorRule(colorRules, selectedRule.id, -1))}
            >
              <ArrowUp size={15} aria-hidden="true" />
              上移
            </button>
            <button
              type="button"
              className="toolbar-button"
              data-action="move-color-rule-down"
              disabled={!enablement.canOperateSelected || selectedIndex < 0 || selectedIndex >= colorRules.length - 1}
              onClick={() => selectedRule && onChange(moveColorRule(colorRules, selectedRule.id, 1))}
            >
              <ArrowDown size={15} aria-hidden="true" />
              下移
            </button>
          </div>

          <div className="color-rules-operations__colors">
            <ColorRuleColorControl
              key={`${selectedRule?.id ?? "none"}-foreground`}
              controlKey={`${selectedRule?.id ?? "none"}-foreground`}
              label="文字颜色"
              value={selectedRule?.foregroundColorHex ?? null}
              disabled={!selectedRule || disabled}
              open={openColorControlKey === `${selectedRule?.id ?? "none"}-foreground`}
              onOpenChange={(next) => setOpenColorControlKey(next ? `${selectedRule?.id ?? "none"}-foreground` : null)}
              onChange={(value) => selectedRule && update(selectedRule.id, { foregroundColorHex: value })}
              onValidityChange={updateColorValidity}
              onDraftDirtyChange={updateColorDraftDirty}
              resetToken={resetToken}
            />
            <ColorRuleColorControl
              key={`${selectedRule?.id ?? "none"}-background`}
              controlKey={`${selectedRule?.id ?? "none"}-background`}
              label="背景颜色"
              value={selectedRule?.backgroundColorHex ?? null}
              disabled={!selectedRule || disabled}
              open={openColorControlKey === `${selectedRule?.id ?? "none"}-background`}
              onOpenChange={(next) => setOpenColorControlKey(next ? `${selectedRule?.id ?? "none"}-background` : null)}
              onChange={(value) => selectedRule && update(selectedRule.id, { backgroundColorHex: value })}
              onValidityChange={updateColorValidity}
              onDraftDirtyChange={updateColorDraftDirty}
              resetToken={resetToken}
            />
          </div>

          <label className="color-rules-field">
            <span>匹配目标</span>
            <select
              aria-label="匹配目标"
              value={selectedRule?.target ?? "any"}
              disabled={!selectedRule || disabled}
              onChange={(event) => selectedRule && update(selectedRule.id, {
                target: event.currentTarget.value as ColorFilterRule["target"]
              })}
            >
              <option value="any">文件和文件夹</option>
              <option value="file">文件</option>
              <option value="directory">文件夹</option>
            </select>
          </label>

          <label className="color-rules-field color-rules-field--check">
            <input
              type="checkbox"
              data-action="color-rule-case-sensitive"
              checked={selectedRule?.caseSensitive ?? false}
              disabled={!selectedRule || disabled}
              onChange={(event) => selectedRule && update(selectedRule.id, { caseSensitive: event.currentTarget.checked })}
            />
            <span>区分大小写</span>
          </label>

          {lowContrast ? <span className="color-rule-contrast">文字与背景对比度较低</span> : null}
        </aside>
      </div>
    </div>
  );
}
