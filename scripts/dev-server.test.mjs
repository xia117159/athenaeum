import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startStaticDevServer } from "./dev-server.mjs";

function assertTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

await assertTest("startStaticDevServer reports occupied ports without an unhandled server error", async () => {
  const blocker = http.createServer((_req, res) => res.end("busy"));
  const port = await listen(blocker, 0);

  try {
    await assert.rejects(
      () => startStaticDevServer({ distDir: os.tmpdir(), host: "127.0.0.1", port }),
      (error) => {
        assert.equal(error.code, "EADDRINUSE");
        assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
        assert.match(error.message, /Get-NetTCPConnection/);
        return true;
      }
    );
  } finally {
    await close(blocker);
  }
});

await assertTest("startStaticDevServer serves files from the built dist directory", async () => {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfm-dev-server-"));
  await fs.mkdir(path.join(distDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(distDir, "index.html"), "<!doctype html><title>ok</title>");
  await fs.writeFile(path.join(distDir, "assets", "app.js"), "export default 1;");

  const server = await startStaticDevServer({ distDir, host: "127.0.0.1", port: 0 });
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/assets/app.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await response.text(), "export default 1;");

    const fallback = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(fallback.status, 200);
    assert.equal(await fallback.text(), "<!doctype html><title>ok</title>");
  } finally {
    await close(server);
    await fs.rm(distDir, { force: true, recursive: true });
  }
});
