import assert from "node:assert/strict";
import React, { act } from "react";
import { useWindowMenuTheme, type WindowThemeSource } from "./useMenuTheme";
import { DEFAULT_THEME } from "./workspaceTheme";
import type { ThemeSettings } from "./types";
import { installDomEnvironment } from "./workspaceControllerTestHarness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const host = document.getElementById("root")!;
  const color = () => document.documentElement.style.getPropertyValue("--menu-hover-background");
  function Window({ source }: { source: WindowThemeSource }) { useWindowMenuTheme(source); return null; }
  try {
    const read = deferred<ThemeSettings>();
    let receive!: (value: ThemeSettings) => void;
    let releases = 0;
    const source: WindowThemeSource = {
      load: () => read.promise,
      subscribe: async listener => { receive = listener; return () => { releases++; }; }
    };
    let root = createRoot(host);
    await act(async () => root.render(<Window source={source} />));
    await act(async () => receive({ ...DEFAULT_THEME, menuHoverBackground: "#123456" }));
    await act(async () => read.resolve({ ...DEFAULT_THEME, menuHoverBackground: "#654321" }));
    assert.equal(color(), "#123456", "a late initial read cannot replace a newer settings event");
    await act(async () => root.unmount());
    assert.equal(releases, 1);
    assert.equal(color(), "");

    const subscription = deferred<() => void>();
    let loads = 0;
    root = createRoot(host);
    await act(async () => root.render(<Window source={{
      load: async () => { loads++; return DEFAULT_THEME; },
      subscribe: () => subscription.promise
    }} />));
    await act(async () => root.unmount());
    await act(async () => subscription.resolve(() => { releases++; }));
    assert.equal(releases, 2, "a subscription resolved after unmount is immediately released");
    assert.equal(loads, 0, "no read is started for an already closed window");
    assert.equal(color(), "");

    const lateRead = deferred<ThemeSettings>();
    root = createRoot(host);
    await act(async () => root.render(<Window source={{
      load: () => lateRead.promise,
      subscribe: async () => () => { releases++; }
    }} />));
    await act(async () => root.unmount());
    await act(async () => lateRead.resolve({ ...DEFAULT_THEME, menuHoverBackground: "#abcdef" }));
    assert.equal(releases, 3);
    assert.equal(color(), "", "a late read cannot reapply document colors after unmount");
    console.log("ok - independent menu themes reject stale reads and release delayed subscriptions after unmount");
  } finally { dom.window.close(); }
})();
