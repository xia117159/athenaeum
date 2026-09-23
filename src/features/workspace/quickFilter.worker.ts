import { evaluateQuickFilter } from "./quickFilterEvaluator";
import type { QuickFilterEvaluationRequest } from "./quickFilterTypes";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; request: QuickFilterEvaluationRequest }>) => void) | null;
  postMessage(message: unknown): void;
};
workerScope.onmessage = (event: MessageEvent<{ id: number; request: QuickFilterEvaluationRequest }>) => {
  const { id, request } = event.data;
  try {
    workerScope.postMessage({ id, result: evaluateQuickFilter(request) });
  } catch (error) {
    workerScope.postMessage({ id, failure: error instanceof Error ? error.message : String(error) });
  }
};
