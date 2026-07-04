import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const sourceRoots = ["src", path.join("src-tauri", "src"), "scripts"];
const sourceExtensions = new Set([".ts", ".tsx", ".css", ".rs", ".mjs"]);
const ignoredPathSegments = new Set([
  "node_modules",
  "dist",
  "target",
  ".test-build",
  ".build-ts"
]);

export const lineBudgets = {
  reactComponent: {
    target: 500,
    max: 800,
    description: "React component"
  },
  hookController: {
    target: 600,
    max: 1000,
    description: "hook/controller"
  },
  reducer: {
    target: 800,
    max: 1200,
    description: "reducer/state module"
  },
  rustService: {
    target: 1000,
    max: 1500,
    description: "Rust service module"
  },
  rustDomain: {
    target: 800,
    max: 1200,
    description: "Rust domain/contract module"
  },
  css: {
    target: 800,
    max: 1200,
    description: "CSS module"
  },
  test: {
    target: 1000,
    max: 1800,
    description: "test file"
  },
  script: {
    target: 400,
    max: 800,
    description: "build/test script"
  },
  typescriptModule: {
    target: 800,
    max: 1200,
    description: "TypeScript module"
  }
};

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function hasIgnoredSegment(relativePath) {
  return normalizePath(relativePath)
    .split("/")
    .some((segment) => ignoredPathSegments.has(segment));
}

function isSourceFile(relativePath) {
  return sourceExtensions.has(path.extname(relativePath));
}

async function collectFilesUnder(rootDir, relativeDir) {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (hasIgnoredSegment(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFilesUnder(rootDir, relativePath)));
    } else if (entry.isFile() && isSourceFile(relativePath)) {
      files.push(normalizePath(relativePath));
    }
  }
  return files;
}

export async function collectSourceFiles(rootDir, roots = sourceRoots) {
  const files = [];
  for (const root of roots) {
    files.push(...(await collectFilesUnder(rootDir, root)));
  }
  return files.sort();
}

export function classifySourceFile(relativePath) {
  const normalized = normalizePath(relativePath);
  const extension = path.extname(normalized);
  const basename = path.basename(normalized);

  if (/\.(test|spec)\.(ts|tsx|mjs)$/.test(normalized)) {
    return "test";
  }
  if (extension === ".css") {
    return "css";
  }
  if (extension === ".mjs") {
    return "script";
  }
  if (extension === ".rs" && normalized.startsWith("src-tauri/src/services/")) {
    return "rustService";
  }
  if (extension === ".rs" && normalized.startsWith("src-tauri/src/domain/")) {
    return "rustDomain";
  }
  if (extension === ".tsx") {
    return "reactComponent";
  }
  if (/^use[A-Z].*\.ts$/.test(basename) || /Controller\.ts$/.test(basename)) {
    return "hookController";
  }
  if (/Reducer\.ts$/.test(basename)) {
    return "reducer";
  }
  return "typescriptModule";
}

export function countSourceLines(content) {
  if (content.length === 0) {
    return 0;
  }
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
}

async function readLineCount(rootDir, relativePath) {
  const content = await fs.readFile(path.join(rootDir, relativePath), "utf8");
  return countSourceLines(content);
}

export async function loadBudgetExceptions(rootDir, exceptionPath = ".temp/source-line-budget-exceptions.json") {
  const absolutePath = path.join(rootDir, exceptionPath);
  const content = await fs.readFile(absolutePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!content) {
    return new Map();
  }

  const parsed = JSON.parse(content);
  const exceptions = new Map();
  for (const exception of parsed.exceptions ?? []) {
    if (!exception.path || typeof exception.maxLines !== "number" || !exception.reason) {
      throw new Error(`Invalid line budget exception entry: ${JSON.stringify(exception)}`);
    }
    exceptions.set(normalizePath(exception.path), exception);
  }
  return exceptions;
}

export async function evaluateLineBudgets({
  rootDir = process.cwd(),
  roots = sourceRoots,
  exceptionPath = ".temp/source-line-budget-exceptions.json"
} = {}) {
  const exceptions = await loadBudgetExceptions(rootDir, exceptionPath);
  const files = await collectSourceFiles(rootDir, roots);
  const results = [];
  const warnings = [];
  const failures = [];
  const usedExceptions = new Set();

  for (const relativePath of files) {
    const category = classifySourceFile(relativePath);
    const budget = lineBudgets[category];
    const lines = await readLineCount(rootDir, relativePath);
    const exception = exceptions.get(relativePath);
    const allowedMax = exception?.maxLines ?? budget.max;
    const result = {
      path: relativePath,
      category,
      lines,
      target: budget.target,
      max: allowedMax,
      defaultMax: budget.max,
      exception: exception ?? null
    };
    results.push(result);

    if (exception) {
      usedExceptions.add(relativePath);
    }
    if (lines > allowedMax) {
      failures.push({
        ...result,
        message: exception
          ? `exceeds registered exception max ${allowedMax}`
          : `exceeds max ${budget.max}`
      });
    } else if (lines > budget.target) {
      warnings.push(result);
    }
  }

  for (const exceptionPath of exceptions.keys()) {
    if (!usedExceptions.has(exceptionPath)) {
      failures.push({
        path: exceptionPath,
        category: "exception",
        lines: 0,
        target: 0,
        max: exceptions.get(exceptionPath).maxLines,
        defaultMax: 0,
        exception: exceptions.get(exceptionPath),
        message: "registered exception does not match any source file"
      });
    }
  }

  results.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  warnings.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  failures.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  return { results, warnings, failures };
}

function formatResult(result) {
  const budget = lineBudgets[result.category];
  const category = budget?.description ?? result.category;
  const suffix = result.exception ? " exception" : "";
  return `${result.lines.toString().padStart(5)}  ${result.path}  ${category} target=${result.target} max=${result.max}${suffix}`;
}

export async function runLineBudgetCheck(options = {}) {
  const { warnings, failures } = await evaluateLineBudgets(options);
  if (warnings.length > 0) {
    console.log("Source line budget warnings:");
    for (const warning of warnings) {
      console.log(`  ${formatResult(warning)}`);
    }
  }

  if (failures.length > 0) {
    console.error("Source line budget failures:");
    for (const failure of failures) {
      console.error(`  ${formatResult(failure)}  ${failure.message}`);
    }
    return 1;
  }

  console.log("Source line budget check passed.");
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  process.exitCode = await runLineBudgetCheck();
}
