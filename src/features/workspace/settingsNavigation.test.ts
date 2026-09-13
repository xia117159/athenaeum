import assert from "node:assert/strict";
import { listenSettingsNavigation, requestedSettingsSection, type SettingsNavigationRequest, type SettingsNavigationRuntime } from "./settingsNavigation";

export const completion = (async () => {
  assert.equal(requestedSettingsSection("?view=settings&section=file-associations", "appearance"), "file-associations");
  assert.equal(requestedSettingsSection("?section=unknown", "file-list"), "file-list");
  const request: SettingsNavigationRequest = { id: "initial", section: "file-associations" };
  let pending: SettingsNavigationRequest | null = request;
  let listener: ((value: SettingsNavigationRequest) => void) | undefined;
  let ready!: () => void;
  let disposed = false;
  const gate = new Promise<void>(resolve => { ready = resolve; });
  const runtime: SettingsNavigationRuntime = {
    read: () => pending,
    write: value => { pending = value; },
    emit: async value => listener?.(value),
    listen: async callback => { await gate; listener = callback; return () => { disposed = true; }; }
  };
  const visits: string[] = [];
  const task = listenSettingsNavigation(section => visits.push(section), runtime);
  await runtime.emit(request); // Event before registration is recovered from pending storage.
  ready();
  const stop = await task;
  assert.deepEqual(visits, ["file-associations"]);
  assert.equal(pending, null);
  await runtime.emit(request);
  assert.equal(visits.length, 1, "replayed event cannot navigate again");
  pending = { id: "next", section: "shortcuts" };
  await runtime.emit(pending);
  assert.deepEqual(visits, ["file-associations", "shortcuts"]);
  stop(); assert.equal(disposed, true);
  console.log("ok - settings deep link and initialization event races");
})();
