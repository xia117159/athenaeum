import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import type { OperationHistoryTab } from "./operationHistoryModel";
import {
  createEmptyOperationHistoryReadState,
  OPERATION_HISTORY_READ_STORAGE_KEY,
  type OperationHistoryReadState
} from "./operationHistoryReadStore";
import {
  useOperationHistoryReadState,
  type OperationHistoryReadEnvironment
} from "./useOperationHistoryReadState";
import { installDomEnvironment } from "./workspaceControllerTestHarness";

const idsByTab: Record<OperationHistoryTab, string[]> = {
  running: ["run-1"],
  waiting: ["wait-1"],
  problems: ["problem-1"],
  completed: ["done-1"],
  history: ["history-1"]
};

async function flushEffects() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  globalThis.CustomEvent = dom.window.CustomEvent;
  const firstContainer = document.getElementById("root")!;
  const firstRoot = ReactDOM.createRoot(firstContainer);
  let stored = JSON.stringify({
    ...createEmptyOperationHistoryReadState("epoch-a"),
    revision: 5,
    selectedTab: "problems"
  } satisfies OperationHistoryReadState);
  let syncHandler: (() => void) | undefined;
  let firstResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  const readOnlyEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem: () => stored,
      setItem: (_key, value) => { stored = value; }
    },
    createEpoch: () => "recovered-epoch",
    isForeground: () => false,
    async subscribe(handler) { syncHandler = handler; return () => undefined; },
    async notify() {},
    subscribeForeground() { return () => undefined; }
  };

  function ReadOnlyProbe() {
    firstResult = useOperationHistoryReadState(idsByTab, false, readOnlyEnvironment);
    return null;
  }

  try {
    await act(async () => {
      firstRoot.render(<ReadOnlyProbe />);
      await flushEffects();
    });
    assert.equal(firstResult?.ready, true);
    assert.equal(firstResult?.readState.revision, 5);

    stored = JSON.stringify({
      ...createEmptyOperationHistoryReadState("epoch-a"),
      revision: 4,
      selectedTab: "history"
    } satisfies OperationHistoryReadState);
    await act(async () => syncHandler?.());
    assert.equal(firstResult?.readState.revision, 5);
    assert.equal(firstResult?.readState.selectedTab, "problems");

    stored = JSON.stringify({
      ...createEmptyOperationHistoryReadState("epoch-b"),
      revision: 1,
      selectedTab: "history"
    } satisfies OperationHistoryReadState);
    await act(async () => syncHandler?.());
    assert.equal(firstResult?.readState.epoch, "epoch-b");
    assert.equal(firstResult?.readState.revision, 1);
    assert.equal(firstResult?.readState.selectedTab, "history");
  } finally {
    await act(async () => firstRoot.unmount());
  }

  const secondContainer = document.createElement("div");
  document.body.appendChild(secondContainer);
  const secondRoot = ReactDOM.createRoot(secondContainer);
  let foreground = false;
  let foregroundHandler: (() => void) | undefined;
  let notifyCount = 0;
  let writerResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  stored = JSON.stringify({
    ...createEmptyOperationHistoryReadState("writer-epoch"),
    revision: 2,
    selectedTab: "problems",
    seenIdsByTab: {
      ...createEmptyOperationHistoryReadState("writer-epoch").seenIdsByTab,
      completed: ["done-1"]
    }
  } satisfies OperationHistoryReadState);
  const writerEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem: () => stored,
      setItem: (_key, value) => { stored = value; }
    },
    createEpoch: () => "recovered-writer-epoch",
    isForeground: () => foreground,
    async subscribe() { return () => undefined; },
    async notify() { notifyCount += 1; },
    subscribeForeground(handler) { foregroundHandler = handler; return () => undefined; }
  };

  function WriterProbe() {
    writerResult = useOperationHistoryReadState(idsByTab, true, writerEnvironment);
    return null;
  }

  try {
    await act(async () => {
      secondRoot.render(<WriterProbe />);
      await flushEffects();
    });
    assert.equal(writerResult?.unreadCounts.problems, 1);
    foreground = true;
    await act(async () => {
      foregroundHandler?.();
      await flushEffects();
    });
    const persisted = JSON.parse(stored) as OperationHistoryReadState;
    assert.deepEqual(persisted.seenIdsByTab.problems, ["problem-1"]);
    assert.deepEqual(persisted.seenIdsByTab.completed, ["done-1"]);
    assert.equal(writerResult?.unreadCounts.problems, 0);
    assert.equal(notifyCount, 1);
  } finally {
    await act(async () => secondRoot.unmount());
    secondContainer.remove();
  }

  const mainContainer = document.createElement("div");
  const childContainer = document.createElement("div");
  document.body.append(mainContainer, childContainer);
  const mainRoot = ReactDOM.createRoot(mainContainer);
  const childRoot = ReactDOM.createRoot(childContainer);
  const syncHandlers = new Set<() => void>();
  stored = JSON.stringify(createEmptyOperationHistoryReadState("shared-epoch"));
  const sharedStorage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; }
  };
  const sharedEnvironment = (foregroundValue: boolean): OperationHistoryReadEnvironment => ({
    storage: sharedStorage,
    createEpoch: () => "shared-epoch",
    isForeground: () => foregroundValue,
    async subscribe(handler) { syncHandlers.add(handler); return () => { syncHandlers.delete(handler); }; },
    async notify() { syncHandlers.forEach((handler) => handler()); },
    subscribeForeground() { return () => undefined; }
  });
  let mainResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  let childResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  const mainEnvironment = sharedEnvironment(false);
  function MainProbe() {
    mainResult = useOperationHistoryReadState(idsByTab, false, mainEnvironment);
    return null;
  }
  const childEnvironment = sharedEnvironment(true);
  function ChildProbe() {
    childResult = useOperationHistoryReadState(idsByTab, true, childEnvironment);
    return null;
  }
  try {
    await act(async () => {
      mainRoot.render(<MainProbe />);
      childRoot.render(<ChildProbe />);
      await flushEffects();
    });
    assert.equal(mainResult?.unreadCounts.problems, 1);
    await act(async () => {
      childResult?.selectTab("problems");
      await flushEffects();
    });
    assert.equal(childResult?.unreadCounts.problems, 0);
    assert.equal(mainResult?.unreadCounts.problems, 0);
  } finally {
    await act(async () => {
      mainRoot.unmount();
      childRoot.unmount();
    });
    mainContainer.remove();
    childContainer.remove();
  }

  const delayedContainer = document.createElement("div");
  document.body.appendChild(delayedContainer);
  const delayedRoot = ReactDOM.createRoot(delayedContainer);
  let resolveDelayedSubscribe: ((dispose: () => void) => void) | undefined;
  let delayedWriteCount = 0;
  let delayedResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  stored = JSON.stringify({
    ...createEmptyOperationHistoryReadState("canonical-epoch"),
    revision: 7,
    seenIdsByTab: {
      ...createEmptyOperationHistoryReadState("canonical-epoch").seenIdsByTab,
      history: ["history-1"]
    }
  } satisfies OperationHistoryReadState);
  const delayedEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem: () => stored,
      setItem: (_key, value) => {
        delayedWriteCount += 1;
        stored = value;
      }
    },
    createEpoch: () => "must-not-replace-canonical-epoch",
    isForeground: () => true,
    subscribe() {
      return new Promise((resolve) => { resolveDelayedSubscribe = resolve; });
    },
    async notify() {},
    subscribeForeground() { return () => undefined; }
  };

  function DelayedProbe() {
    delayedResult = useOperationHistoryReadState(idsByTab, true, delayedEnvironment);
    return null;
  }

  try {
    await act(async () => {
      delayedRoot.render(<DelayedProbe />);
      await flushEffects();
    });
    assert.equal(delayedResult?.ready, false);
    await act(async () => {
      delayedResult?.selectTab("problems");
      delayedResult?.selectTab("completed");
      await flushEffects();
    });
    assert.equal(delayedResult?.readState.selectedTab, "completed");
    assert.equal(delayedWriteCount, 0);
    assert.equal((JSON.parse(stored) as OperationHistoryReadState).epoch, "canonical-epoch");

    await act(async () => {
      resolveDelayedSubscribe?.(() => undefined);
      await flushEffects();
    });
    const delayedPersisted = JSON.parse(stored) as OperationHistoryReadState;
    assert.equal(delayedResult?.ready, true);
    assert.equal(delayedPersisted.epoch, "canonical-epoch");
    assert.equal(delayedPersisted.revision, 8);
    assert.equal(delayedPersisted.selectedTab, "completed");
    assert.deepEqual(delayedPersisted.seenIdsByTab.problems, ["problem-1"]);
    assert.deepEqual(delayedPersisted.seenIdsByTab.completed, ["done-1"]);
    assert.deepEqual(delayedPersisted.seenIdsByTab.history, ["history-1"]);
  } finally {
    await act(async () => delayedRoot.unmount());
    delayedContainer.remove();
  }

  const normalizedContainer = document.createElement("div");
  document.body.appendChild(normalizedContainer);
  const normalizedRoot = ReactDOM.createRoot(normalizedContainer);
  let normalizedResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  stored = JSON.stringify({
    ...createEmptyOperationHistoryReadState("normalized-epoch"),
    revision: 9,
    selectedTab: "removed-tab",
    seenIdsByTab: {
      ...createEmptyOperationHistoryReadState("normalized-epoch").seenIdsByTab,
      problems: ["problem-1"],
      completed: ["done-1"]
    }
  });
  const normalizedEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem: () => stored,
      setItem: (_key, value) => { stored = value; }
    },
    createEpoch: () => "must-not-recover-valid-fields",
    isForeground: () => false,
    async subscribe() { return () => undefined; },
    async notify() {},
    subscribeForeground() { return () => undefined; }
  };

  function NormalizedProbe() {
    normalizedResult = useOperationHistoryReadState(idsByTab, true, normalizedEnvironment);
    return null;
  }

  try {
    await act(async () => {
      normalizedRoot.render(<NormalizedProbe />);
      await flushEffects();
    });
    const normalizedPersisted = JSON.parse(stored) as OperationHistoryReadState;
    assert.equal(normalizedResult?.readState.epoch, "normalized-epoch");
    assert.equal(normalizedPersisted.revision, 10);
    assert.equal(normalizedPersisted.selectedTab, "running");
    assert.deepEqual(normalizedPersisted.seenIdsByTab.problems, ["problem-1"]);
    assert.deepEqual(normalizedPersisted.seenIdsByTab.completed, ["done-1"]);
  } finally {
    await act(async () => normalizedRoot.unmount());
    normalizedContainer.remove();
  }

  const storageErrorContainer = document.createElement("div");
  document.body.appendChild(storageErrorContainer);
  const storageErrorRoot = ReactDOM.createRoot(storageErrorContainer);
  let storageReadFails = true;
  let storageErrorResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  stored = JSON.stringify({
    ...createEmptyOperationHistoryReadState("storage-recovered-epoch"),
    revision: 3,
    selectedTab: "history"
  } satisfies OperationHistoryReadState);
  const storageErrorEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem() {
        if (storageReadFails) throw new Error("storage unavailable");
        return stored;
      },
      setItem: (_key, value) => { stored = value; }
    },
    createEpoch: () => "temporary-epoch",
    isForeground: () => false,
    async subscribe() { return () => undefined; },
    async notify() {},
    subscribeForeground() { return () => undefined; }
  };

  function StorageErrorProbe() {
    storageErrorResult = useOperationHistoryReadState(idsByTab, false, storageErrorEnvironment);
    return null;
  }

  try {
    await act(async () => {
      storageErrorRoot.render(<StorageErrorProbe />);
      await flushEffects();
    });
    assert.equal(storageErrorResult?.ready, true);
    assert.equal(storageErrorResult?.warning, "\u672a\u80fd\u6301\u4e45\u5316\u672a\u8bfb\u72b6\u6001");
    storageReadFails = false;
    await act(async () => {
      storageErrorResult?.retry();
      await flushEffects();
    });
    assert.equal(storageErrorResult?.warning, null);
    assert.equal(storageErrorResult?.readState.epoch, "storage-recovered-epoch");
    assert.equal(storageErrorResult?.readState.revision, 3);
    assert.equal(storageErrorResult?.readState.selectedTab, "history");
  } finally {
    await act(async () => storageErrorRoot.unmount());
    storageErrorContainer.remove();
  }

  const writeRetryContainer = document.createElement("div");
  document.body.appendChild(writeRetryContainer);
  const writeRetryRoot = ReactDOM.createRoot(writeRetryContainer);
  let storageWriteFails = true;
  let writeRetryResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  stored = JSON.stringify({
    ...createEmptyOperationHistoryReadState("write-retry-epoch"),
    revision: 4
  } satisfies OperationHistoryReadState);
  const writeRetryEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem: () => stored,
      setItem: (_key, value) => {
        if (storageWriteFails) throw new Error("storage quota exceeded");
        stored = value;
      }
    },
    createEpoch: () => "unused-write-retry-epoch",
    isForeground: () => false,
    async subscribe() { return () => undefined; },
    async notify() {},
    subscribeForeground() { return () => undefined; }
  };

  function WriteRetryProbe() {
    writeRetryResult = useOperationHistoryReadState(idsByTab, true, writeRetryEnvironment);
    return null;
  }

  try {
    await act(async () => {
      writeRetryRoot.render(<WriteRetryProbe />);
      await flushEffects();
    });
    await act(async () => {
      writeRetryResult?.selectTab("history");
      await flushEffects();
    });
    assert.equal(writeRetryResult?.readState.selectedTab, "history");
    assert.equal(writeRetryResult?.warning, "\u672a\u80fd\u6301\u4e45\u5316\u672a\u8bfb\u72b6\u6001");
    storageWriteFails = false;
    await act(async () => {
      writeRetryResult?.retry();
      await flushEffects();
    });
    const writeRetryPersisted = JSON.parse(stored) as OperationHistoryReadState;
    assert.equal(writeRetryPersisted.revision, 5);
    assert.equal(writeRetryPersisted.selectedTab, "history");
    assert.equal(writeRetryResult?.warning, null);
  } finally {
    await act(async () => writeRetryRoot.unmount());
    writeRetryContainer.remove();
  }

  const notifyMainContainer = document.createElement("div");
  const notifyWriterContainer = document.createElement("div");
  document.body.append(notifyMainContainer, notifyWriterContainer);
  const notifyMainRoot = ReactDOM.createRoot(notifyMainContainer);
  const notifyWriterRoot = ReactDOM.createRoot(notifyWriterContainer);
  const notifyHandlers = new Set<() => void>();
  let notifyAttempts = 0;
  let notifyMainResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  let notifyWriterResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  stored = JSON.stringify(createEmptyOperationHistoryReadState("notify-retry-epoch"));
  const notifyIds = { ...idsByTab, running: [] };
  const notifyStorage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; }
  };
  const notifyEnvironment = (writerEnvironment: boolean): OperationHistoryReadEnvironment => ({
    storage: notifyStorage,
    createEpoch: () => "notify-retry-epoch",
    isForeground: () => writerEnvironment,
    async subscribe(handler) {
      notifyHandlers.add(handler);
      return () => { notifyHandlers.delete(handler); };
    },
    async notify() {
      notifyAttempts += 1;
      if (notifyAttempts === 1) throw new Error("event bus unavailable");
      notifyHandlers.forEach((handler) => handler());
    },
    subscribeForeground() { return () => undefined; }
  });
  const notifyMainEnvironment = notifyEnvironment(false);

  function NotifyMainProbe() {
    notifyMainResult = useOperationHistoryReadState(notifyIds, false, notifyMainEnvironment);
    return null;
  }
  const notifyWriterEnvironment = notifyEnvironment(true);
  function NotifyWriterProbe() {
    notifyWriterResult = useOperationHistoryReadState(notifyIds, true, notifyWriterEnvironment);
    return null;
  }

  try {
    await act(async () => {
      notifyMainRoot.render(<NotifyMainProbe />);
      notifyWriterRoot.render(<NotifyWriterProbe />);
      await flushEffects();
    });
    await act(async () => {
      notifyWriterResult?.selectTab("problems");
      await flushEffects();
    });
    assert.equal(notifyAttempts, 1);
    assert.equal(notifyWriterResult?.warning, "\u672a\u80fd\u540c\u6b65\u672a\u8bfb\u72b6\u6001");
    assert.equal(notifyMainResult?.unreadCounts.problems, 1);
    await act(async () => {
      notifyWriterResult?.retry();
      await flushEffects();
    });
    assert.equal(notifyAttempts, 2);
    assert.equal(notifyWriterResult?.warning, null);
    assert.equal(notifyMainResult?.unreadCounts.problems, 0);
  } finally {
    await act(async () => {
      notifyMainRoot.unmount();
      notifyWriterRoot.unmount();
    });
    notifyMainContainer.remove();
    notifyWriterContainer.remove();
  }

  const retryContainer = document.createElement("div");
  document.body.appendChild(retryContainer);
  const retryRoot = ReactDOM.createRoot(retryContainer);
  let subscribeAttempts = 0;
  let successfulDisposeCount = 0;
  let retryResult: ReturnType<typeof useOperationHistoryReadState> | undefined;
  const retryEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem: () => stored,
      setItem: (_key, value) => { stored = value; }
    },
    createEpoch: () => "retry-epoch",
    isForeground: () => false,
    async subscribe() {
      subscribeAttempts += 1;
      if (subscribeAttempts === 1) throw new Error("listener unavailable");
      return () => { successfulDisposeCount += 1; };
    },
    async notify() {},
    subscribeForeground() { return () => undefined; }
  };

  function RetryProbe() {
    retryResult = useOperationHistoryReadState(idsByTab, true, retryEnvironment);
    return null;
  }

  try {
    await act(async () => {
      retryRoot.render(<RetryProbe />);
      await flushEffects();
    });
    assert.equal(retryResult?.warning, "\u672a\u80fd\u8ba2\u9605\u672a\u8bfb\u72b6\u6001\u53d8\u66f4");
    await act(async () => {
      retryResult?.selectTab("problems");
      await flushEffects();
    });
    assert.equal(retryResult?.warning, "\u672a\u80fd\u8ba2\u9605\u672a\u8bfb\u72b6\u6001\u53d8\u66f4");
    await act(async () => {
      retryResult?.retry();
      await flushEffects();
    });
    assert.equal(subscribeAttempts, 2);
    assert.equal(retryResult?.warning, null);
  } finally {
    await act(async () => retryRoot.unmount());
    assert.equal(successfulDisposeCount, 1);
    retryContainer.remove();
    dom.window.close();
  }

  console.log("ok - operation history read state reconciles epochs and marks only the foreground tab seen");
})();
