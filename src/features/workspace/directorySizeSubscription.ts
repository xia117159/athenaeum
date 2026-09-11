import type { DirectorySizeSnapshot, DirectorySizesGateway, SubscribeDirectorySizesRequest } from "./directorySizeTypes";
import { disposeQuietly } from "./workspaceIpc";

/** A lease owns its listener and fences both event-before-return and release-before-return. */
export function openDirectorySizeSubscription(gateway: DirectorySizesGateway, request: SubscribeDirectorySizesRequest,
  onSnapshot: (snapshot: DirectorySizeSnapshot) => void, onError: (error: unknown) => void) {
  let closed = false; let ready = false; let invoked = false;
  let unlisten: (() => void) | undefined;
  let latest: DirectorySizeSnapshot | undefined;
  const release = () => {
    void gateway.release(request.consumerId).catch((error) => { if (!closed) onError(error); });
  };
  const receive = (snapshot: DirectorySizeSnapshot) => {
    if (closed || snapshot.consumerId !== request.consumerId || latest && (snapshot.generation < latest.generation ||
      snapshot.generation === latest.generation && snapshot.sequence <= latest.sequence)) return;
    latest = snapshot;
    if (ready) onSnapshot(snapshot);
  };
  void (async () => {
    try {
      unlisten = await gateway.listen(receive);
      if (closed) { disposeQuietly(unlisten); unlisten = undefined; return; }
      invoked = true;
      const snapshot = await gateway.subscribe(request);
      if (closed) { release(); return; }
      receive(snapshot);
      ready = true;
      if (latest) onSnapshot(latest);
    } catch (error) {
      if (invoked) release();
      if (!closed) onError(error);
    }
  })();
  return { close() {
    if (closed) return;
    closed = true;
    disposeQuietly(unlisten); unlisten = undefined;
    // If invoke is pending, its continuation releases again after registration.
    if (invoked) release();
  } };
}
