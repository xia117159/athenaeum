import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const countArg = process.argv.find((arg) => arg.startsWith("--count="));
const count = Number(countArg?.slice("--count=".length) ?? 2000);
if (![2000, 20000].includes(count)) {
  throw new Error("--count must be 2000 or 20000");
}
const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
const parent = rootArg ? path.resolve(rootArg.slice("--root=".length)) : os.tmpdir();
await fs.mkdir(parent, { recursive: true });
const fixture = await fs.mkdtemp(path.join(parent, `athenaeum-listing-${count}-`));
const extensions = [".txt", ".md", ".json", ".ts", ".png", ".exe", ".lnk", ".ico"];
for (let index = 0; index < count; index += 1) {
  const name = `item-${String(index).padStart(5, "0")}${extensions[index % extensions.length]}`;
  if (index % 97 === 0) {
    await fs.mkdir(path.join(fixture, `folder-${String(index).padStart(5, "0")}`));
  } else {
    await fs.writeFile(path.join(fixture, name), "x");
  }
}
console.log(JSON.stringify({ fixture, entries: count }));
