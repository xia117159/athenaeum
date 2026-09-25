import { openDirectorySizeSubscription } from "./directorySizeSubscription";
import type { DirectorySizeSnapshot, DirectorySizesGateway, SubscribeDirectorySizesRequest } from "./directorySizeTypes";

type Subscription = ReturnType<typeof openDirectorySizeSubscription>;
type Intent = { request: SubscribeDirectorySizesRequest; receive(snapshot: DirectorySizeSnapshot): void; fail(error: unknown): void };

/** One serialized handoff lane per visible local panel. Display callbacks retain
 * their own tab/request fence; the lane owns only native subscription lifetime. */
export class DirectorySizeSlot {
  private revision = 0;
  private epoch = 0;
  private desired?: Intent;
  private active?: { consumer: string; subscription: Subscription };
  private pending?: Subscription;
  private pumping = false;
  private stopWait?: () => void;
  constructor(private gateway: DirectorySizesGateway, private slotId: string, private timeoutMs = 5000) {}

  replace(intent: Intent): () => void {
    this.desired = intent;
    void this.pump();
    return () => { if (this.desired === intent) this.clear(); };
  }

  clear() {
    this.epoch++;
    this.desired = undefined;
    this.pending?.close();
    this.stopWait?.();
    this.active?.subscription.close();
    this.active = undefined;
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.desired && this.desired.request.consumerId !== this.active?.consumer) {
        const intent = this.desired;
        const epoch = this.epoch;
        const request = { ...intent.request, slotId: this.slotId, slotRevision: ++this.revision,
          handoffFrom: this.active?.consumer };
        const subscription = openDirectorySizeSubscription(this.gateway, request, intent.receive, intent.fail);
        this.pending = subscription;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<false>((resolve) => {
          this.stopWait = () => { clearTimeout(timer); resolve(false); };
          timer = setTimeout(() => {
          subscription.close();
          if (this.desired === intent) intent.fail(new Error("目录统计订阅交接超时"));
          resolve(false);
        }, this.timeoutMs); });
        const accepted = await Promise.race([subscription.settled, timeout]);
        clearTimeout(timer);
        this.stopWait = undefined;
        this.pending = undefined;
        if (epoch !== this.epoch) { subscription.close(); continue; }
        this.active?.subscription.close();
        this.active = accepted ? { consumer: request.consumerId, subscription } : undefined;
        if (!accepted && this.desired === intent) { this.desired = undefined; subscription.close(); }
      }
    } finally { this.pumping = false; }
  }
}
