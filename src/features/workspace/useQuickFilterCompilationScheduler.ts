import { useEffect, useRef, type Dispatch } from "react";
import { compileQuickFilter } from "./quickFilterMatcher";
import { planQuickFilterCompilations } from "./quickFilterState";
import { QUICK_FILTER_REGEX_DEBOUNCE_MS } from "./quickFilterTypes";
import type { WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceState } from "./types";

/**
 * 快速过滤的编译调度（规格 §6.6 / D24）。
 *
 * 唯一的调度规则：路径/语法/非 regex 文本变化立即编译，regex 文本变化防抖 100ms。
 * 列表只跟随 `appliedText`，因此失败态与防抖窗口都不会造成闪烁。
 *
 * **作用域是所有面板中全部目录类标签页的路径**，而不只是激活面板的路径：
 * 语法是会话全局的，切到 regex 会一次性清空所有路径的 `appliedText`，
 * 只重算激活面板会让其它显示中面板"失去焦点即取消过滤"（D24 ② 禁止）。
 * 每个路径各持一个防抖定时器，互不影响。
 */
export function useQuickFilterCompilationScheduler({
  state,
  dispatch
}: {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
}) {
  /** 已派发编译的路径 → 指纹，避免重复派发同一个编译。 */
  const compiledRef = useRef<Map<string, string>>(new Map());
  const { tasks, settled, liveKeys } = planQuickFilterCompilations(state);

  // 文本是任务的输入而非身份；用拼接键做依赖，避免每次 render 都重排定时器。
  const planKey = tasks.map((task) => `${task.key}\u0001${task.fingerprint}\u0001${task.path}`).join("\u0002");
  const settledKey = settled.join("\u0002");
  const liveKey = liveKeys.join("\u0002");
  const syntax = state.quickFilter.syntax;

  useEffect(() => {
    const compiled = compiledRef.current;
    // 淘汰已离场路径的指纹，避免长会话下无界增长。
    const live = new Set(liveKeys);
    for (const key of [...compiled.keys()]) {
      if (!live.has(key)) compiled.delete(key);
    }
    for (const key of settled) {
      // 空文本或已生效时清掉指纹，使日后重新编辑能够再次派发（§5.7 规则 5）。
      compiled.delete(key);
    }
    if (tasks.length === 0) return;

    const pending = tasks.filter((task) => compiled.get(task.key) !== task.fingerprint);
    if (pending.length === 0) return;
    const run = () => {
      for (const task of pending) {
        const result = compileQuickFilter(task.text, syntax, state.quickFilter.mode);
        // 失败时也要记录指纹，否则同一个坏模式会在每次 render 时反复编译。
        compiled.set(task.key, task.fingerprint);
        dispatch({
          type: "quickFilterApplied",
          payload: {
            path: task.path,
            text: task.text,
            ok: result.ok,
            message: result.ok ? null : result.message
          }
        });
      }
    };
    if (syntax !== "regex") {
      run();
      return;
    }
    const timer = setTimeout(run, QUICK_FILTER_REGEX_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // planKey/settledKey/liveKey 已完整编码 tasks/settled/liveKeys 内容与顺序。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, settledKey, liveKey, syntax, state.quickFilter.mode, dispatch]);
}
