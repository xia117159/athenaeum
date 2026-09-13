import { useEffect, useLayoutEffect, useState } from "react";
import type { ThemeSettings } from "./types";
import { DEFAULT_THEME, normalizeTheme } from "./workspaceTheme";
import { getWorkspaceTheme, listenWorkspaceSettingsChanged } from "./workspaceSettingsGateway";
import { devWarn } from "./devLog";

/** Apply at the document boundary so body portals inherit the same appearance. */
export function useDocumentMenuTheme(theme: ThemeSettings) {
  const { menuHoverBackground, menuHoverText, fileHoverBorder } = theme;
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    const values = { "--menu-hover-background": menuHoverBackground, "--menu-hover-text": menuHoverText, "--file-hover-border": fileHoverBorder };
    const previous = Object.keys(values).map(key => [key, style.getPropertyValue(key)] as const);
    for (const [key, value] of Object.entries(values)) style.setProperty(key, value);
    return () => { for (const [key, value] of previous) { if (value) style.setProperty(key, value); else style.removeProperty(key); } };
  }, [menuHoverBackground, menuHoverText, fileHoverBorder]);
}

export interface WindowThemeSource {
  load: () => Promise<ThemeSettings>;
  subscribe: (receive: (theme: ThemeSettings) => void) => Promise<() => void>;
}
const defaultSource: WindowThemeSource = {
  load: getWorkspaceTheme,
  subscribe: receive => listenWorkspaceSettingsChanged(event => receive(event.settingsModel.theme))
};

/** Independent windows only need a settings read/subscription, not a file workspace. */
export function useWindowMenuTheme(source: WindowThemeSource = defaultSource) {
  const [theme, setTheme] = useState(DEFAULT_THEME);
  useDocumentMenuTheme(theme);
  useEffect(() => {
    let disposed = false, revision = 0, unsubscribe: (() => void) | undefined;
    const receive = (value: ThemeSettings) => { if (!disposed) { revision++; setTheme(normalizeTheme(value)); } };
    const load = async () => {
      try {
        const release = await source.subscribe(receive);
        if (disposed) { release(); return; }
        unsubscribe = release;
      } catch (error) { devWarn("菜单外观订阅失败", error); }
      if (disposed) return;
      const beforeRead = revision;
      try {
        const saved = await source.load();
        if (!disposed && revision === beforeRead) setTheme(normalizeTheme(saved));
      } catch (error) { devWarn("菜单外观读取失败，使用默认颜色", error); }
    };
    void load();
    return () => { disposed = true; unsubscribe?.(); };
  }, [source]);
}
