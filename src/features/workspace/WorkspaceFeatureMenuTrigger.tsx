import { useId } from "react";
import { focusMenuItem, menuAnchor, menuButtons } from "./menuInteraction";
import type { MenuParent } from "./workspaceMenuState";
import type { PanelId } from "./types";
import type { useWorkspaceController } from "./useWorkspaceController";

export function WorkspaceFeatureMenuTrigger({ feature, parent, panelId, tabId, disabled, expanded, actions, classPrefix, shortcut }: {
  feature: "templates" | "open-with"; parent: Omit<MenuParent, "triggerId">; panelId: PanelId; tabId: string;
  disabled: boolean; expanded: boolean; actions: ReturnType<typeof useWorkspaceController>["actions"];
  classPrefix: "context-menu" | "menu-dropdown"; shortcut?: string;
}) {
  const triggerId = useId();
  const open = (button: HTMLElement, keyboard = false) => {
    if (disabled) return;
    if (keyboard) focusMenuItem(button);
    if (expanded) {
      if (keyboard) {
        const host = [...document.querySelectorAll<HTMLElement>("[data-menu-owner]")].find(element =>
          element.dataset.menuOwner === parent.hostId && element.matches(feature === "templates" ? ".template-menu-host" : ".open-with-menu"));
        const surface = feature === "templates" ? host?.querySelector<HTMLElement>('[data-template-depth="0"]') : host;
        focusMenuItem(surface?.classList.contains("open-with-menu") ? surface : menuButtons(surface ?? null)[0] ?? surface);
      }
      return;
    }
    const owner = { ...parent, triggerId }, anchor = menuAnchor(button);
    if (feature === "templates") actions.openTemplateMenu(panelId, tabId, anchor, owner);
    else actions.requestOpenWith(owner, anchor);
  };
  return <button id={triggerId} type="button" role="menuitem" className={`app-menu__item app-menu__submenu-trigger ${classPrefix}__item`}
    disabled={disabled} aria-haspopup="menu" aria-expanded={expanded}
    title={disabled ? feature === "templates" ? "新建项目仅支持可用的本地文件夹" : "请选择可打开的文件，并结束当前编辑" : undefined}
    aria-label={feature === "templates" ? "新建项目" : "打开方式"}
    data-template-menu-trigger={feature === "templates" ? "" : undefined}
    onMouseEnter={event => open(event.currentTarget)} onClick={event => open(event.currentTarget, true)}
    onKeyDown={event => { if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); open(event.currentTarget, true); } }}>
    <span className="app-menu__check" /><span className="app-menu__label">{feature === "templates" ? "新建项目" : "打开方式"}</span>
    {shortcut ? <span className="menu-dropdown__shortcut">{shortcut}</span> : null}
  </button>;
}
