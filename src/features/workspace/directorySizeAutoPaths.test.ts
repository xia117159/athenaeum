import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findAutoDirectorySizeRoot, isVolumeRootPath, normalizeAutoDirectorySizePath } from "./directorySizeAutoPaths";

type Vector = { input: string; normalized: string | null; volumeRoot: boolean };
// SPEC-031: one shared vector file for Rust and TypeScript.
const vectors = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src-tauri", "tests", "fixtures", "auto_directory_size_paths.json"), "utf8")) as Vector[];

test("auto size paths follow the shared normalization vectors", () => {
  assert.ok(vectors.length > 10);
  for (const vector of vectors) {
    const normalized = normalizeAutoDirectorySizePath(vector.input);
    assert.equal(normalized, vector.normalized, JSON.stringify(vector.input));
    assert.equal(normalized !== null && isVolumeRootPath(normalized), vector.volumeRoot, JSON.stringify(vector.input));
  }
});

test("auto size path length applies to the normalized UTF-16 form", () => {
  const longest = `C:\\${"a".repeat(32_764)}`;
  assert.equal(normalizeAutoDirectorySizePath(longest), longest);
  assert.equal(normalizeAutoDirectorySizePath(`\\\\?\\${longest}`), longest);
  assert.equal(normalizeAutoDirectorySizePath(`${longest}a`), null);
  assert.equal(normalizeAutoDirectorySizePath(`C:\\${"😀".repeat(16_383)}`), null);
});

test("auto size roots cover descendants, UNC paths, and report the shallowest inherited ancestor", () => {
  const list = ["D:\\A\\B", "D:\\A", "\\\\server\\share\\Docs", "E:\\"];
  assert.deepEqual(findAutoDirectorySizeRoot("d:\\a\\b\\c", list), { root: "D:\\A", inherited: true });
  assert.deepEqual(findAutoDirectorySizeRoot("D:\\A", list), { root: "D:\\A", inherited: false });
  assert.deepEqual(findAutoDirectorySizeRoot("\\\\SERVER\\share\\docs\\x", list), { root: "\\\\server\\share\\Docs", inherited: true });
  assert.deepEqual(findAutoDirectorySizeRoot("E:\\deep\\er", list), { root: "E:\\", inherited: true });
  assert.equal(findAutoDirectorySizeRoot("D:\\AB", list), null);
  assert.equal(findAutoDirectorySizeRoot("ftp://host/D:/A", list), null);
  assert.equal(findAutoDirectorySizeRoot("C:\\A", []), null);
});
