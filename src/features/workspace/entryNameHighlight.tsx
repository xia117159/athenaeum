import React, { type ReactNode } from "react";
import "./workspace.quick-filter.css";
import type { QuickFilterProgram } from "./quickFilterTypes";

/**
 * 名称局部高亮（§6.7 / D7）。
 *
 * 只有 `highlight` 模式需要局部高亮：`include`/`exclude` 已经通过行集表达结果，
 * 再叠一层高亮只会和"保留/排除"的语义打架。因此其余模式一律返回原始名称，
 * 让调用方保持既有渲染路径（不改 DOM 结构，也就不会引入布局回归）。
 *
 * 返回原始字符串时是同一个 `string`，命中时才返回节点数组；命中区间由
 * `program.ranges` 给出（UTF-16 code unit、升序、互不重叠），因此 `slice` 是安全的。
 */
export function renderEntryNameText(name: string, program: QuickFilterProgram | null): ReactNode {
  if (!program || program.mode !== "highlight" || program.text === "") return name;
  const ranges = program.ranges(name);
  if (ranges.length === 0) return name;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(name.slice(cursor, range.start));
    parts.push(<mark className="entry-name__match" key={index}>{name.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  });
  if (cursor < name.length) parts.push(name.slice(cursor));
  return parts;
}
