import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifySourceFile,
  countSourceLines,
  evaluateLineBudgets
} from "./source-line-budget.mjs";

function assertTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

async function writeLines(filePath, count) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Array.from({ length: count }, (_, index) => `line ${index}`).join("\n"));
}

await assertTest("classifySourceFile applies architecture line budget categories", () => {
  assert.equal(classifySourceFile("src/features/workspace/FileListing.tsx"), "reactComponent");
  assert.equal(classifySourceFile("src/features/workspace/useWorkspaceController.ts"), "hookController");
  assert.equal(classifySourceFile("src/features/workspace/workspaceReducer.ts"), "reducer");
  assert.equal(classifySourceFile("src-tauri/src/services/remote_service.rs"), "rustService");
  assert.equal(classifySourceFile("src-tauri/src/domain/models.rs"), "rustDomain");
  assert.equal(classifySourceFile("src/features/workspace/workspace.css"), "css");
  assert.equal(classifySourceFile("scripts/build.mjs"), "script");
  assert.equal(classifySourceFile("src/features/workspace/FileListing.test.tsx"), "test");
});

await assertTest("countSourceLines handles empty files and final newlines", () => {
  assert.equal(countSourceLines(""), 0);
  assert.equal(countSourceLines("one"), 1);
  assert.equal(countSourceLines("one\n"), 2);
  assert.equal(countSourceLines("one\r\ntwo"), 2);
});

await assertTest("evaluateLineBudgets fails files that exceed max without an exception", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfm-line-budget-"));
  try {
    await writeLines(path.join(tempDir, "src", "features", "workspace", "HugeView.tsx"), 801);
    const result = await evaluateLineBudgets({
      rootDir: tempDir,
      roots: ["src"],
      exceptionPath: ".temp/missing.json"
    });

    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].path, "src/features/workspace/HugeView.tsx");
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
});

await assertTest("evaluateLineBudgets allows registered exceptions only up to their frozen max", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfm-line-budget-exception-"));
  try {
    await writeLines(path.join(tempDir, "src", "features", "workspace", "HugeView.tsx"), 850);
    await fs.mkdir(path.join(tempDir, ".temp"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, ".temp", "exceptions.json"),
      JSON.stringify(
        {
          exceptions: [
            {
              path: "src/features/workspace/HugeView.tsx",
              maxLines: 850,
              reason: "temporary decomposition checkpoint"
            }
          ]
        },
        null,
        2
      )
    );

    let result = await evaluateLineBudgets({
      rootDir: tempDir,
      roots: ["src"],
      exceptionPath: ".temp/exceptions.json"
    });
    assert.equal(result.failures.length, 0);

    await writeLines(path.join(tempDir, "src", "features", "workspace", "HugeView.tsx"), 851);
    result = await evaluateLineBudgets({
      rootDir: tempDir,
      roots: ["src"],
      exceptionPath: ".temp/exceptions.json"
    });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /exception max/);
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
});

await assertTest("current repository source line budget passes with registered exceptions", async () => {
  const result = await evaluateLineBudgets();
  assert.deepEqual(
    result.failures.map((failure) => failure.path),
    []
  );
});
