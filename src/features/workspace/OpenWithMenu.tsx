import type { FileAssociationRule } from "../../app/fileAssociations";
import type { OpenWithMenuState } from "./fileOpeningState";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { associationProgramFallback, formatAssociationCommand } from "./fileAssociations";
import { AssociationProgramIcon } from "./AssociationProgramIcon";
import "./file-opening.css";

export interface OpenWithMenuProps {
  menu: OpenWithMenuState;
  rules: readonly FileAssociationRule[];
  onSelect: (requestId: string, index: number) => void;
  onConfirm: (requestId: string, index?: number) => void;
  onClose: (requestId: string) => void;
}

function findListing(panelId: string) {
  return document.querySelector<HTMLElement>(`.file-listing__scroll[data-panel-id="${panelId}"]`);
}

export function OpenWithMenu({ menu, rules, onSelect, onConfirm, onClose }: OpenWithMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const choices = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const measure = useCallback(() => {
    const surface = root.current;
    if (!surface) return;
    const listing = findListing(menu.panelId);
    const row = Array.from(listing?.querySelectorAll<HTMLElement>("[data-entry-path]") ?? [])
      .find(element => element.dataset.entryPath === menu.path);
    const anchor = (row ?? listing)?.getBoundingClientRect();
    const rect = surface.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor?.left ?? 8, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(anchor?.top ?? 8, window.innerHeight - rect.height - 8));
    setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
  }, [menu.panelId, menu.path]);

  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [menu.requestId]);
  useLayoutEffect(measure, [measure, menu.programs, menu.programsError, rules]);
  useLayoutEffect(() => {
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    const listing = findListing(menu.panelId);
    if (listing) observer?.observe(listing);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [measure, menu.panelId]);
  useLayoutEffect(() => {
    const selected = document.getElementById(`${menu.requestId}-${menu.selectedIndex}`);
    const scroller = choices.current;
    if (!selected || !scroller?.contains(selected)) return;
    const bounds = scroller.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    if (item.top < bounds.top) scroller.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) scroller.scrollTop += item.bottom - bounds.bottom;
  }, [menu.requestId, menu.selectedIndex, menu.programs]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onClose(menu.requestId);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [menu.requestId, onClose]);

  const restoreListingFocus = () => {
    const listing = findListing(menu.panelId);
    if (listing) {
      // Programmatic focus returns keyboard ownership without adding a Tab stop.
      listing.tabIndex = -1;
      listing.focus({ preventScroll: true });
    }
  };
  const confirm = (index: number) => {
    if (index < menu.ruleIds.length) restoreListingFocus();
    onConfirm(menu.requestId, index);
  };
  const byId = new Map(rules.map(rule => [rule.id, rule]));
  return createPortal(
    <div ref={root} className="open-with-menu" role="menu" aria-label="打开方式" tabIndex={-1}
      aria-activedescendant={`${menu.requestId}-${menu.selectedIndex}`} style={position}
      onMouseDown={event => event.preventDefault()}
      onKeyDown={event => {
        event.preventDefault(); event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown") onSelect(menu.requestId, menu.selectedIndex + 1);
        else if (event.key === "ArrowUp") onSelect(menu.requestId, menu.selectedIndex - 1);
        else if (event.key === "Home") onSelect(menu.requestId, 0);
        else if (event.key === "End") onSelect(menu.requestId, menu.ruleIds.length);
        else if (event.key === "Enter" && !event.repeat) confirm(menu.selectedIndex);
        else if (event.key === "Escape" || event.key === "Tab") {
          restoreListingFocus(); onClose(menu.requestId);
        }
      }}>
      <div className="open-with-menu__choices" ref={choices}>
        {menu.ruleIds.length === 0 ? <div className="open-with-menu__empty">没有匹配的自定义关联</div> : null}
        {menu.ruleIds.map((id, index) => {
          const rule = byId.get(id);
          if (!rule) return null;
          const program = menu.programs[rule.executablePath];
          const name = program?.displayName.trim() || associationProgramFallback(rule.executablePath);
          const detail = formatAssociationCommand(rule);
          const warning = program?.exists === false ? "程序不存在或无法访问" : "";
          return <button key={id} id={`${menu.requestId}-${index}`} type="button" role="menuitem" tabIndex={-1}
            className={`open-with-menu__item${menu.selectedIndex === index ? " is-selected" : ""}`}
            title={[name, detail, warning].filter(Boolean).join("\n")}
            aria-label={[name, detail, warning].filter(Boolean).join("，")}
            onMouseEnter={() => onSelect(menu.requestId, index)} onClick={() => confirm(index)}>
            <AssociationProgramIcon path={rule.executablePath} exists={program?.exists} />
            <span className="open-with-menu__text">{name}</span>
          </button>;
        })}
      </div>
      {menu.programsError ? <div className="open-with-menu__message" title={menu.programsError}>程序名称读取失败，已显示文件名</div> : null}
      <div className="open-with-menu__footer">
        <button id={`${menu.requestId}-${menu.ruleIds.length}`} type="button" role="menuitem" tabIndex={-1}
          className={`open-with-menu__item${menu.selectedIndex === menu.ruleIds.length ? " is-selected" : ""}`}
          onMouseEnter={() => onSelect(menu.requestId, menu.ruleIds.length)} onClick={() => confirm(menu.ruleIds.length)}>
          <Settings2 size={16} aria-hidden="true" /><span>打开自定义文件关联</span>
        </button>
      </div>
    </div>, document.body
  );
}
