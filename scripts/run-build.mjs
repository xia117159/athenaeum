import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { rollup } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";

const rootDir = process.cwd();
const srcDir = path.join(rootDir, "src");
const tempDir = path.join(rootDir, ".build-ts");
const distDir = path.join(rootDir, "dist");
const assetsDir = path.join(distDir, "assets");

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => rootDir,
  getNewLine: () => "\n"
};

async function ensureCleanDir(dir) {
  await fs.rm(dir, { force: true, recursive: true }).catch(() => undefined);
  await fs.mkdir(dir, { recursive: true });
}

function compileTypeScript() {
  const configPath = path.join(rootDir, "tsconfig.app.json");
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

function createCssPlugin(collectedCss) {
  return {
    name: "local-css-collector",
    resolveId(source, importer) {
      if (!source.endsWith(".css")) {
        return null;
      }

      const baseDir = importer ? path.dirname(importer) : tempDir;
      const candidate = path.resolve(baseDir, source);
      if (candidate.startsWith(tempDir)) {
        return path.join(srcDir, path.relative(tempDir, candidate));
      }
      return candidate;
    },
    load(id) {
      if (!id.endsWith(".css")) {
        return null;
      }

      collectedCss.add(id);
      return "export default undefined;";
    }
  };
}

async function writeCssBundle(collectedCss) {
  const cssParts = [];
  for (const filePath of [...collectedCss].sort()) {
    cssParts.push(await fs.readFile(filePath, "utf8"));
  }
  await fs.writeFile(path.join(assetsDir, "app.css"), cssParts.join("\n\n"));
}

async function writeHtml() {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WenjianGuanliqi</title>
    <link rel="stylesheet" href="./assets/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./assets/app.js"></script>
  </body>
</html>
`;
  await fs.writeFile(path.join(distDir, "index.html"), html);
}

export default async function runBuild() {
  await ensureCleanDir(tempDir);
  await ensureCleanDir(distDir);
  await fs.mkdir(assetsDir, { recursive: true });

  compileTypeScript();

  const collectedCss = new Set();
  const bundle = await rollup({
    input: path.join(tempDir, "main.js"),
    plugins: [
      createCssPlugin(collectedCss),
      nodeResolve({
        browser: true,
        exportConditions: ["default", "browser", "module", "import"]
      }),
      commonjs(),
      replace({
        "process.env.NODE_ENV": JSON.stringify("production"),
        preventAssignment: true
      })
    ]
  });

  await bundle.write({
    file: path.join(assetsDir, "app.js"),
    format: "esm"
  });
  await bundle.close();
  await writeCssBundle(collectedCss);
  await writeHtml();
}
