import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Asterisk, Funnel, FunnelX, Highlighter, Regex, TriangleAlert, Type } from "lucide-react";
import { MenuSurface } from "./MenuPrimitives";
import { focusMenuItem, handleMenuKeyDown, menuButtons } from "./menuInteraction";
import {
  QUICK_FILTER_MODE_LABELS, QUICK_FILTER_MODE_ORDER, QUICK_FILTER_SYNTAX_LABELS, QUICK_FILTER_SYNTAX_ORDER,
  type QuickFilterMode, type QuickFilterSyntax
} from "./quickFilterTypes";

const MODE_ICONS: Record<QuickFilterMode, typeof Highlighter> = {
  highlight: Highlighter, include: Funnel, exclude: FunnelX
};
const SYNTAX_ICONS: Record<QuickFilterSyntax, typeof Highlighter> = {
  substring: Type, wildcard: Asterisk, regex: Regex
};

/** 左键循环到下一个取值（B18/D9）。 */
function cycleValue<T>(order: readonly T[], current: T): T {
  return order[(order.indexOf(current) + 1) % order.length];
}

export interface QuickFilterControlsProps {
  text: string;
  error: string | null;
  mode: QuickFilterMode;
  syntax: QuickFilterSyntax;
  onUpdateText: (value: string) => void;
  onChangeMode: (mode: QuickFilterMode) => void;
  onChangeSyntax: (syntax: QuickFilterSyntax) => void;
  onClear: () => void;
}

/**
 * 底部状态栏快速过滤控件（§6.8 / B18–B21）。
 *
 * 左键在两个图标按钮上循环切换取值，右键打开同取值域的菜单（D9）；
 * 输入框只负责文本，模式与语法是会话全局偏好（D4-R），因此按钮不随路径变化。
 */
export function QuickFilterControls({
  text, error, mode, syntax, onUpdateText, onChangeMode, onChangeSyntax, onClear
}: QuickFilterControlsProps) {
  const [menu, setMenu] = useState<{ kind: "mode" | "syntax"; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // B19：警示节点需要稳定 id，供输入框 aria-describedby 引用。
  const warningId = useId();
  const closeMenu = () => setMenu(null);

  useEffect(() => {
    if (!menu) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      // 菜单通过 portal 渲染到 document.body，因此必须显式判断事件是否落在菜单面内。
      // 之前只调用 `menuOwnsTarget(event.target)`（未传 hostId，恒为 false），
      // 导致菜单内的 pointerdown 也会关掉菜单，随后的 click 落在已卸载节点上，
      // 菜单项的 onClick 永远不会执行 —— 表现为"点菜单项没反应"。
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  /**
   * 打开时把焦点移入菜单（ARIA menu-button 模式，与菜单栏/右键菜单一致）。
   * 若焦点留在触发按钮上，按键会绕过 `handleMenuKeyDown` 冒泡到 window，
   * 被键盘直输当成过滤文本写入，违反 B14「菜单打开时不直输」。
   * 焦点落在当前取值上，方向键导航因此有确定起点。
   */
  useLayoutEffect(() => {
    if (!menu) return;
    const order: readonly string[] = menu.kind === "mode" ? QUICK_FILTER_MODE_ORDER : QUICK_FILTER_SYNTAX_ORDER;
    const current: string = menu.kind === "mode" ? mode : syntax;
    const index = Math.max(0, order.indexOf(current));
    focusMenuItem(menuButtons(menuRef.current)[index]);
  }, [menu, mode, syntax]);

  const openMenu = (kind: "mode" | "syntax") => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ kind, x: rect.left, y: rect.bottom });
  };

  const ModeIcon = MODE_ICONS[mode];
  const SyntaxIcon = SYNTAX_ICONS[syntax];
  // B19：输入框自己拥有 Esc，清空文本、保持焦点，且不再冒泡为列表的 clear-selection。
  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (text !== "") onClear();
  };

  return (
    <div className="quick-filter">
      <button type="button" className="quick-filter__button" data-quick-filter-mode={mode}
        title={`过滤模式：${QUICK_FILTER_MODE_LABELS[mode]}（左键循环，右键选择）`}
        aria-label={`过滤模式：${QUICK_FILTER_MODE_LABELS[mode]}`}
        onClick={() => onChangeMode(cycleValue(QUICK_FILTER_MODE_ORDER, mode))}
        onContextMenu={openMenu("mode")}>
        <ModeIcon size={14} aria-hidden />
      </button>
      <button type="button" className="quick-filter__button" data-quick-filter-syntax={syntax}
        title={`匹配语法：${QUICK_FILTER_SYNTAX_LABELS[syntax]}（左键循环，右键选择）`}
        aria-label={`匹配语法：${QUICK_FILTER_SYNTAX_LABELS[syntax]}`}
        onClick={() => onChangeSyntax(cycleValue(QUICK_FILTER_SYNTAX_ORDER, syntax))}
        onContextMenu={openMenu("syntax")}>
        <SyntaxIcon size={14} aria-hidden />
      </button>
      <input type="search" className="quick-filter__input" value={text} aria-label="实时过滤"
        aria-invalid={error !== null} aria-describedby={error === null ? undefined : warningId}
        onInput={(event) => onUpdateText(event.currentTarget.value)}
        onKeyDown={handleInputKeyDown} />
      {error === null ? null : (
        // B19：警示节点必须是 role="status" 的文本节点，且被输入框的 aria-describedby 指向，
        // 否则读屏器只能读到"无效"却拿不到具体错误。图标本身对辅助技术隐藏。
        <span className="quick-filter__warning" id={warningId} role="status" title={error}>
          <TriangleAlert size={14} aria-hidden />
          <span className="quick-filter__warning-text">{error}</span>
        </span>
      )}
      {menu ? createPortal(
        <MenuSurface ref={menuRef} className="quick-filter__menu" data-menu-host="quick-filter" role="menu"
          aria-label={menu.kind === "mode" ? "过滤模式" : "匹配语法"}
          style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => handleMenuKeyDown(event, closeMenu)}>
          {(menu.kind === "mode" ? QUICK_FILTER_MODE_ORDER : QUICK_FILTER_SYNTAX_ORDER).map((value) => {
            const selected = menu.kind === "mode" ? value === mode : value === syntax;
            const labels = menu.kind === "mode" ? QUICK_FILTER_MODE_LABELS : QUICK_FILTER_SYNTAX_LABELS;
            return (
              <button key={value} type="button" role="menuitemradio" aria-checked={selected}
                className={`app-menu__item${selected ? " is-selected" : ""}`}
                onClick={() => {
                  if (menu.kind === "mode") onChangeMode(value as QuickFilterMode);
                  else onChangeSyntax(value as QuickFilterSyntax);
                  closeMenu();
                }}>
                {(labels as Record<string, string>)[value]}
              </button>
            );
          })}
        </MenuSurface>, document.body) : null}
    </div>
  );
}
