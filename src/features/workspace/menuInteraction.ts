import { useEffect, useEffectEvent, useState, type KeyboardEvent, type RefObject } from "react";
import type { MenuAnchor, MenuParent } from "./workspaceMenuState";

export function findMenuTrigger(parent?: MenuParent): HTMLElement | null {
  return parent ? document.getElementById(parent.triggerId) : null;
}
export function menuOwnsTarget(target: EventTarget | null, hostId?: string) {
  return Boolean(hostId && target instanceof window.Element && target.closest("[data-menu-owner]")?.getAttribute("data-menu-owner") === hostId);
}
export function parentMenuContains(target: EventTarget | null, parent?: MenuParent) {
  return target instanceof Node && Boolean(findMenuTrigger(parent)?.closest('[role="menu"]')?.contains(target));
}
export function isParentMenuSibling(target: EventTarget | null, parent?: MenuParent) {
  const trigger = findMenuTrigger(parent);
  const row = target instanceof window.Element ? target.closest(".app-menu__item") : null;
  return Boolean(trigger && row && !trigger.contains(row) && row.closest('[role="menu"]') === trigger.closest('[role="menu"]'));
}
export function menuAnchor(element: HTMLElement): MenuAnchor {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.right, left: bounds.left, y: bounds.top };
}
export function positionMenu(anchor: MenuAnchor, size: { width: number; height: number }, viewport = { width: window.innerWidth, height: window.innerHeight }, preferred: "left" | "right" = "right") {
  let direction = preferred, left = anchor.x;
  if (anchor.left !== undefined) {
    const candidates = { right: anchor.x - 1, left: anchor.left - size.width + 1 };
    const fits = (value: number) => value >= 8 && value + size.width <= viewport.width - 8;
    const alternative = direction === "left" ? "right" : "left";
    if (!fits(candidates[direction]) && fits(candidates[alternative])) direction = alternative;
    left = candidates[direction];
  }
  return { left: Math.max(8, Math.min(left, viewport.width - size.width - 8)),
    top: Math.max(8, Math.min(anchor.y, viewport.height - size.height - 8)), direction };
}
let lastInputMode: "pointer" | "keyboard" = "pointer";
export function useMenuInputMode() {
  const [mode, setMode] = useState(lastInputMode);
  useEffect(() => {
    const pointer = () => { lastInputMode = "pointer"; setMode(lastInputMode); };
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) { lastInputMode = "keyboard"; setMode(lastInputMode); }
    };
    window.addEventListener("pointermove", pointer, true); window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", keyboard, true);
    return () => { window.removeEventListener("pointermove", pointer, true); window.removeEventListener("pointerdown", pointer, true); window.removeEventListener("keydown", keyboard, true); };
  }, []);
  return mode;
}
export function focusMenuItem(element?: HTMLElement | null) {
  element?.focus({ preventScroll: true }); element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}
export function menuButtons(surface: HTMLElement | null) {
  return [...(surface?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    .filter(button => button.closest('[role="menu"]') === surface);
}
export function handleMenuKeyDown(event: KeyboardEvent<HTMLElement>, close: () => void) {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  event.stopPropagation();
  const choices = menuButtons(event.currentTarget), current = choices.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Escape" || event.key === "ArrowLeft" || event.key === "Tab") { event.preventDefault(); close(); }
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
    focusMenuItem(choices[next]);
  } else if (event.key === "Enter" || event.key === " " || (event.key === "ArrowRight" && choices[current]?.getAttribute("aria-haspopup") === "menu")) {
    event.preventDefault(); if (!event.repeat) choices[current]?.click();
  }
}

/** A short gap is tolerated; entering a sibling closes immediately, including across portals. */
export function useMenuBranchHover(parent: MenuParent | undefined, surface: RefObject<HTMLElement | null>, onLeave: () => void, enabled = true) {
  const leave = useEffectEvent(onLeave);
  useEffect(() => {
    if (!parent || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const enter = (target: EventTarget | null) => {
      if (target instanceof Node && (surface.current?.contains(target) || findMenuTrigger(parent)?.contains(target))) { cancel(); return; }
      if (isParentMenuSibling(target, parent)) { cancel(); leave(); }
      else if (!timer) timer = setTimeout(() => { timer = undefined; leave(); }, 80);
    };
    const over = (event: MouseEvent) => enter(event.target), out = (event: MouseEvent) => enter(event.relatedTarget);
    const focus = (event: FocusEvent) => { if (isParentMenuSibling(event.target, parent)) { cancel(); leave(); } };
    const key = () => cancel();
    window.addEventListener("mouseover", over); window.addEventListener("mouseout", out); window.addEventListener("keydown", key, true);
    window.addEventListener("focusin", focus);
    return () => { cancel(); window.removeEventListener("mouseover", over); window.removeEventListener("mouseout", out); window.removeEventListener("keydown", key, true); window.removeEventListener("focusin", focus); };
  }, [parent?.hostId, parent?.triggerId, enabled]);
}
