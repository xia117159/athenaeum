import { useId, useRef, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";

export function RenameExpressionInput({ value, history, disabled, inputRef, invalid = false, onChange }: {
  value: string; history: string[]; disabled: boolean; inputRef: RefObject<HTMLInputElement | null>;
  invalid?: boolean;
  onChange(value: string): void;
}) {
  const listId = useId();
  const composing = useRef(false);
  const [selected, setSelected] = useState(-1);
  const open = selected >= 0 && !disabled && history.length > 0;
  const choose = (index: number) => {
    const expression = history[index];
    if (expression !== undefined) onChange(expression);
    setSelected(-1); inputRef.current?.focus();
  };
  return <div className="rename-expression" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSelected(-1);
  }}>
    <input ref={inputRef} id={`${listId}-input`} role="combobox" aria-label="重命名表达式"
      aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? `${listId}-${selected}` : undefined}
      aria-invalid={invalid} aria-describedby="batch-rename-rules batch-rename-error" autoComplete="off" spellCheck={false} disabled={disabled}
      value={value} onChange={event => { setSelected(-1); onChange(event.target.value); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && history.length) {
          event.preventDefault(); event.stopPropagation();
          setSelected(index => index < 0 ? (event.key === "ArrowDown" ? 0 : history.length - 1)
            : (index + (event.key === "ArrowDown" ? 1 : history.length - 1)) % history.length);
        } else if (open && event.key === "Enter") {
          event.preventDefault(); event.stopPropagation(); choose(selected);
        } else if (open && event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); setSelected(-1);
        }
      }} />
    <button type="button" className="rename-expression__toggle" aria-label="表达式历史记录" aria-expanded={open}
      title={history.length ? "选择最近成功使用的表达式" : "成功重命名后会保留表达式历史"} disabled={disabled || history.length === 0}
      onClick={() => { setSelected(open ? -1 : 0); inputRef.current?.focus(); }}><ChevronDown size={14} /></button>
    {open ? <div role="listbox" aria-label="表达式历史记录" id={listId} className="rename-expression__history">
      {history.map((expression, index) => <button key={expression} type="button" tabIndex={-1} role="option"
        id={`${listId}-${index}`} aria-selected={selected === index} title={expression}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}
        ref={element => { if (selected === index) element?.scrollIntoView?.({ block: "nearest" }); }}>
        {expression}
      </button>)}
    </div> : null}
  </div>;
}
