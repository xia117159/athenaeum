import type { ColorFilterConfigSnapshot } from "./colorFilterTypes";

export function createMockColorFilterSnapshot(): ColorFilterConfigSnapshot {
  return {
    enabled: true,
    rules: [
      {
        id: "rule-release",
        name: "发布产物",
        enabled: true,
        target: "file",
        expression: "*.zip",
        caseSensitive: false,
        foregroundColorHex: "#2266a8",
        backgroundColorHex: null,
        priority: 1,
        migrationDiagnostic: null
      },
      {
        id: "rule-system",
        name: "系统文件",
        enabled: true,
        target: "any",
        expression: "Attributes HAS System",
        caseSensitive: false,
        foregroundColorHex: "#8d4a42",
        backgroundColorHex: null,
        priority: 2,
        migrationDiagnostic: null
      }
    ],
    revision: "0",
    rulesRevision: "0"
  };
}
