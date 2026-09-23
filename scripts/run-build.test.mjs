import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rollup } from "rollup";
import { buildQuickFilterWorker, copyStaticAssets, onBuildWarning, readCssWithImports } from "./run-build.mjs";
import ts from "typescript";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { once } from "node:events";

function assertTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

await assertTest("readCssWithImports inlines relative CSS imports in dependency order", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfm-css-imports-"));
  try {
    await fs.mkdir(path.join(tempDir, "nested"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "entry.css"),
      '@import "./base.css";\n.entry { color: red; }\n@import "./nested/more.css";\n'
    );
    await fs.writeFile(path.join(tempDir, "base.css"), ".base { color: blue; }\n");
    await fs.writeFile(path.join(tempDir, "nested", "more.css"), ".more { color: green; }\n");

    const css = await readCssWithImports(path.join(tempDir, "entry.css"));

    assert.equal(css.includes("@import"), false);
    assert.ok(css.indexOf(".base") < css.indexOf(".entry"));
    assert.ok(css.indexOf(".entry") < css.indexOf(".more"));
    assert.match(css, /\.base\s*\{/);
    assert.match(css, /\.entry\s*\{/);
    assert.match(css, /\.more\s*\{/);
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
});

await assertTest("copyStaticAssets includes the about window icon in dist", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfm-static-assets-"));
  try {
    const sourceDir = path.join(tempDir, "icons");
    const outputDir = path.join(tempDir, "dist");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "128x128.png"), "icon-bytes");

    await copyStaticAssets({ sourceDir, outputDir });

    assert.equal(await fs.readFile(path.join(outputDir, "128x128.png"), "utf8"), "icon-bytes");
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
});

await assertTest("buildQuickFilterWorker emits a standalone worker with the matching evaluator", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfm-filter-worker-build-"));
  let worker;
  try {
    const output = path.join(tempDir, "filter.mjs");
    const input = path.resolve("src/features/workspace/quickFilter.worker.ts");
    await buildQuickFilterWorker(input, output, [{
      name: "test-typescript-loader",
      async load(id) {
        if (!id.endsWith(".ts")) return null;
        return ts.transpileModule(await fs.readFile(id, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
        }).outputText;
      }
    }]);
    const url = pathToFileURL(output).href;
    worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      globalThis.self = { postMessage: data => parentPort.postMessage(data) };
      import(workerData).then(() => {
        parentPort.on('message', data => self.onmessage({ data }));
        parentPort.postMessage('ready');
      });`, { eval: true, workerData: url });
    const timeout = AbortSignal.timeout(10000);
    assert.deepEqual(await once(worker, "message", { signal: timeout }), ["ready"]);
    const result = once(worker, "message", { signal: timeout });
    worker.postMessage({ id: 1, request: { text: "^.$", fallbackText: "", names: ["😀"], includeRanges: true } });
    const [reply] = await result;
    assert.equal(reply.id, 1);
    assert.deepEqual(reply.result.evaluation.matches["😀"].ranges, [{ start: 0, end: 2 }]);
    assert.match(await fs.readFile(output, "utf8"), /RE2JS|re2js/i);
  } finally {
    await worker?.terminate();
    await fs.rm(tempDir, { force: true, recursive: true });
  }
});

async function bundleModule(id, code) {
  const warnings = [];
  const bundle = await rollup({
    input: id,
    plugins: [{
      name: "warning-fixture",
      resolveId: source => source === id ? id : null,
      load: source => source === id ? code : null
    }],
    onwarn: warning => onBuildWarning(warning, forwarded => {
      warnings.push(forwarded);
    })
  });
  try {
    const { output } = await bundle.generate({ format: "esm" });
    const module = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`);
    assert.equal(module.value, 42, "warning handling preserves the generated module's exports");
    return warnings;
  } finally {
    await bundle.close();
  }
}

await assertTest("client builds omit only third-party use-client directive warnings", async () => {
  for (const id of [
    "/project/node_modules/example/client.js",
    "C:\\project\\node_modules\\example\\client.js"
  ]) {
    const warnings = await bundleModule(id, '"use client"; export const value = 42;');
    assert.equal(warnings.length, 0, `third-party use-client noise: ${id}`);
  }
});

await assertTest("client builds retain source directives, other directives and actionable warnings", async () => {
  for (const [id, code, expected] of [
    ["/project/src/client.js", '"use client"; export const value = 42;', "MODULE_LEVEL_DIRECTIVE"],
    ["/project/not_node_modules/example/client.js", '"use client"; export const value = 42;', "MODULE_LEVEL_DIRECTIVE"],
    ["/project/node_modules/example/server.js", '"use server"; export const value = 42;', "MODULE_LEVEL_DIRECTIVE"],
    ["/project/node_modules/example/eval.js", 'export const value = eval("42");', "EVAL"]
  ]) {
    const warnings = await bundleModule(id, code);
    assert.equal(warnings.length, 1, `diagnostic must remain visible: ${id}`);
    assert.equal(warnings[0].code, expected);
  }
});
