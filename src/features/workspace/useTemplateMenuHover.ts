import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import type { CreationTemplateEntry } from "../../app/templates";
import type { TemplateMenuState } from "./templateCreationState";
import { templateKey } from "./templateSelection";
import { findMenuTrigger, isParentMenuSibling } from "./menuInteraction";

const OPEN_DELAY_MS = 200;
const LEAVE_DELAY_MS = 80;

interface Options {
  menu: TemplateMenuState;
  host: RefObject<HTMLDivElement | null>;
  onExpand: (depth: number, entry: CreationTemplateEntry, button: HTMLElement) => void;
  onCollapse: (depth: number) => void;
  onLeave: () => void;
}

/** Parent and child menus live in separate portals; one timer owns the whole pointer transition. */
export function useTemplateMenuHover({ menu, host, onExpand, onCollapse, onLeave }: Options) {
  const pending = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const cancel = () => { clearTimeout(pending.current?.timer); pending.current = undefined; };
  const expand = useEffectEvent(onExpand), collapse = useEffectEvent(onCollapse), leave = useEffectEvent(onLeave);
  const schedule = (key: string, run: () => void, delay = OPEN_DELAY_MS) => {
    if (pending.current?.key === key) return;
    cancel();
    pending.current = { key, timer: setTimeout(() => { pending.current = undefined; run(); }, delay) };
  };
  const hover = useEffectEvent((target: EventTarget | null) => {
    const element = target instanceof window.Element ? target : null;
    const trigger = findMenuTrigger(menu.parent);
    if (element && trigger?.contains(element)) { cancel(); return; }
    if (isParentMenuSibling(element, menu.parent)) {
      cancel(); leave(); return;
    }
    const panel = element?.closest<HTMLElement>("[data-template-depth]");
    if (!panel || !host.current?.contains(panel)) { schedule("leave", leave, LEAVE_DELAY_MS); return; }
    const depth = Number(panel.dataset.templateDepth);
    const button = element?.closest(".template-menu__row")?.querySelector<HTMLButtonElement>(".template-menu__entry");
    const level = menu.levels[depth];
    const entry = level && menu.directories[templateKey(level.relativePath)]?.entries.find(item => item.relativePath === button?.dataset.templatePath);
    if (entry?.kind === "directory" && button) {
      if (menu.levels[depth + 1]?.relativePath === entry.relativePath) cancel();
      else if (menu.levels.length > depth + 1) { cancel(); expand(depth, entry, button); }
      else schedule(`expand:${depth}:${entry.relativePath}`, () => expand(depth, entry, button));
    } else if (menu.levels.length > depth + 1) { cancel(); collapse(depth + 1); }
    else cancel();
  });
  useEffect(() => {
    if (menu.rootHidden) return;
    const over = (event: MouseEvent) => hover(event.target);
    const out = (event: MouseEvent) => {
      const next = event.relatedTarget;
      // Moving within the chain is handled once by mouseover, including immediate branch changes.
      if (next instanceof Node && (host.current?.contains(next) || findMenuTrigger(menu.parent)?.contains(next))) return;
      hover(next);
    };
    const parentKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Node && findMenuTrigger(menu.parent)?.contains(event.target)) cancel();
    };
    const parentFocus = (event: FocusEvent) => {
      if (isParentMenuSibling(event.target, menu.parent)) { cancel(); leave(); }
    };
    window.addEventListener("mouseover", over);
    window.addEventListener("mouseout", out);
    window.addEventListener("keydown", parentKeyDown, true);
    window.addEventListener("focusin", parentFocus);
    return () => {
      window.removeEventListener("mouseover", over); window.removeEventListener("mouseout", out);
      window.removeEventListener("keydown", parentKeyDown, true); cancel();
      window.removeEventListener("focusin", parentFocus);
    };
  }, [menu.id, menu.rootHidden]);
  return cancel;
}
