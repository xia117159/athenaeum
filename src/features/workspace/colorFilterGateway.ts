import { listen } from "@tauri-apps/api/event";
import type { SettingsSnapshot as BackendSettingsSnapshot } from "../../app/types";
import { createBrowserSettingsSnapshot } from "./workspaceBackendDtos";
import type {
  ColorFilterConfigSnapshot,
  ColorFilterMutationResult,
  ColorFilterValidationResult,
  ReplaceColorRulesRequest,
  ReplaceColorRulesResult
} from "./colorFilterTypes";
import { createMockColorFilterSnapshot } from "./colorFilterMockData";
import { hasTauriRuntime, invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";

type ColorFilterEvent<T> = { payload: T };

export type ColorFilterRuntime = {
  invoke?: WorkspaceInvoke;
  runtimeHost?: object | null;
  listen?: <T>(
    eventName: string,
    handler: (event: ColorFilterEvent<T>) => void | Promise<void>
  ) => Promise<() => void>;
};

let browserSnapshot: ColorFilterConfigSnapshot = createMockColorFilterSnapshot();

function incrementRevision(value: string) {
  return (BigInt(value) + 1n).toString(10);
}

export async function getColorFilterSnapshot(runtime: ColorFilterRuntime = {}) {
  const settings = await invokeRequired<BackendSettingsSnapshot>(
    "get_settings_snapshot",
    {},
    async () => createBrowserSettingsSnapshot({ colorFilter: browserSnapshot }),
    runtime.invoke,
    runtime.runtimeHost
  );
  if (!hasTauriRuntime(runtime.runtimeHost)) {
    browserSnapshot = settings.colorFilter;
  }
  return settings.colorFilter;
}

export function setColorFilterEnabled(enabled: boolean, runtime: ColorFilterRuntime = {}) {
  return invokeRequired<ColorFilterMutationResult>(
    "set_color_filter_enabled",
    { enabled },
    async () => {
      if (browserSnapshot.enabled !== enabled) {
        browserSnapshot = {
          ...browserSnapshot,
          enabled,
          revision: incrementRevision(browserSnapshot.revision)
        };
      }
      return { snapshot: browserSnapshot, warnings: [] };
    },
    runtime.invoke,
    runtime.runtimeHost
  );
}

export function replaceColorFilterRules(
  request: ReplaceColorRulesRequest,
  runtime: ColorFilterRuntime = {}
) {
  return invokeRequired<ReplaceColorRulesResult>(
    "replace_color_rules",
    { request },
    async () => {
      const revision = incrementRevision(browserSnapshot.revision);
      const rulesRevision = incrementRevision(browserSnapshot.rulesRevision);
      browserSnapshot = {
        ...browserSnapshot,
        rules: request.rules.map((rule, index) => ({
          ...rule,
          priority: index + 1,
          migrationDiagnostic: null
        })),
        revision,
        rulesRevision
      };
      return { status: "applied", snapshot: browserSnapshot, warnings: [] };
    },
    runtime.invoke,
    runtime.runtimeHost
  );
}

export function validateColorFilterRule(expression: string, runtime: ColorFilterRuntime = {}) {
  return invokeRequired<ColorFilterValidationResult>(
    "validate_color_filter_rule",
    { expression },
    async () => ({
      valid: expression.trim().length > 0,
      message: expression.trim().length > 0 ? null : "Expression is required",
      span: expression.trim().length > 0 ? null : { start: 0, end: 0 }
    }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function listenColorFilterChanged(
  handler: (snapshot: ColorFilterConfigSnapshot) => void,
  runtime: ColorFilterRuntime = {}
) {
  if (!hasTauriRuntime(runtime.runtimeHost) && !runtime.listen) {
    return () => undefined;
  }
  const listenFn = runtime.listen ?? listen;
  return listenFn<ColorFilterConfigSnapshot>("color-filter-changed", (event) => {
    handler(event.payload);
  });
}
