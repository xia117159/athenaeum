import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { findMenuTrigger, focusMenuItem, handleMenuKeyDown, menuAnchor, menuButtons, positionMenu, useMenuBranchHover, useMenuInputMode } from "./menuInteraction";
import type { MenuParent } from "./workspaceMenuState";
import "./workspace.menus.css";

export function MenuSurface({ className = "", ...props }: ComponentProps<"div">) {
  const inputMode = useMenuInputMode();
  return <div role="menu" {...props} className={`app-menu ${className}`} data-input-mode={inputMode} />;
}

export function MenuSubmenu({ label, disabled, hostId, hostKind, classPrefix, children }: {
  label: string; disabled?: boolean; hostId: string; hostKind: MenuParent["kind"];
  classPrefix: "menu-dropdown" | "context-menu"; children: ReactNode;
}) {
  const triggerId = useId(), surface = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), focusChild = useRef(false);
  const parent: MenuParent = { kind: hostKind, hostId, triggerId };
  const collapse = (keyboard = false) => {
    if (keyboard || surface.current?.contains(document.activeElement)) focusMenuItem(findMenuTrigger(parent));
    setOpen(false);
  };
  useMenuBranchHover(parent, surface, () => collapse(), open);
  const expand = (keyboard: boolean) => {
    if (disabled) return;
    if (keyboard) focusMenuItem(findMenuTrigger(parent));
    focusChild.current = keyboard;
    if (open && keyboard) focusMenuItem(menuButtons(surface.current)[0]);
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const trigger = findMenuTrigger(parent), menu = surface.current;
      if (!trigger || !menu) return;
      const { left, top } = positionMenu(menuAnchor(trigger), menu.getBoundingClientRect());
      menu.style.left = `${left}px`; menu.style.top = `${top}px`;
    };
    measure(); if (focusChild.current) { focusMenuItem(menuButtons(surface.current)[0]); focusChild.current = false; }
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (surface.current) observer?.observe(surface.current);
    window.addEventListener("resize", measure); document.addEventListener("scroll", measure, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); document.removeEventListener("scroll", measure, true); };
  }, [open, children]);
  return <>
    <button id={triggerId} type="button" role="menuitem" className={`app-menu__item app-menu__submenu-trigger ${classPrefix}__item`}
      disabled={disabled} aria-haspopup="menu" aria-expanded={open} onMouseEnter={() => expand(false)} onClick={() => expand(true)}>
      <span className="app-menu__check" /><span className="app-menu__label">{label}</span>
    </button>
    {open && createPortal(<MenuSurface ref={surface} className={`${classPrefix}__submenu-items`} data-menu-owner={hostId} aria-label={label}
      onKeyDown={event => handleMenuKeyDown(event, () => collapse(true))}>{children}</MenuSurface>, document.body)}
  </>;
}
