/**
 * 计时断言的稳健采样（规格评审 SR1 风险 2）。
 *
 * 背景：`npm test` 会**并行**跑 180+ 个测试文件，单次 `Date.now()` 采样容易被调度抖动污染。
 * 而本引擎的单次调用实际只需微秒级 —— 一条 50ms 预算的断言曾因此在全量跑时偶发变红
 * （单独跑该文件则稳定通过）。用"一次采样 + `Date.now()`"做性能守卫，红绿取决于机器负载，
 * 属于**不可靠的守卫**。
 *
 * 因此统一改为：**预热**若干次（让 JIT 与惰性折叠表就绪）→ 取多次采样的**中位数**。
 * 中位数对偶发的调度尖峰不敏感，而灾难性回溯的耗时是**秒级**的，
 * 与线性实现的微秒级相差 4 个数量级，因此该统计量不会掩盖真实回归
 * （§3.1 的 B-1 实测：`(a{1,20}){1,20}$` 在 255 字符名称上 135,352ms）。
 */
export function medianDurationMs(run: () => void, samples = 5, warmup = 2): number {
  for (let index = 0; index < warmup; index += 1) run();
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    run();
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return durations[Math.floor(durations.length / 2)];
}

/** 断言 `run` 的中位耗时不超 `budgetMs`；失败信息带上实际中位数与采样数。 */
export function assertMedianDurationWithin(run: () => void, budgetMs: number, label: string, samples = 5): void {
  const median = medianDurationMs(run, samples);
  if (median >= budgetMs) {
    throw new Error(`${label}: median ${median.toFixed(2)}ms over ${samples} samples exceeds ${budgetMs}ms`);
  }
}
