import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FolderPlus } from "lucide-react";
import type { CreationTemplateEntry } from "../../app/templates";
import type { TemplateMenuState } from "./templateCreationState";
import type { useTemplateCreationController } from "./useTemplateCreationController";
import { templateKey, templateSelectionStatus } from "./templateSelection";
import { FileSystemIcon } from "./FileSystemIcon";
import { findTemplateMenuTrigger, useTemplateMenuHover } from "./useTemplateMenuHover";
import "./templates.css";

export interface TemplateCreationMenuProps { menu: TemplateMenuState; actions: ReturnType<typeof useTemplateCreationController>["actions"] }

const focus = (element: HTMLElement | null | undefined) => {
  element?.focus({ preventScroll: true });
  element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
};
const buttons = (element: HTMLElement | null | undefined) => [...(element?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];

export function TemplateCreationMenu({ menu, actions }: TemplateCreationMenuProps) {
  const host = useRef<HTMLDivElement>(null), panels = useRef<Array<HTMLDivElement | null>>([]);
  const originalFocus = useRef(document.activeElement as HTMLElement | null);
  const focusDepth = useRef<number | undefined>(0);
  const restoreFocus = () => {
    if (originalFocus.current?.isConnected && originalFocus.current !== document.body
      && !originalFocus.current.closest(".context-menu, .template-menu-host")) focus(originalFocus.current);
    else {
      const listing = document.querySelector<HTMLElement>(`.file-listing__scroll[data-panel-id="${menu.target.panelId}"]`);
      if (listing) { listing.tabIndex = -1; focus(listing); }
    }
  };
  const close = () => { restoreFocus(); actions.closeTemplateMenu(menu.id); };
  const collapse = (depth: number, moveFocus = true) => {
    const parentPath = menu.levels[depth]?.relativePath;
    const parent = depth === 0 ? findTemplateMenuTrigger(menu.target)
      : buttons(panels.current[depth - 1]).find(button => button.dataset.templatePath === parentPath);
    focusDepth.current = undefined;
    if (moveFocus || panels.current.slice(depth).some(panel => panel?.contains(document.activeElement))) focus(parent);
    actions.collapseTemplateDirectory(menu.id, depth);
  };
  const expand = (depth: number, entry: CreationTemplateEntry, button: HTMLElement, moveFocus = true) => {
    cancelHover();
    if (!moveFocus && menu.levels[depth + 1]?.relativePath !== entry.relativePath
      && panels.current.slice(depth + 1).some(panel => panel?.contains(document.activeElement))) focus(button);
    focusDepth.current = moveFocus ? depth + 1 : undefined;
    const bounds = button.closest(".template-menu__row")!.getBoundingClientRect();
    actions.expandTemplateDirectory(menu.id, depth, entry, { x: bounds.right, y: bounds.top, left: bounds.left });
  };
  const activate = (entry: CreationTemplateEntry) => {
    if (!menu.selected.length) restoreFocus();
    actions.activateTemplateItem(menu.id, entry);
  };
  const cancelHover = useTemplateMenuHover({ menu, host,
    onExpand: (depth, entry, button) => expand(depth, entry, button, false),
    onCollapse: depth => collapse(depth, false),
    onLeave: () => { if (findTemplateMenuTrigger(menu.target)) collapse(0, false); else close(); }
  });

  useLayoutEffect(() => {
    if (menu.rootHidden) { focusDepth.current = 0; return; }
    const measure = () => {
      let direction: "left" | "right" = "right";
      menu.levels.forEach((level, depth) => {
        const panel = panels.current[depth];
        if (!panel) return;
        const parentButton = buttons(panels.current[depth - 1]).find(button => button.dataset.templatePath === level.relativePath);
        const parent = parentButton?.closest(".template-menu__row")?.getBoundingClientRect();
        const anchor = parent ? { x: parent.right, left: parent.left, y: parent.top } : level.anchor;
        const bounds = panel.getBoundingClientRect();
        let left = anchor.x;
        if (anchor.left !== undefined) {
          const candidates = { right: anchor.x - 1, left: anchor.left - bounds.width + 1 };
          const fits = (value: number) => value >= 8 && value + bounds.width <= window.innerWidth - 8;
          const alternative = direction === "left" ? "right" : "left";
          if (!fits(candidates[direction]) && fits(candidates[alternative])) direction = alternative;
          left = candidates[direction];
        }
        panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8))}px`;
        panel.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - bounds.height - 8))}px`;
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    panels.current.forEach(panel => { if (panel) observer?.observe(panel); });
    window.addEventListener("resize", measure);
    host.current?.addEventListener("scroll", measure, true);
    const surface = host.current;
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); surface?.removeEventListener("scroll", measure, true); };
  }, [menu.levels, menu.directories, menu.selected.length]);

  useLayoutEffect(() => {
    const depth = focusDepth.current;
    if (depth === undefined) return;
    const panel = panels.current[depth], level = menu.levels[depth];
    if (!panel || !level) return;
    const directory = menu.directories[templateKey(level.relativePath)];
    if (menu.rootPath && (!directory || directory.status === "loading")) { focus(panel); return; }
    focus(buttons(panel)[0] ?? panel); focusDepth.current = undefined;
  }, [menu.levels, menu.directories, menu.rootPath, menu.rootHidden]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !host.current?.contains(target)
        && !(target instanceof window.Element && target.closest(".context-menu"))) actions.closeTemplateMenu(menu.id);
    };
    window.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("pointerdown", outside); };
  }, [menu.id, actions.closeTemplateMenu]);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    cancelHover();
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const panel = (event.target as HTMLElement).closest<HTMLDivElement>("[data-template-depth]");
    const depth = Number(panel?.dataset.templateDepth ?? 0);
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      if (depth > 0) collapse(depth); else close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const choices = buttons(panel), current = choices.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      focus(choices[next]);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const footer = buttons(panel?.querySelector(".template-menu__footer"));
      const current = footer.indexOf(document.activeElement as HTMLButtonElement);
      focus((event.shiftKey ? (current > 0 ? footer[current - 1] : buttons(panel)[0])
        : current < footer.length - 1 ? footer[current + 1] : buttons(panel)[0]) ?? panel);
    }
  };

  return createPortal(<div ref={host} className="template-menu-host" onKeyDown={keyDown}>
    {!menu.rootHidden && menu.levels.map((level, depth) => {
      const directory = menu.directories[templateKey(level.relativePath)];
      return <div key={level.relativePath} ref={element => { panels.current[depth] = element; }}
        role="menu" aria-label={depth === 0 ? "新建项目" : level.parent?.name} tabIndex={-1}
        data-template-depth={depth} className="template-menu" style={{ zIndex: 10001 + depth }}>
        <div className="template-menu__body">
          {level.parent ? <>
            <button type="button" role="menuitem" className="template-menu__action" tabIndex={-1} onClick={() => activate(level.parent!)}>
              <FolderPlus size={16} aria-hidden="true" /><span>创建整个文件夹</span>
            </button>
            <div className="template-menu__separator" />
          </> : null}
          {!menu.rootPath ? <div className="template-menu__message">尚未设置模板文件夹，请在设置 → 常规 → 新建项目中配置。</div>
            : !directory || directory.status === "loading" ? <div className="template-menu__message" role="status">正在读取模板…</div>
            : directory.status === "error" ? <div className="template-menu__message template-menu__error" role="alert">{directory.error}</div>
            : !directory.entries.length ? <div className="template-menu__message">此文件夹没有模板</div> : null}
          {directory?.status === "ready" ? directory.entries.map(entry => {
            const selection = templateSelectionStatus(menu.selected, entry), isFolder = entry.kind === "directory";
            const expanded = menu.levels[depth + 1]?.relativePath === entry.relativePath;
            return <div key={entry.relativePath} className={`template-menu__row${expanded ? " is-expanded" : ""}${selection === "included" ? " is-included" : ""}`}>
              <input type="checkbox" role="menuitemcheckbox" tabIndex={-1} aria-label={`选择 ${entry.relativePath}`}
                checked={selection !== "none"} disabled={selection === "included"} title={selection === "included" ? "已包含在所选文件夹中" : `选择 ${entry.name}`}
                onChange={() => actions.toggleTemplateItem(menu.id, entry)} />
              <button type="button" role="menuitem" tabIndex={-1} data-template-path={entry.relativePath}
                className="template-menu__entry" title={entry.relativePath} aria-haspopup={isFolder ? "menu" : undefined} aria-expanded={isFolder ? expanded : undefined}
                onClick={event => isFolder ? expand(depth, entry, event.currentTarget) : activate(entry)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === " ") { event.preventDefault(); if (!event.repeat) actions.toggleTemplateItem(menu.id, entry); }
                  else if (event.key === "Enter" || (event.key === "ArrowRight" && isFolder)) {
                    event.preventDefault(); if (!event.repeat) { if (isFolder) expand(depth, entry, event.currentTarget); else activate(entry); }
                  }
                }}>
                <FileSystemIcon kind={isFolder ? "folder" : "file"} path={entry.path} extension={isFolder ? undefined : entry.name.split(".").pop()} />
                <span>{entry.name}</span>{isFolder ? <ChevronRight size={14} aria-hidden="true" /> : null}
              </button>
            </div>;
          }) : null}
        </div>
        {menu.selected.length > 0 ? <div className="template-menu__footer">
          <button type="button" role="menuitem" className="template-menu__action template-menu__submit"
            onClick={() => { restoreFocus(); actions.createSelectedTemplates(menu.id); }}>
            <FolderPlus size={16} aria-hidden="true" /><span>创建所选（{menu.selected.length}）</span>
          </button>
        </div> : null}
      </div>;
    })}
  </div>, document.body);
}
