import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { OperationClearScope } from "../../app/types";
import { createWorkspaceGateway, type WorkspaceGateway } from "./workspaceGateway";
import { createOperationWorkspaceState, reduceOperationWorkspaceState } from "./operationState";
import { subscribeOperationEvents } from "./operationSubscriptions";

const defaultGateway = createWorkspaceGateway();

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

export function useOperationHistoryController(gateway: WorkspaceGateway = defaultGateway) {
  const [operations, dispatch] = useReducer(reduceOperationWorkspaceState, undefined, createOperationWorkspaceState);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearNotice, setClearNotice] = useState<string | null>(null);
  const [cleanupWarnings, setCleanupWarnings] = useState<string[]>([]);
  const [retryRevision, setRetryRevision] = useState(0);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set());
  const [pendingRecordIds, setPendingRecordIds] = useState<Set<string>>(() => new Set());
  const [undoLatestPending, setUndoLatestPending] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [confirmation, setConfirmation] = useState<{ scope: OperationClearScope; count: number } | null>(null);
  const mountedRef = useRef(true);
  const mutationLockRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let dispose: () => void = () => undefined;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      const registeredDispose = await subscribeOperationEvents(gateway, {
        task: (event) => {
          if (!disposed) dispatch({ type: "taskEvent", payload: event.snapshot });
        },
        history: (event) => {
          if (!disposed) dispatch({ type: "historyEvent", payload: event });
        },
        cleared: (event) => {
          if (!disposed) dispatch({ type: "recordsCleared", payload: event });
        }
      });
      if (disposed) {
        registeredDispose();
        return;
      }
      dispose = registeredDispose;
      const [tasks, history] = await Promise.all([gateway.listOperationTasks(), gateway.listOperationHistory()]);
      if (disposed) return;
      dispatch({ type: "tasksSnapshot", payload: tasks });
      dispatch({ type: "historySnapshot", payload: history });
      setLoading(false);
    })().catch((error) => {
      if (!disposed) {
        dispose();
        dispose = () => undefined;
        setLoading(false);
        setLoadError(errorText(error, "\u65e0\u6cd5\u52a0\u8f7d\u64cd\u4f5c\u5386\u53f2"));
      }
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [gateway, retryRevision]);

  const cancelTask = useCallback(async (taskId: string) => {
    if (mutationLockRef.current) return;
    mutationLockRef.current = true;
    setPendingTaskIds((current) => new Set(current).add(taskId));
    setActionError(null);
    try {
      const task = await gateway.cancelOperation(taskId);
      if (mountedRef.current) dispatch({ type: "taskEvent", payload: task });
    } catch (error) {
      if (mountedRef.current) setActionError(errorText(error, "\u53d6\u6d88\u64cd\u4f5c\u5931\u8d25"));
    } finally {
      mutationLockRef.current = false;
      if (mountedRef.current) setPendingTaskIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  }, [gateway]);

  const undoRecord = useCallback(async (recordId: string) => {
    if (mutationLockRef.current) return;
    mutationLockRef.current = true;
    setPendingRecordIds((current) => new Set(current).add(recordId));
    setActionError(null);
    try {
      const task = await gateway.undoOperation(recordId);
      if (mountedRef.current) dispatch({ type: "taskEvent", payload: task });
    } catch (error) {
      if (mountedRef.current) setActionError(errorText(error, "\u64a4\u9500\u64cd\u4f5c\u5931\u8d25"));
    } finally {
      mutationLockRef.current = false;
      if (mountedRef.current) setPendingRecordIds((current) => {
        const next = new Set(current);
        next.delete(recordId);
        return next;
      });
    }
  }, [gateway]);

  const undoLatest = useCallback(async () => {
    if (mutationLockRef.current) return;
    mutationLockRef.current = true;
    setUndoLatestPending(true);
    setActionError(null);
    try {
      const task = await gateway.undoLatestOperation();
      if (mountedRef.current) dispatch({ type: "taskEvent", payload: task });
    } catch (error) {
      if (mountedRef.current) setActionError(errorText(error, "\u64a4\u9500\u6700\u8fd1\u64cd\u4f5c\u5931\u8d25"));
    } finally {
      mutationLockRef.current = false;
      if (mountedRef.current) setUndoLatestPending(false);
    }
  }, [gateway]);

  const clear = useCallback(async (scope: OperationClearScope, confirmUndoLoss = false) => {
    if (mutationLockRef.current) return undefined;
    mutationLockRef.current = true;
    setClearPending(true);
    setActionError(null);
    setClearNotice(null);
    setCleanupWarnings([]);
    try {
      const outcome = await gateway.clearOperationRecords({ scope, confirmUndoLoss });
      if (!mountedRef.current) return undefined;
      if (outcome.status === "confirmationRequired") {
        setConfirmation({ scope, count: outcome.eligibleUndoableCount });
      } else {
        dispatch({ type: "recordsCleared", payload: outcome });
        setConfirmation(null);
        setCleanupWarnings(outcome.cleanupWarnings);
        const protectedCount = scope === "completed" ? 0 : outcome.protectedRecordIds.length;
        if (protectedCount > 0) {
          setClearNotice(`\u5df2\u4fdd\u7559 ${protectedCount} \u6761\u6b63\u5728\u5904\u7406\u7684\u8bb0\u5f55`);
        } else if (outcome.removedTaskIds.length === 0 && outcome.removedRecordIds.length === 0) {
          setClearNotice("\u6ca1\u6709\u53ef\u6e05\u7406\u7684\u8bb0\u5f55");
        }
      }
      return outcome;
    } catch (error) {
      if (mountedRef.current) setActionError(errorText(error, "\u6e05\u7406\u64cd\u4f5c\u8bb0\u5f55\u5931\u8d25"));
      return undefined;
    } finally {
      mutationLockRef.current = false;
      if (mountedRef.current) setClearPending(false);
    }
  }, [gateway]);

  const hasUndoable = useMemo(
    () => operations.history.some((record) => record.status === "undoable"),
    [operations.history]
  );
  const mutationPending = clearPending || undoLatestPending || confirmation !== null
    || pendingTaskIds.size > 0 || pendingRecordIds.size > 0;

  return {
    operations,
    loading,
    loadError,
    actionError,
    clearNotice,
    cleanupWarnings,
    pendingTaskIds,
    pendingRecordIds,
    undoLatestPending,
    clearPending,
    confirmation,
    hasUndoable,
    mutationPending,
    retry: () => setRetryRevision((value) => value + 1),
    dismissConfirmation: () => setConfirmation(null),
    cancelTask,
    undoRecord,
    undoLatest,
    clear
  };
}
