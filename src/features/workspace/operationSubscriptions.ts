import type {
  OperationClearOutcome,
  OperationHistoryEventEnvelope,
  OperationTaskEventEnvelope
} from "../../app/types";

export type OperationSubscriptionSource = {
  listenOperationTasks(handler: (event: OperationTaskEventEnvelope) => void): Promise<() => void>;
  listenOperationHistory(handler: (event: OperationHistoryEventEnvelope) => void): Promise<() => void>;
  listenOperationRecordsCleared(handler: (event: OperationClearOutcome) => void): Promise<() => void>;
};

export async function subscribeOperationEvents(
  source: OperationSubscriptionSource,
  handlers: {
    task: (event: OperationTaskEventEnvelope) => void;
    history: (event: OperationHistoryEventEnvelope) => void;
    cleared: (event: OperationClearOutcome) => void;
  }
) {
  const disposers: Array<() => void> = [];
  try {
    disposers.push(await source.listenOperationTasks(handlers.task));
    disposers.push(await source.listenOperationHistory(handlers.history));
    disposers.push(await source.listenOperationRecordsCleared(handlers.cleared));
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // A failed listener registration must not leak listeners that were already installed.
      }
    }
    throw error;
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // Listener disposal is best-effort during window teardown.
      }
    }
  };
}
