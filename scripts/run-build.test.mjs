import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCssWithImports } from "./run-build.mjs";

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
