import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import type { CreationTemplateEntry } from "../../app/templates";
import type { TemplateMenuState, TemplateTarget } from "./templateCreationState";
import { templateKey } from "./templateSelection";

const HOVER_DELAY_MS = 200;

export function findTemplateMenuTrigger(target: TemplateTarget): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-template-menu-trigger]")].find(button =>
    button.dataset.templatePanel === target.panelId && button.dataset.templateTab === target.tabId);
}

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
  const schedule = (key: string, run: () => void) => {
    if (pending.current?.key === key) return;
    cancel();
    pending.current = { key, timer: setTimeout(() => { pending.current = undefined; run(); }, HOVER_DELAY_MS) };
  };
  const hover = useEffectEvent((target: EventTarget | null) => {
    const element = target instanceof window.Element ? target : null;
    if (element && findTemplateMenuTrigger(menu.target)?.contains(element)) { cancel(); return; }
    const panel = element?.closest<HTMLElement>("[data-template-depth]");
    if (!panel || !host.current?.contains(panel)) { schedule("leave", leave); return; }
    const depth = Number(panel.dataset.templateDepth);
    const button = element?.closest(".template-menu__row")?.querySelector<HTMLButtonElement>(".template-menu__entry");
    const level = menu.levels[depth];
    const entry = level && menu.directories[templateKey(level.relativePath)]?.entries.find(item => item.relativePath === button?.dataset.templatePath);
    if (entry?.kind === "directory" && button) {
      if (menu.levels[depth + 1]?.relativePath === entry.relativePath) cancel();
      else schedule(`expand:${depth}:${entry.relativePath}`, () => expand(depth, entry, button));
    } else if (menu.levels.length > depth + 1) schedule(`collapse:${depth + 1}`, () => collapse(depth + 1));
    else cancel();
  });
  useEffect(() => {
    if (menu.rootHidden) return;
    const over = (event: MouseEvent) => hover(event.target);
    const out = (event: MouseEvent) => hover(event.relatedTarget);
    const parentKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Node && findTemplateMenuTrigger(menu.target)?.contains(event.target)) cancel();
    };
    window.addEventListener("mouseover", over);
    window.addEventListener("mouseout", out);
    window.addEventListener("keydown", parentKeyDown, true);
    return () => {
      window.removeEventListener("mouseover", over); window.removeEventListener("mouseout", out);
      window.removeEventListener("keydown", parentKeyDown, true); cancel();
    };
  }, [menu.id, menu.rootHidden]);
  return cancel;
}
