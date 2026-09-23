import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import ts from "typescript";
import { buildQuickFilterWorker } from "./run-build.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sfm-filter-worker-"));
let worker;
try {
  const output = path.join(directory, "quickFilter.worker.mjs");
  await buildQuickFilterWorker(path.resolve("src/features/workspace/quickFilter.worker.ts"), output, [{
    name: "test-typescript-loader",
    async load(id) {
      if (!id.endsWith(".ts")) return null;
      return ts.transpileModule(await fs.readFile(id, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
      }).outputText;
    }
  }]);
  worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.self = { postMessage: data => parentPort.postMessage(data) };
    import(workerData).then(() => {
      parentPort.on('message', data => self.onmessage({ data }));
      parentPort.postMessage('ready');
    });`, { eval: true, workerData: pathToFileURL(output).href });
  const timeout = AbortSignal.timeout(15000);
  assert.deepEqual(await once(worker, "message", { signal: timeout }), ["ready"]);
  async function evaluate(id, request) {
    const reply = once(worker, "message", { signal: timeout });
    worker.postMessage({ id, request: { includeRanges: true, ...request } });
    const [data] = await reply;
    assert.equal(data.id, id);
    assert.equal(data.failure, undefined);
    return data.result;
  }
  const names = Array.from({ length: 10 }, (_, i) => "a".repeat(235) + i + "x");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  let result;
  try { result = await evaluate(1, { text: "(a{1,20}){1,20}$|x", fallbackText: "", names }); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0, "the event loop stays live while the Worker evaluates expensive patterns");
  assert.deepEqual(result.evaluation.matches[names[0]].ranges, [{ start: 236, end: 237 }]);
  const emoji = await evaluate(2, { text: "^.$", fallbackText: "", names: ["😀", "ab", "__proto__"] });
  assert.deepEqual(emoji.evaluation.matches["😀"].ranges, [{ start: 0, end: 2 }]);
  const invalid = await evaluate(3, { text: "(", fallbackText: "^.$", names: ["😀"] });
  assert.ok(invalid.error);
  assert.equal(invalid.evaluation.matches["😀"].matched, true);
  console.log("ok - production Worker bundle runs standalone, preserves Unicode/fallback and leaves the main loop responsive");
} finally {
  await worker?.terminate();
  await fs.rm(directory, { recursive: true, force: true });
}
