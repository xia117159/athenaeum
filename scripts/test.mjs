import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const rootDir = process.cwd();
const srcDir = path.join(rootDir, "src");
const buildDir = path.join(rootDir, ".test-build");

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => rootDir,
  getNewLine: () => "\n"
};

require.extensions[".css"] = (module) => {
  module.exports = {};
};

function compileTests() {
  const configPath = path.join(rootDir, "tsconfig.test.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.formatDiagnostic(read.error, formatHost));
  }

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, rootDir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const emitResult = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  }
}

async function collectTests(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectTests(fullPath)));
    } else if (entry.name.endsWith(".test.js")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function copyCssModules(relativeDir = "") {
  const sourceDir = path.join(srcDir, relativeDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await copyCssModules(relativePath);
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      const outputPath = path.join(buildDir, relativePath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.copyFile(path.join(srcDir, relativePath), outputPath);
    }
  }
}

async function collectScriptTests(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectScriptTests(fullPath)));
    } else if (entry.name.endsWith(".test.mjs")) {
      results.push(fullPath);
    }
  }
  return results;
}

await fs.rm(buildDir, { force: true, recursive: true }).catch(() => undefined);
compileTests();
await copyCssModules();
await fs.writeFile(path.join(buildDir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));
const tests = [...(await collectTests(buildDir)), ...(await collectScriptTests(path.join(rootDir, "scripts")))];

if (tests.length === 0) {
  console.log("No tests found");
  process.exit(0);
}

for (const testFile of tests) {
  console.log(`Running ${path.relative(rootDir, testFile)}`);
  const module = await import(pathToFileURL(testFile).href);
  const pending = Object.values(module).filter((value) => value && typeof value.then === "function");
  if (pending.length > 0) {
    await Promise.all(pending);
  }
}
