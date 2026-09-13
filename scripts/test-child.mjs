import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

// 子进程测试引导脚本：注册 CSS stub，加载单个编译后的测试文件，
// 等待其导出的完成 Promise。每个测试文件独立进程，避免 React act
// 作用域与全局 DOM 状态跨文件泄漏。
const require = createRequire(import.meta.url);
require.extensions[".css"] = (module) => {
  module.exports = {};
};

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/test-child.mjs <compiled-test-file>");
  process.exit(1);
}

const modulePath = path.resolve(target);
// 脚本类测试（scripts/*.test.mjs）是原生 ESM 且可能包含顶层 await，
// 统一走动态 import；编译产物 CJS 测试也可以被 import。
const loaded = await import(pathToFileURL(modulePath).href);
const pending = Object.values(loaded).filter((value) => value && typeof value.then === "function");
if (pending.length > 0) {
  await Promise.all(pending);
}
