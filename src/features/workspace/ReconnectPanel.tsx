import type { TabState } from "./types";

export function ReconnectPanel({ tab, onReconnect }: { tab: TabState; onReconnect: () => void }) {
  return (
    <div className="reconnect-panel">
      <button type="button" className="toolbar-button reconnect-panel__button" onClick={onReconnect}>
        重新连接
      </button>
      <span title={tab.reconnect?.path ?? tab.snapshot.location.path}>{tab.reconnect?.path ?? tab.snapshot.location.path}</span>
      {tab.reconnect?.message ? <small>{tab.reconnect.message}</small> : null}
    </div>
  );
}
