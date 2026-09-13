export type SettingsApplyStep = {
  label: string;
  run: () => Promise<unknown>;
  onCommitted?: () => void;
};

export class SettingsApplyFailure extends Error {
  readonly committedLabels: string[];
  readonly failedLabel: string;
  readonly originalError: unknown;

  constructor(committedLabels: string[], failedLabel: string, originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : `无法保存${failedLabel}`);
    this.name = "SettingsApplyFailure";
    this.committedLabels = committedLabels;
    this.failedLabel = failedLabel;
    this.originalError = originalError;
  }
}

export async function runSettingsApplyPlan(steps: readonly SettingsApplyStep[]) {
  const committedLabels: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
      step.onCommitted?.();
      committedLabels.push(step.label);
    } catch (error) {
      throw new SettingsApplyFailure(committedLabels, step.label, error);
    }
  }
  return committedLabels;
}

export function formatSettingsApplyFailure(failure: SettingsApplyFailure) {
  const reason = failure.originalError instanceof Error ? failure.originalError.message : failure.message;
  const committed = failure.committedLabels.length > 0
    ? `已保存：${failure.committedLabels.join("、")}；`
    : "";
  return `${committed}未完成：${failure.failedLabel}。${reason}`;
}
