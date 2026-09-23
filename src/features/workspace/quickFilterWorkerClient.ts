import type { QuickFilterEvaluationRequest, QuickFilterEvaluationResult } from "./quickFilterTypes";

export const QUICK_FILTER_WORKER_TIMEOUT_MS = 10_000;
type Reply = { id: number; result?: QuickFilterEvaluationResult; failure?: string };
export interface QuickFilterWorkerEndpoint {
  postMessage(message: { id: number; request: QuickFilterEvaluationRequest }): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<Reply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
type Pending = {
  id: number; request: QuickFilterEvaluationRequest; signal?: AbortSignal; abort(): void;
  resolve(result: QuickFilterEvaluationResult): void; reject(error: Error): void;
};
const aborted = () => new DOMException("Aborted", "AbortError");

/** One physical Worker, one active batch. Cancelling a path never fails other paths. */
export class QuickFilterWorkerClient {
  private worker: QuickFilterWorkerEndpoint | null = null;
  private nextId = 1;
  private queue: Pending[] = [];
  private active: Pending | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly createWorker: () => QuickFilterWorkerEndpoint,
    private readonly timeoutMs = QUICK_FILTER_WORKER_TIMEOUT_MS) {}

  evaluate(request: QuickFilterEvaluationRequest, signal?: AbortSignal): Promise<QuickFilterEvaluationResult> {
    if (this.disposed || signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const pending: Pending = { id: this.nextId++, request, signal, resolve, reject,
        abort: () => {
          if (this.active === pending) this.finish(undefined, aborted(), true);
          else {
            this.queue = this.queue.filter(item => item !== pending);
            this.cleanup(pending);
            reject(aborted());
          }
        } };
      signal?.addEventListener("abort", pending.abort, { once: true });
      this.queue.push(pending);
      this.pump();
    });
  }

  dispose() {
    this.disposed = true;
    for (const pending of this.queue.splice(0)) {
      this.cleanup(pending);
      pending.reject(aborted());
    }
    this.finish(undefined, aborted(), true);
  }

  private pump() {
    if (this.disposed || this.active || !this.queue.length) return;
    const pending = this.queue.shift()!;
    this.active = pending;
    try {
      const worker = this.worker ?? (this.worker = this.createWorker());
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker || this.active?.id !== data.id) return;
        this.finish(data.result, data.failure ? new Error(data.failure) : undefined);
      };
      worker.onerror = (event) => {
        if (this.worker === worker) this.finish(undefined, new Error(event.message || "正则过滤计算失败"), true);
      };
      worker.onmessageerror = () => {
        if (this.worker === worker) this.finish(undefined, new Error("无法读取正则过滤结果"), true);
      };
      this.timer = setTimeout(() => this.finish(undefined, new Error("正则过滤计算超时，请简化表达式后重试"), true), this.timeoutMs);
      worker.postMessage({ id: pending.id, request: pending.request });
    } catch (error) {
      this.finish(undefined, error instanceof Error ? error : new Error(String(error)), true);
    }
  }

  private finish(result?: QuickFilterEvaluationResult, error?: Error, terminate = false) {
    clearTimeout(this.timer);
    const pending = this.active;
    this.active = null;
    if (terminate) {
      const worker = this.worker;
      this.worker = null;
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
    }
    if (pending) {
      this.cleanup(pending);
      if (error || !result) pending.reject(error ?? new Error("正则过滤未返回结果"));
      else pending.resolve(result);
    }
    this.pump();
  }

  private cleanup(pending: Pending) {
    pending.signal?.removeEventListener("abort", pending.abort);
  }
}

export function createQuickFilterWorkerClient() {
  return new QuickFilterWorkerClient(() => new Worker(new URL("assets/quickFilter.worker.js", document.baseURI), { type: "module" }));
}
