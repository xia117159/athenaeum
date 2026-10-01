import assert from "node:assert/strict";
import { test } from "node:test";
import { createWindowActivityGateway } from "./windowActivity";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fakeDocument() {
  const target = new EventTarget() as EventTarget & { hidden: boolean };
  target.hidden = false;
  return target;
}

test("browser window activity follows only document visibility and stops after unsubscribe", async () => {
  const doc = fakeDocument(); const seen: boolean[] = [];
  let loaded = false;
  const gateway = createWindowActivityGateway({ runtimeHost: {}, document: doc as unknown as Document,
    loadWindow: async () => { loaded = true; throw new Error("not a desktop window"); } });
  const stop = gateway.subscribe((active) => seen.push(active));
  await flush();
  doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
  doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange"));
  stop();
  doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(seen, [true, false, true]);
  assert.equal(loaded, false, "the browser fallback never asks for a desktop window");
});

test("desktop window activity treats a minimized window as inactive and releases its listeners", async () => {
  const doc = fakeDocument(); const seen: boolean[] = [];
  let minimized = false; const handlers: Array<() => void> = []; let disposed = 0;
  const register = async (handler: () => void) => { handlers.push(handler); return () => { disposed++; }; };
  const gateway = createWindowActivityGateway({ runtimeHost: { __TAURI_INTERNALS__: {} }, document: doc as unknown as Document,
    loadWindow: async () => ({ isMinimized: async () => minimized, onResized: register, onFocusChanged: register }) });
  const stop = gateway.subscribe((active) => seen.push(active));
  await flush();
  assert.equal(handlers.length, 2);
  minimized = true; handlers[0](); await flush();
  minimized = false; handlers[1](); await flush();
  stop();
  assert.deepEqual(seen, [true, false, true]);
  assert.equal(disposed, 2);
});
