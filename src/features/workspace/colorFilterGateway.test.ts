import assert from "node:assert/strict";
import {
  getColorFilterSnapshot,
  listenColorFilterChanged,
  replaceColorFilterRules,
  setColorFilterEnabled,
  validateColorFilterRule
} from "./colorFilterGateway";
import type { ColorFilterConfigSnapshot } from "./colorFilterTypes";
import type { WorkspaceInvoke } from "./workspaceIpc";

async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const snapshot: ColorFilterConfigSnapshot = {
  enabled: true,
  rules: [],
  revision: "9007199254740993",
  rulesRevision: "9007199254740992"
};

export const colorFilterGatewayTests = (async () => {
  await test("browser fallback keeps bootstrap mock rules on the first global toggle", async () => {
    const runtime = { runtimeHost: null };
    const toggled = await setColorFilterEnabled(false, runtime);

    assert.equal(toggled.snapshot.enabled, false);
    assert.deepEqual(toggled.snapshot.rules.map((rule) => rule.id), ["rule-release", "rule-system"]);
    assert.deepEqual(toggled.warnings, []);
    const reloaded = await getColorFilterSnapshot(runtime);
    assert.deepEqual(reloaded, toggled.snapshot);

    const restored = await setColorFilterEnabled(true, runtime);
    assert.equal(restored.snapshot.enabled, true);
    assert.deepEqual(restored.snapshot.rules, toggled.snapshot.rules);
  });

  await test("color filter commands preserve string revisions and typed arguments", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "validate_color_filter_rule") {
        return { valid: true, message: null, span: null } as T;
      }
      if (command === "get_settings_snapshot") {
        return { colorFilter: snapshot } as T;
      }
      if (command === "replace_color_rules") {
        return { status: "applied", snapshot, warnings: [] } as T;
      }
      return { snapshot, warnings: [] } as T;
    };
    const runtime = { invoke, runtimeHost: { __TAURI_INTERNALS__: {} } };

    await setColorFilterEnabled(false, runtime);
    await getColorFilterSnapshot(runtime);
    await replaceColorFilterRules(
      { rules: [], baseRulesRevision: "9007199254740992", force: false },
      runtime
    );
    await validateColorFilterRule("Size >= 20MB", runtime);

    assert.deepEqual(calls, [
      { command: "set_color_filter_enabled", args: { enabled: false } },
      { command: "get_settings_snapshot", args: {} },
      {
        command: "replace_color_rules",
        args: { request: { rules: [], baseRulesRevision: "9007199254740992", force: false } }
      },
      { command: "validate_color_filter_rule", args: { expression: "Size >= 20MB" } }
    ]);
  });

  await test("color filter listener uses the dedicated revisioned event", async () => {
    let eventName = "";
    let received: ColorFilterConfigSnapshot | undefined;
    const dispose = await listenColorFilterChanged(
      (value) => {
        received = value;
      },
      {
        runtimeHost: { __TAURI_INTERNALS__: {} },
        listen: async <T,>(name: string, handler: (event: { payload: T }) => void | Promise<void>) => {
          eventName = name;
          handler({ payload: snapshot as unknown as T });
          return () => undefined;
        }
      }
    );

    assert.equal(eventName, "color-filter-changed");
    assert.equal(received?.revision, "9007199254740993");
    dispose();
  });
})();
