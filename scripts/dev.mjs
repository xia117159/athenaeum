import path from "node:path";
import process from "node:process";
import runBuild from "./run-build.mjs";
import { startStaticDevServer } from "./dev-server.mjs";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const host = "127.0.0.1";
const port = 1420;

try {
  await runBuild();
  await startStaticDevServer({ distDir, host, port });
  console.log(`Static dev server listening on http://${host}:${port}`);
} catch (error) {
  console.error(error?.message ?? error);
  process.exitCode = 1;
}
