import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  COLOR_FILTER_HELP_WINDOW_LABEL,
  COLOR_FILTER_HELP_WINDOW_URL,
  openColorFilterHelpWindow,
  type ColorFilterHelpWindowAdapter,
  type ColorFilterHelpWindowConstructor,
  type ColorFilterHelpWindowHandle,
  type ColorFilterHelpWindowOptions
} from "./colorFilterHelpWindow";

function handle(events: string[], rejectEvent?: string): ColorFilterHelpWindowHandle {
  return {
    async show() { events.push("show"); },
    async setFocus() { events.push("focus"); },
    async once(event, callback) {
      events.push(`once:${event}`);
      if (event === rejectEvent) throw new Error(`cannot register ${event}`);
      if (event === "tauri://created") {
        queueMicrotask(() => callback({ event, id: 1, payload: undefined } as Parameters<typeof callback>[0]));
      }
      return () => { events.push(`unlisten:${event}`); };
    }
  };
}

function adapter(options: { existing?: ColorFilterHelpWindowHandle; rejectEvent?: string; tauri?: boolean } = {}) {
  const events: string[] = [];
  const createdOptions: ColorFilterHelpWindowOptions[] = [];
  const browserOpens: string[] = [];
  const value: ColorFilterHelpWindowAdapter = {
    hasTauriRuntime: () => options.tauri !== false,
    openBrowserWindow(url, target, features) { browserOpens.push(`${url}|${target}|${features}`); },
    async loadWebviewWindow() {
      const Constructor = function HelpWindow(_label: string, windowOptions: ColorFilterHelpWindowOptions) {
        events.push("create");
        createdOptions.push(windowOptions);
        return handle(events, options.rejectEvent);
      } as unknown as ColorFilterHelpWindowConstructor & {
        getByLabel: (label: string) => Promise<ColorFilterHelpWindowHandle | null>;
      };
      Constructor.getByLabel = async () => options.existing ?? null;
      return { WebviewWindow: Constructor };
    }
  };
  return { value, events, createdOptions, browserOpens };
}

export const completion = (async () => {
  {
    const existingEvents: string[] = [];
    const fixture = adapter({ existing: handle(existingEvents) });
    await openColorFilterHelpWindow(fixture.value);
    assert.deepEqual(existingEvents, ["show", "focus"]);
    console.log("ok - color filter help focuses an existing window");
  }

  {
    const fixture = adapter();
    await Promise.all([
      openColorFilterHelpWindow(fixture.value),
      openColorFilterHelpWindow(fixture.value)
    ]);
    assert.equal(fixture.events.filter((event) => event === "create").length, 1);
    assert.deepEqual(fixture.createdOptions, [{
      url: COLOR_FILTER_HELP_WINDOW_URL,
      title: "\u989c\u8272\u8fc7\u6ee4\u5668\u5e2e\u52a9",
      width: 860,
      height: 680,
      minWidth: 680,
      minHeight: 480,
      resizable: true,
      decorations: true,
      focus: true,
      center: true
    }]);
    assert.equal(fixture.events.includes("unlisten:tauri://created"), true);
    assert.equal(fixture.events.includes("unlisten:tauri://error"), true);
    console.log("ok - concurrent color filter help opens create one window and clean listeners");
  }

  {
    const fixture = adapter({ rejectEvent: "tauri://error" });
    const outcome = await Promise.race([
      openColorFilterHelpWindow(fixture.value).then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50))
    ]);
    assert.equal(outcome, "rejected");
    const retry = adapter({ existing: handle([]) });
    await openColorFilterHelpWindow(retry.value);
    console.log("ok - color filter help recovers from listener registration failure");
  }

  {
    const fixture = adapter({ tauri: false });
    await openColorFilterHelpWindow(fixture.value);
    assert.deepEqual(fixture.browserOpens, [
      `${COLOR_FILTER_HELP_WINDOW_URL}|${COLOR_FILTER_HELP_WINDOW_LABEL}|width=860,height=680,resizable=yes`
    ]);
    const appShell = fs.readFileSync(path.join(process.cwd(), "src/app/AppShell.tsx"), "utf8");
    assert.equal(appShell.includes('view === "color-filter-help"'), true);
    const capability = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "src-tauri/capabilities/color-filter-help.json"),
      "utf8"
    )) as { windows: string[]; permissions: string[] };
    assert.deepEqual(capability, {
      $schema: "../gen/schemas/desktop-schema.json",
      identifier: "color-filter-help",
      description: "Read-only capability for the color filter expression help window",
      windows: [COLOR_FILTER_HELP_WINDOW_LABEL],
      permissions: []
    });
    const defaultCapability = fs.readFileSync(path.join(process.cwd(), "src-tauri/capabilities/default.json"), "utf8");
    assert.equal(defaultCapability.includes(COLOR_FILTER_HELP_WINDOW_LABEL), false);
    console.log("ok - color filter help route and capability stay least privilege");
  }
})();
