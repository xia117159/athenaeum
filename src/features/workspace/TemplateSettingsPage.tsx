import { useRef, useState } from "react";
import "./templates.css";

export function TemplateSettingsPage({ path, disabled = false, onChange, onChoose }: {
  path: string; disabled?: boolean; onChange: (path: string) => void; onChoose: () => Promise<string | null>;
}) {
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string>();
  const revision = useRef(0);
  const choose = async () => {
    if (choosing || disabled) return;
    const current = ++revision.current;
    setChoosing(true); setError(undefined);
    try {
      const selected = await onChoose();
      if (selected !== null && current === revision.current) onChange(selected);
    } catch (error) { setError(error instanceof Error ? error.message : "无法打开文件夹选择框"); }
    finally { setChoosing(false); }
  };
  return <section className="template-settings">
    <label htmlFor="template-root">模板文件夹</label>
    <div className="template-settings__path">
      <input id="template-root" aria-label="模板文件夹" type="text" spellCheck={false} value={path}
        placeholder="例如 D:\\Templates" disabled={disabled || choosing}
        onChange={event => { revision.current++; onChange(event.target.value); setError(undefined); }} />
      <button className="secondary-button" type="button" disabled={disabled || choosing} onClick={() => void choose()}>
        {choosing ? "正在选择…" : "选择文件夹"}
      </button>
    </div>
    <p>将常用文件和文件夹放在此目录中，即可通过右键菜单的“新建项目”创建副本。子文件夹会显示为子菜单。</p>
    <p>支持一次勾选多个模板。创建完成后可重命名，取消重命名会保留副本。</p>
    {error ? <p role="alert" className="template-settings__error">{error}</p> : null}
  </section>;
}
