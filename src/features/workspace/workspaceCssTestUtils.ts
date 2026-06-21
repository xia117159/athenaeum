import fs from "node:fs";
import path from "node:path";

const IMPORT_PATTERN = /@import\s+["'](.+)["'];/g;

export function readWorkspaceCss(entryPath = path.join(process.cwd(), "src/features/workspace/workspace.css")) {
  const seen = new Set<string>();

  function readCssFile(filePath: string): string {
    const resolvedPath = path.resolve(filePath);
    if (seen.has(resolvedPath)) {
      return "";
    }
    seen.add(resolvedPath);

    const css = fs.readFileSync(resolvedPath, "utf8");
    return css.replace(IMPORT_PATTERN, (_match, importPath: string) => {
      const importedPath = path.resolve(path.dirname(resolvedPath), importPath);
      return readCssFile(importedPath);
    });
  }

  return readCssFile(entryPath);
}
