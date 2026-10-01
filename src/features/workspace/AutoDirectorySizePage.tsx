import { useState } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { findAutoDirectorySizeRoot, isVolumeRootPath, normalizeAutoDirectorySizePath } from "./directorySizeAutoPaths";
import { pathsEqual } from "./workspacePathRelations";
import "./color-rules.css";
import "./file-associations.css";

export interface AutoDirectorySizePageProps {
  paths: string[];
  disabled?: boolean;
  /** Saves immediately through the dedicated command; the list comes back through `paths`. */
  onAdd: (path: string) => Promise<unknown>;
  onRemove: (path: string) => Promise<unknown>;
  onChoose: () => Promise<string | null>;
}

export const AUTO_DIRECTORY_SIZE_HELP = "修改立即生效；仅对本地和网络文件夹生效；需在详细信息视图显示大小列；变化后至少间隔 30 秒自动重新计算。";

/** Whole drives and network shares scan everything below them (E4). */
export function confirmAutoDirectorySizeRoot(path: string) {
  return !isVolumeRootPath(path) || window.confirm(`将自动计算 ${path} 下所有文件夹的大小，可能长时间占用磁盘。确定要开启吗？`);
}

export function AutoDirectorySizePage({ paths, disabled = false, onAdd, onRemove, onChoose }: AutoDirectorySizePageProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedPath = paths.find((path) => selected !== null && pathsEqual(path, selected)) ?? null;
  const locked = disabled || busy;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(null); setStatus(null);
    try { await action(); setStatus(done); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { setBusy(false); }
  };
  const add = async (input: string) => {
    setStatus(null);
    const path = normalizeAutoDirectorySizePath(input);
    if (path === null) { setError("请输入有效的本地或网络文件夹绝对路径"); return; }
    const existing = paths.find((saved) => pathsEqual(saved, path));
    if (existing) { setError(null); setSelected(existing); setStatus("已存在"); return; }
    if (!confirmAutoDirectorySizeRoot(path)) return;
    if (await run(() => onAdd(path), `已添加 ${path}`)) { setSelected(path); setDraft(""); }
  };
  const browse = async () => {
    setError(null);
    try {
      const path = await onChoose();
      if (path !== null) await add(path);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开文件夹选择框"); }
  };
  const remove = async () => {
    if (!selectedPath) return;
    const index = paths.indexOf(selectedPath);
    if (await run(() => onRemove(selectedPath), `已删除 ${selectedPath}`)) {
      const rest = paths.filter((path) => path !== selectedPath);
      setSelected(rest[Math.min(index, rest.length - 1)] ?? null);
    }
  };

  return (
    <section className="file-associations-page auto-directory-sizes-page color-rules-page" aria-label="自动计算大小">
      <div className="color-rules-content">
        <div className="color-rules-list-wrap">
          {paths.length === 0 ? <div className="color-rules-empty">尚未添加自动计算大小的文件夹</div> : (
            <ul className="color-rules-list" role="listbox" aria-label="自动计算大小的文件夹">
              {paths.map((path, index) => {
                const active = path === selectedPath;
                const cover = findAutoDirectorySizeRoot(path, paths.filter((other) => other !== path));
                return (
                  <li key={path} role="option" aria-selected={active} data-path={path}
                    className={`color-rules-list-row${active ? " is-selected" : ""}`}
                    tabIndex={active || (!selectedPath && index === 0) ? 0 : -1}
                    onClick={() => setSelected(path)} onFocus={() => setSelected(path)}
                    onKeyDown={(event) => {
                      if (event.key === "Delete" && !locked) { event.preventDefault(); void remove(); return; }
                      const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: paths.length - 1 }[event.key];
                      if (next === undefined) return;
                      event.preventDefault();
                      const row = event.currentTarget.parentElement?.children[Math.max(0, Math.min(paths.length - 1, next))];
                      if (row instanceof HTMLElement) row.focus();
                    }}>
                    <span className="file-association-expression">{path}</span>
                    {cover ? <span className="auto-directory-sizes-page__covered">已被上级覆盖（{cover.root}）</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <aside className="color-rules-operations" aria-label="自动计算大小操作">
          <div className="color-rules-operations__commands">
            <button type="button" className="toolbar-button" disabled={locked} onClick={() => void browse()}>
              <FolderOpen size={15} aria-hidden="true" />
              浏览…
            </button>
            <button type="button" className="toolbar-button toolbar-button--danger" disabled={locked || !selectedPath} onClick={() => void remove()}>
              <Trash2 size={15} aria-hidden="true" />
              删除
            </button>
          </div>
        </aside>
      </div>
      <form className="auto-directory-sizes-page__add" onSubmit={(event) => { event.preventDefault(); if (!locked) void add(draft); }}>
        <input type="text" className="color-rules-expression-input" aria-label="要自动计算大小的文件夹路径" placeholder="例如 D:\Projects"
          value={draft} disabled={locked} spellCheck={false} onChange={(event) => { setDraft(event.currentTarget.value); setError(null); }} />
        <button type="submit" className="toolbar-button" disabled={locked}>
          <Plus size={15} aria-hidden="true" />
          添加
        </button>
      </form>
      <div className="file-association-feedback">
        {error ? <p className="file-association-error" role="alert">{error}</p> : null}
        {status ? <p className="file-association-hint" role="status">{status}</p> : null}
        <p className="file-association-hint">{AUTO_DIRECTORY_SIZE_HELP}</p>
      </div>
    </section>
  );
}
