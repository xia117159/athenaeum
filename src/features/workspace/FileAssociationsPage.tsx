import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import type { AssociationProgramInfo, FileAssociationRule } from "../../app/fileAssociations";
import { formatAssociationExpression, normalizeAssociationRule, parseAssociationExpression, validateAssociationRule } from "./fileAssociations";
import "./color-rules.css";
import "./file-associations.css";

export interface FileAssociationsPageProps {
  rules: FileAssociationRule[];
  disabled?: boolean;
  onChange: (rules: FileAssociationRule[]) => void;
  onChooseProgram: () => Promise<string | null>;
  onInspectPrograms: (paths: string[]) => Promise<AssociationProgramInfo[]>;
}

type Editing = { id: string; raw: string; original: Pick<FileAssociationRule, "patterns" | "executablePath"> };

export function FileAssociationsPage({rules, disabled = false, onChange, onChooseProgram, onInspectPrograms}: FileAssociationsPageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(rules[0]?.id ?? null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [programs, setPrograms] = useState<Record<string, AssociationProgramInfo>>({});
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rulesRef = useRef(rules);
  const editingRef = useRef(editing);
  const inspectRef = useRef(onInspectPrograms);
  const alive = useRef(true);
  const pendingFocus = useRef<{ruleId: string} | "new" | null>(null);
  const previousIndex = useRef(0);
  rulesRef.current = rules;
  editingRef.current = editing;
  inspectRef.current = onInspectPrograms;
  const index = rules.findIndex(rule => rule.id === selectedId);
  const selected = rules[index];
  const pathsKey = JSON.stringify([...new Set(rules.map(rule => normalizeAssociationRule(rule).executablePath).filter(Boolean))]);
  const ruleError = selected ? validateAssociationRule(selected) : null;
  const selectedPath = selected ? normalizeAssociationRule(selected).executablePath : "";
  const program = programs[selectedPath];
  const incomplete = selected && (!selected.patterns.trim() || !selectedPath);
  const warning = /\.(bat|cmd)$/i.test(selectedPath)
    ? "批处理脚本不能直接运行，请选择可执行程序（如 .exe）。"
    : program?.exists === false ? "程序不存在或无法访问；仍可保存，使用前请检查路径。" : null;
  const diagnostics = useMemo(() => new Map(rules.map(rule => [rule.id, validateAssociationRule(rule)])), [rules]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setInspectionError(null);
    const paths = JSON.parse(pathsKey) as string[];
    const timer = window.setTimeout(() => {
      if (!paths.length) { setPrograms({}); return; }
      void inspectRef.current(paths).then(infos => {
        if (current) setPrograms(Object.fromEntries(infos.map(info => [info.path, info])));
      }).catch(error => {
        if (current) setInspectionError(error instanceof Error ? error.message : "暂时无法检查程序路径");
      });
    }, 200);
    return () => { current = false; window.clearTimeout(timer); };
  }, [pathsKey]);

  useEffect(() => {
    if (index >= 0) previousIndex.current = index;
    else setSelectedId(rules[Math.min(previousIndex.current, rules.length - 1)]?.id ?? null);
    if (editingRef.current && !rules.some(rule => rule.id === editingRef.current?.id)) {
      editingRef.current = null;
      setEditing(null);
    }
  }, [rules, index]);

  useLayoutEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing?.id]);
  useLayoutEffect(() => {
    if (editing || !pendingFocus.current) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "new") { newButtonRef.current?.focus(); return; }
    [...(listRef.current?.querySelectorAll<HTMLElement>("[data-rule-id]") ?? [])]
      .find(row => row.dataset.ruleId === target.ruleId)?.focus();
  }, [editing, selectedId]);

  const publish = (next: FileAssociationRule[]) => {
    rulesRef.current = next;
    onChange(next);
  };
  const update = (id: string, patch: Partial<FileAssociationRule>) => {
    publish(rulesRef.current.map(rule => rule.id === id ? {...rule, ...patch} : rule));
  };
  const startEditing = (id: string) => {
    if (disabled || editingRef.current?.id === id) return;
    const rule = rulesRef.current.find(rule => rule.id === id);
    if (!rule) return;
    setSelectedId(id);
    setPickerError(null);
    const next = {id, raw: formatAssociationExpression(rule), original: {patterns:rule.patterns, executablePath:rule.executablePath}};
    editingRef.current = next;
    setEditing(next);
  };
  const finishEditing = (cancel = false, restoreFocus = false) => {
    const draft = editingRef.current;
    if (!draft) return;
    editingRef.current = null;
    setEditing(null);
    const rule = rulesRef.current.find(rule => rule.id === draft.id);
    if (rule) update(rule.id, cancel ? draft.original : normalizeAssociationRule(rule));
    if (restoreFocus) pendingFocus.current = {ruleId: draft.id};
  };
  const addRule = () => {
    const rule: FileAssociationRule = {id: crypto.randomUUID(), patterns:"", executablePath:"", argumentsTemplate:""};
    publish([...rulesRef.current, rule]);
    startEditing(rule.id);
  };
  const deleteSelected = (restoreFocus = false) => {
    if (!selected) return;
    const next = rulesRef.current.filter(rule => rule.id !== selected.id);
    publish(next);
    const nextId = next[Math.min(index, next.length - 1)]?.id ?? null;
    setSelectedId(nextId);
    if (restoreFocus) pendingFocus.current = nextId ? {ruleId: nextId} : "new";
    setPickerError(null);
  };
  const move = (delta: number) => {
    if (!selected || index + delta < 0 || index + delta >= rules.length) return;
    const next = [...rulesRef.current];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    publish(next);
  };
  const chooseProgram = async () => {
    if (!selected || disabled || picking) return;
    const id = selected.id;
    const original = JSON.stringify(rulesRef.current.find(rule => rule.id === id));
    setPicking(true);
    setPickerError(null);
    try {
      const path = await onChooseProgram();
      if (alive.current && path !== null && JSON.stringify(rulesRef.current.find(rule => rule.id === id)) === original) {
        update(id, {executablePath:path});
      }
    } catch (error) {
      if (alive.current) setPickerError(error instanceof Error ? error.message : "无法打开程序选择框");
    } finally {
      if (alive.current) setPicking(false);
    }
  };

  return (
    <section className="file-associations-page color-rules-page" aria-label="自定义文件关联">
      <div className="color-rules-content">
        <div className="color-rules-list-wrap">
          <ul className="color-rules-list" ref={listRef} role="listbox" aria-label="自定义文件关联列表">
            {rules.map((rule, rowIndex) => {
              const active = rule.id === selectedId;
              const error = diagnostics.get(rule.id);
              return (
                <li key={rule.id} role="option" aria-selected={active} aria-invalid={error ? true : undefined}
                  className={"color-rules-list-row" + (active ? " is-selected" : "")}
                  data-rule-id={rule.id} tabIndex={active || (!selectedId && rowIndex === 0) ? 0 : -1}
                  onFocus={() => setSelectedId(rule.id)} onClick={() => setSelectedId(rule.id)}
                  onDoubleClick={() => startEditing(rule.id)}
                  onKeyDown={event => {
                    if (editingRef.current || disabled || event.nativeEvent.isComposing) return;
                    if (event.key === "F2" || event.key === "Enter") { event.preventDefault(); startEditing(rule.id); }
                    else if (event.key === "Delete") { event.preventDefault(); deleteSelected(true); }
                    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      const next = Math.max(0, Math.min(rules.length - 1, rowIndex + (event.key === "ArrowUp" ? -1 : 1)));
                      setSelectedId(rules[next].id);
                      listRef.current?.querySelectorAll<HTMLElement>("[data-rule-id]")[next]?.focus();
                    }
                  }}>
                  {editing?.id === rule.id ? (
                    <input ref={inputRef} className="color-rules-expression-input" aria-label="关联表达式"
                      value={editing.raw} disabled={disabled} spellCheck={false}
                      onChange={event => {
                        const raw = event.currentTarget.value;
                        const next = {...editing, raw};
                        editingRef.current = next;
                        setEditing(next);
                        update(rule.id, parseAssociationExpression(raw));
                      }}
                      onBlur={() => finishEditing()}
                      onKeyDown={event => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Enter" || event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          finishEditing(event.key === "Escape", true);
                        }
                      }} />
                  ) : (
                    <span className="file-association-expression" title={formatAssociationExpression(rule)}>
                      {!rule.patterns && !rule.executablePath ? "（空关联）" : formatAssociationExpression(rule)}
                    </span>
                  )}
                  {error ? <AlertTriangle size={13} className="file-association-warning" aria-label={error} /> : null}
                </li>
              );
            })}
          </ul>
          {rules.length === 0 ? <p className="color-rules-empty">暂无关联，点击“新建”添加</p> : null}
        </div>
        <aside className="color-rules-operations" aria-label="关联操作">
          <p className="color-rules-operations__status">{selected ? "第 " + (index + 1) + " 条，共 " + rules.length + " 条" : "请选择或新建关联"}</p>
          <div className="color-rules-operations__commands">
            <button ref={newButtonRef} type="button" className="toolbar-button" data-action="association-add" disabled={disabled} onClick={addRule}><Plus size={15} />新建</button>
            <button type="button" className="toolbar-button" data-action="association-edit" disabled={disabled || !selected || !!editing} onClick={() => selected && startEditing(selected.id)}><Pencil size={15} />编辑</button>
            <button type="button" className="toolbar-button toolbar-button--danger" data-action="association-delete" disabled={disabled || !selected} onClick={() => deleteSelected()}><Trash2 size={15} />删除</button>
          </div>
          <div className="color-rules-operations__commands color-rules-operations__commands--secondary">
            <button type="button" className="toolbar-button" data-action="association-up" disabled={disabled || index <= 0} onClick={() => move(-1)}><ArrowUp size={15} />上移</button>
            <button type="button" className="toolbar-button" data-action="association-down" disabled={disabled || index < 0 || index >= rules.length - 1} onClick={() => move(1)}><ArrowDown size={15} />下移</button>
          </div>
          <div className="file-association-fields">
            <button type="button" className="toolbar-button" data-action="association-choose-program" disabled={disabled || !selected || picking} onClick={() => void chooseProgram()}>
              <FolderOpen size={15} />{picking ? "正在选择…" : "选择程序…"}
            </button>
            <label className="color-rules-field">
              <span>参数模板</span>
              <input aria-label="参数模板" type="text" spellCheck={false} value={selected?.argumentsTemplate ?? ""}
                placeholder="--new-window {file}" disabled={disabled || !selected}
                onChange={event => selected && update(selected.id, {argumentsTemplate:event.currentTarget.value})} />
            </label>
            <p className="file-association-hint">{"{file} 表示文件路径；未填写时自动追加。"}</p>
          </div>
          {ruleError || pickerError ? <p className="file-association-error" role="alert">{pickerError || ruleError}</p> : null}
          {incomplete ? <p className="file-association-hint" role="status">此规则未填写完整，打开文件时将忽略。</p>
            : warning ? <p className="file-association-warning" role="status">{warning}</p> : null}
          {inspectionError ? <p className="file-association-hint" role="status">无法检查程序：{inspectionError}</p> : null}
        </aside>
      </div>
      <p className="file-association-help">{"后缀用分号分隔，支持 *.md、.md、md。按从上到下的顺序匹配；双击或 F2 编辑。"}</p>
    </section>
  );
}
