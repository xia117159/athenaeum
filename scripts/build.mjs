import process from "node:process";
import runBuild from "./run-build.mjs";

runBuild().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
