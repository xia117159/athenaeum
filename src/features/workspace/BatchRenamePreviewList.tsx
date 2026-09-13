import { memo, useEffect, useId, useRef, useState } from "react";
import { ArrowRight, CircleAlert } from "lucide-react";
import type { BatchRenameRow } from "../../app/batchRename";
import { FileSystemIcon } from "./FileSystemIcon";
import { renameDiff } from "./batchRenameDiff";

const ROW_HEIGHT = 30;
const PreviewRow = memo(function PreviewRow({ row, index, id, selected, completed, onSelect }: {
  row: BatchRenameRow; index: number; id: string; selected: boolean; completed: boolean; onSelect(index: number): void;
}) {
  const diff = renameDiff(row.oldName, row.newName ?? row.oldName);
  const status = row.status === "error" ? (completed ? "需检查" : "无效")
    : row.status === "changed" ? (completed ? "待恢复" : "将重命名") : (completed ? "原名称" : "未变化");
  return <div role="row" id={id} aria-rowindex={index + 2} aria-selected={selected} data-row-index={index}
    className={`batch-rename__row${selected ? " is-selected" : ""}${row.status === "error" ? " is-error" : ""}`}
    onClick={() => onSelect(index)}>
    <span role="rowheader" className="batch-rename__number">{index + 1}</span>
    <div role="gridcell" className="batch-rename__old-name" title={row.sourcePath}>
      <FileSystemIcon kind={row.isDirectory ? "folder" : "file"} path={row.sourcePath} size={16} />
      <span>{diff.before.map((part, i) => part.changed ? <del key={i}>{part.text}</del> : part.text)}</span>
    </div>
    <ArrowRight size={13} className="batch-rename__arrow" aria-hidden="true" />
    <div role="gridcell" className="batch-rename__new-name" title={row.targetPath ?? row.diagnostic?.message ?? ""}>
      {row.newName === null ? "—" : diff.after.map((part, i) => part.changed ? <mark key={i}>{part.text}</mark> : part.text)}
    </div>
    <span role="gridcell" className="batch-rename__row-status" title={row.diagnostic?.message}>
      {row.status === "error" ? <CircleAlert size={13} aria-hidden="true" /> : null}{status}
    </span>
  </div>;
});

export function BatchRenamePreviewList({ items, onInspect, completed = false }: { items: BatchRenameRow[]; onInspect(id: string): void; completed?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0), [height, setHeight] = useState(300), [selected, setSelected] = useState(0);
  const id = useId();
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight || 300);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const select = (index: number, reveal = false) => {
    if (!items.length) return;
    const next = Math.max(0, Math.min(items.length - 1, index));
    setSelected(next); onInspect(items[next].id);
    if (reveal && viewport.current) {
      if (next * ROW_HEIGHT < viewport.current.scrollTop) viewport.current.scrollTop = next * ROW_HEIGHT;
      else if ((next + 1) * ROW_HEIGHT > viewport.current.scrollTop + height) viewport.current.scrollTop = (next + 1) * ROW_HEIGHT - height;
      setScrollTop(viewport.current.scrollTop);
    }
  };
  const start = Math.max(0, Math.min(items.length - 1, Math.floor(scrollTop / ROW_HEIGHT)) - 3);
  const end = Math.min(items.length, start + Math.ceil(height / ROW_HEIGHT) + 7);
  return <div className="batch-rename__grid" role="grid" aria-label="重命名预览" aria-readonly="true"
    aria-rowcount={items.length + 1} aria-colcount={4} aria-activedescendant={selected >= start && selected < end ? `${id}-${selected}` : undefined}
    tabIndex={0} onKeyDown={event => {
      const moves: Record<string, number> = { ArrowDown: selected + 1, ArrowUp: selected - 1,
        Home: 0, End: items.length - 1, PageDown: selected + Math.floor(height / ROW_HEIGHT), PageUp: selected - Math.floor(height / ROW_HEIGHT) };
      if (moves[event.key] !== undefined) { event.preventDefault(); select(moves[event.key], true); }
    }}>
    <div className="batch-rename__columns" role="row" aria-rowindex={1}>
      <span role="columnheader">#</span><span role="columnheader">原名称</span><span aria-hidden="true" />
      <span role="columnheader">{completed ? "当前名称" : "新名称"}</span><span role="columnheader">状态</span>
    </div>
    <div className="batch-rename__viewport" ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      <div role="rowgroup">
        <div style={{ height: start * ROW_HEIGHT }} aria-hidden="true" />
        {items.slice(start, end).map((row, offset) => <PreviewRow key={row.id} row={row} index={start + offset}
          id={`${id}-${start + offset}`} selected={selected === start + offset} completed={completed} onSelect={select} />)}
        <div style={{ height: (items.length - end) * ROW_HEIGHT }} aria-hidden="true" />
      </div>
    </div>
  </div>;
}
