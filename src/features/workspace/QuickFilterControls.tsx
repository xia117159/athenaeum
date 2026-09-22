import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Asterisk, Funnel, FunnelX, Highlighter, Regex, TriangleAlert, Type } from "lucide-react";
import { MenuSurface } from "./MenuPrimitives";
import { focusMenuItem, handleMenuKeyDown, menuButtons, positionMenu } from "./menuInteraction";
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

/**
 * 输入框的悬停提示（评审 G-8 / spec.md:218）。
 * 语法是会话全局偏好（D4-R），因此提示必须就地说明当前语法及其写法，
 * 否则鼠标用户唯一的线索是两个只显示图标的按钮。
 */
const INPUT_HINTS: Record<QuickFilterSyntax, string> = {
  substring: "实时过滤：子串匹配（忽略大小写，中文可按拼音或首字母）",
  wildcard: "实时过滤：通配符匹配 —— * 匹配任意多个字符，? 匹配任意一个字符",
  regex: "实时过滤：正则表达式（忽略大小写，按名称匹配；不支持环视与反向引用）"
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
  const [menu, setMenu] = useState<{ kind: "mode" | "syntax"; anchor: { x: number; y: number } } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 打开菜单的触发按钮；重新定位时据此重新取锚点，避免窗口变化后锚点过期。 */
  const triggerRef = useRef<HTMLElement | null>(null);
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
   * 打开时定位菜单。
   *
   * 评审 B-3：原实现把 `rect.bottom` 直接写成 `style.top` 且**从不调用** `positionMenu`，
   * 于是底部状态栏上的菜单会有一大半落到视口之外 —— 出厂默认（折叠侧栏）实测
   * 菜单 863..935 对视口高 865，可见比例仅 0.028，溢出 70px 且不随窗口尺寸变化，
   * 而 body 是 `overflow:hidden`，用户无法滚动看到，右键菜单等于不可用。
   *
   * 这里复用仓库既有的 `positionMenu`（与菜单栏/右键菜单同一套夹取规则），
   * 并在菜单挂载、内容尺寸变化、窗口尺寸变化时**重新量取**，因为菜单高度只有在
   * 挂载后才知道。`positionMenu` 的 top 夹取上界是 `viewport.height - size.height - 8`，
   * 因此只要传入真实高度，菜单必然完整落在视口内。
   */
  useLayoutEffect(() => {
    if (!menu) return undefined;
    const measure = () => {
      const surface = menuRef.current;
      const trigger = triggerRef.current;
      if (!surface || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const bounds = surface.getBoundingClientRect();
      const { left, top } = positionMenu({ x: rect.left, y: rect.bottom }, bounds);
      surface.style.left = `${left}px`;
      surface.style.top = `${top}px`;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener("resize", measure);
    // IR1 F-2：触发按钮会在**不发生 resize** 的情况下移动（拖动分隔条改变面板宽度、滚动列表
    // 都会让底部状态栏里的按钮位移）。只接 `resize` 会让菜单停在旧位置。用捕获阶段监听
    // `document` 的滚动，与兄弟菜单保持一致（`MenuPrimitives.tsx:42`、`OpenWithMenu.tsx:57`、
    // `TemplateCreationMenu.tsx:81`）。
    document.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [menu]);

  /**
   * 打开时把焦点移入菜单（ARIA menu-button 模式，与菜单栏/右键菜单一致）。
   * 若焦点留在触发按钮上，按键会绕过 `handleMenuKeyDown` 冒泡到 window，
   * 被键盘直输当成过滤文本写入，违反 B14「菜单打开时不直输」。
   * 焦点落在当前取值上，方向键导航因此有确定起点。
   *
   * 注意：该 effect 必须在定位 effect **之后**声明并保持依赖形状独立，
   * 否则每次重新定位都会把焦点从用户刚移到的菜单项上抢回当前取值。
   */
  useLayoutEffect(() => {
    if (!menu) return;
    const order: readonly string[] = menu.kind === "mode" ? QUICK_FILTER_MODE_ORDER : QUICK_FILTER_SYNTAX_ORDER;
    const current: string = menu.kind === "mode" ? mode : syntax;
    const index = Math.max(0, order.indexOf(current));
    focusMenuItem(menuButtons(menuRef.current)[index]);
    // 仅在"菜单刚打开"或当前取值变化时重新聚焦。
  }, [menu?.kind, mode, syntax]);

  const openMenu = (kind: "mode" | "syntax") => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    triggerRef.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ kind, anchor: { x: rect.left, y: rect.bottom } });
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
        title={INPUT_HINTS[syntax]}
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
          style={{ left: menu.anchor.x, top: menu.anchor.y }} onKeyDown={(event) => handleMenuKeyDown(event, closeMenu)}>
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
