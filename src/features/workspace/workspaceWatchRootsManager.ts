import type { WorkspaceGateway } from "./workspaceGateway";
import type { WorkspaceState, WorkspaceWatchRootsRequest } from "./types";

/**
 * WatchRootsManager - 管理文件监视根路径的独立服务
 *
 * 职责：
 * - 从 WorkspaceState 计算需要监视的路径
 * - 去重和防抖，只在真正变化时更新
 * - 完全独立于 React 生命周期
 * - 可测试、可观测
 *
 * 设计原则：
 * - 单一职责：只管理 watch roots，不涉及其他业务逻辑
 * - 依赖倒置：依赖 WorkspaceGateway 接口，不依赖具体实现
 * - 开闭原则：可扩展（添加新的计算策略），无需修改已有代码
 */
export class WatchRootsManager {
  private currentRoots: WorkspaceWatchRootsRequest = {
    directoryPaths: [],
    navigationParentPaths: [],
    gitSentinelPaths: []
  };
  private updateCount = 0;
  private lastUpdateTime = 0;
  private history: Array<{ timestamp: number; roots: WorkspaceWatchRootsRequest }> = [];
  private disposed = false;

  constructor(
    private readonly gateway: WorkspaceGateway,
    private readonly options: {
      maxHistorySize?: number;
      enableLogging?: boolean;
    } = {}
  ) {
    this.log("WatchRootsManager created");
  }

  /**
   * 更新 watch roots
   * 内部会自动去重，只在真正变化时调用 gateway
   */
  async update(roots: WorkspaceWatchRootsRequest): Promise<void> {
    if (this.disposed) {
      this.log("Manager disposed, ignoring update");
      return;
    }

    const normalized = this.normalizeRoots(roots);

    if (this.areRootsEqual(this.currentRoots, normalized)) {
      this.log("Roots unchanged, skipping update", { roots: normalized });
      return;
    }

    this.log("Roots changed, updating", {
      old: this.currentRoots,
      new: normalized
    });

    this.currentRoots = normalized;
    this.updateCount++;
    this.lastUpdateTime = Date.now();

    // 记录历史（用于调试）
    this.addToHistory(normalized);

    try {
      await this.gateway.setWatchRoots(normalized);
      this.log("Gateway update succeeded");
    } catch (error) {
      this.log("Gateway update failed", { error });
      throw error;
    }
  }

  /**
   * 从 WorkspaceState 计算并更新 watch roots
   */
  async updateFromState(selector: (state: WorkspaceState) => WorkspaceWatchRootsRequest, state: WorkspaceState): Promise<void> {
    const roots = selector(state);
    await this.update(roots);
  }

  /**
   * 获取当前的 watch roots
   */
  getCurrentRoots(): Readonly<WorkspaceWatchRootsRequest> {
    return { ...this.currentRoots };
  }

  /**
   * 获取调试信息
   */
  getDebugState() {
    return {
      currentRoots: this.getCurrentRoots(),
      updateCount: this.updateCount,
      lastUpdateTime: this.lastUpdateTime,
      history: [...this.history],
      disposed: this.disposed
    };
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.log("Disposing manager");
    this.disposed = true;

    // 清空 watch roots
    try {
      await this.gateway.setWatchRoots({
        directoryPaths: [],
        navigationParentPaths: [],
        gitSentinelPaths: []
      });
      this.log("Watch roots cleared on dispose");
    } catch (error) {
      this.log("Failed to clear watch roots on dispose", { error });
    }

    this.history = [];
  }

  // ===== 私有方法 =====

  private normalizeRoots(roots: WorkspaceWatchRootsRequest): WorkspaceWatchRootsRequest {
    return {
      directoryPaths: this.dedupeAndSort(roots.directoryPaths),
      navigationParentPaths: this.dedupeAndSort(roots.navigationParentPaths),
      gitSentinelPaths: this.dedupeAndSort(roots.gitSentinelPaths ?? [])
    };
  }

  private dedupeAndSort(paths: string[]): string[] {
    const unique = Array.from(new Set(paths.filter(Boolean)));
    return unique.sort((a, b) => a.localeCompare(b));
  }

  private areRootsEqual(left: WorkspaceWatchRootsRequest, right: WorkspaceWatchRootsRequest): boolean {
    return (
      this.areArraysEqual(left.directoryPaths, right.directoryPaths) &&
      this.areArraysEqual(left.navigationParentPaths, right.navigationParentPaths) &&
      this.areArraysEqual(left.gitSentinelPaths ?? [], right.gitSentinelPaths ?? [])
    );
  }

  private areArraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) {
        return false;
      }
    }
    return true;
  }

  private addToHistory(roots: WorkspaceWatchRootsRequest): void {
    const maxSize = this.options.maxHistorySize ?? 50;
    this.history.push({
      timestamp: Date.now(),
      roots: { ...roots }
    });

    // 保持历史记录大小限制
    if (this.history.length > maxSize) {
      this.history = this.history.slice(-maxSize);
    }
  }

  private log(message: string, data?: unknown): void {
    if (this.options.enableLogging !== false) {
      if (data) {
        console.log(`[WatchRootsManager] ${message}`, data);
      } else {
        console.log(`[WatchRootsManager] ${message}`);
      }
    }
  }
}

/**
 * 创建一个带有状态选择器的便捷包装
 */
export function createWatchRootsManager(
  gateway: WorkspaceGateway,
  options?: {
    maxHistorySize?: number;
    enableLogging?: boolean;
  }
): WatchRootsManager {
  return new WatchRootsManager(gateway, options);
}
