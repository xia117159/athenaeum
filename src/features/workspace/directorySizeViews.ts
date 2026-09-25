import type { WorkspaceState } from "./types";
import { getVisiblePanelIds } from "./workspaceReducer";
import { sizingPathIdentity } from "./directorySizeMapping";
import type { DirectorySizeViewScope, UpdateDirectorySizeViewsRequest, DirectorySizeViewsAck, DirectorySizeViewsFlushRequested } from "./directorySizeViewsTypes";

export function collectDirectorySizeViews(state: WorkspaceState): DirectorySizeViewScope[] {
  const visible = new Set<string>(getVisiblePanelIds(state.layoutMode));
  const scopes = new Map<string, DirectorySizeViewScope>();
  for (const panel of Object.values(state.panels)) for (const tab of panel.tabs) {
    if (tab.kind !== "directory" || tab.snapshot.location.kind !== "local") continue;
    const path = tab.snapshot.location.path;
    const priority = visible.has(panel.id) && panel.activeTabId === tab.id ? 0 : 1;
    const key = sizingPathIdentity(path, true);
    if (!scopes.has(key) || scopes.get(key)!.priority > priority) scopes.set(key, { path, priority });
  }
  return [...scopes.values()].sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
}

/** Only one request in flight. Structural changes are sent without a debounce. */
export class DirectorySizeViewsPublisher {
  private scopes: DirectorySizeViewScope[] = [];
  private revision = 0;
  private sent = -1;
  private ownerEpoch?: string;
  private final?: DirectorySizeViewsFlushRequested;
  private finalSent = false;
  private finalBusy = false;
  private pendingFinal?: DirectorySizeViewsFlushRequested;
  private busy = false;
  private closed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private failures = 0;
  constructor(private send: (request: UpdateDirectorySizeViewsRequest) => Promise<DirectorySizeViewsAck>, private onFreeze: () => void = () => {}) {}
  update(scopes: DirectorySizeViewScope[]) {
    if (this.closed || this.final) return;
    if (JSON.stringify(scopes) !== JSON.stringify(this.scopes)) { this.scopes = scopes; this.revision++; }
    this.pump();
  }
  freeze(event: DirectorySizeViewsFlushRequested): boolean {
    if (this.closed || this.final) return false;
    if (!this.ownerEpoch) { this.pendingFinal = event; return false; }
    if (event.ownerEpoch !== this.ownerEpoch) return false;
    this.final = event; if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    this.onFreeze();
    this.pump(); return true;
  }
  close() { this.closed = true; if (this.retry) clearTimeout(this.retry); }
  private pump() {
    if (this.final) { this.sendFinal(); return; }
    if (this.closed || this.busy || this.retry || this.sent === this.revision && (!this.final || this.finalSent)) return;
    this.busy = true;
    const request: UpdateDirectorySizeViewsRequest = this.ownerEpoch
      ? { revision: this.revision, scopes: this.scopes, ownerEpoch: this.ownerEpoch }
      : { revision: 0, scopes: [] };
    void this.send(request).then((ack) => {
      if (this.closed) return;
      this.ownerEpoch = ack.ownerEpoch; this.failures = 0;
      if (this.pendingFinal) { const event = this.pendingFinal; this.pendingFinal = undefined; this.freeze(event); }
      if (request.ownerEpoch) { this.sent = request.revision; this.finalSent ||= !!request.shutdownNonce; }
    }).catch((error: unknown) => {
      if (this.closed || this.final) return;
      if (++this.failures <= 5) this.retry = setTimeout(() => { this.retry = undefined; this.pump(); }, this.final ? 50 : 1000);
      else { this.sent = this.revision; this.finalSent = !!this.final; console.warn("目录大小视图清单同步失败", error); }
    }).finally(() => { this.busy = false; this.pump(); });
  }
  private sendFinal() {
    if (this.closed || this.finalSent || this.finalBusy || this.retry || !this.final) return;
    this.finalBusy = true;
    const request = { revision: this.revision, scopes: this.scopes, ownerEpoch: this.ownerEpoch, shutdownNonce: this.final.nonce };
    void this.send(request).then(() => { this.finalSent = true; }).catch((error: unknown) => {
      if (this.closed) return;
      if (++this.failures <= 5) this.retry = setTimeout(() => { this.retry = undefined; this.sendFinal(); }, 50);
      else { this.finalSent = true; console.warn("目录大小最终清单同步失败", error); }
    }).finally(() => { this.finalBusy = false; });
  }
}
