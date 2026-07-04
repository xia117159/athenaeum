/**
 * 开发环境调试日志工具
 * 在生产构建中，console.log 仍会执行但可以通过这个工具统一控制
 */

// 检测是否为开发环境
const isDev = process.env.NODE_ENV === 'development';

/**
 * 开发环境专用日志
 * 在生产环境中不会输出
 */
export function devLog(...args: unknown[]) {
  if (isDev) {
    console.log(...args);
  }
}

/**
 * 开发环境专用警告
 */
export function devWarn(...args: unknown[]) {
  if (isDev) {
    console.warn(...args);
  }
}

/**
 * 开发环境专用错误（生产环境也会输出）
 */
export function devError(...args: unknown[]) {
  console.error(...args);
}
