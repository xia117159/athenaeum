import type { FileAssociationRule } from "../../app/fileAssociations";
import { parseWindowsArguments } from "./windowsArguments";

export function parseAssociationExtensions(patterns: string): string[] {
  const extensions = new Set<string>();
  for (const raw of patterns.split(";")) {
    const token = raw.trim();
    if (!token) continue;
    const extension = token.replace(/^\*?\./, "");
    if (!extension || /[\s*?/\\:<>|"\u0000-\u001f]/u.test(extension) || extension.split(".").some(part => !part)) {
      throw new Error(`后缀格式无效：${token}，请使用 *.md、.md 或 md`);
    }
    extensions.add(extension.toLowerCase());
  }
  return [...extensions];
}

export function matchingFileAssociations(rules: readonly FileAssociationRule[], path: string): FileAssociationRule[] {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  return rules.filter(rule => {
    if (!rule.executablePath.trim() || validateAssociationRule(rule)) return false;
    return parseAssociationExtensions(rule.patterns).some(extension => name.endsWith(`.${extension}`));
  });
}

/** Preserve every typed character; only commit/save normalizes token boundaries. */
export function parseAssociationExpression(expression: string): Pick<FileAssociationRule, "patterns" | "executablePath"> {
  const separator = expression.indexOf(">");
  return separator < 0
    ? { patterns: expression, executablePath: "" }
    : { patterns: expression.slice(0, separator), executablePath: expression.slice(separator + 1) };
}

export function formatAssociationExpression(rule: FileAssociationRule): string {
  return `${rule.patterns} > ${rule.executablePath}`;
}

export function normalizeAssociationRule(rule: FileAssociationRule): FileAssociationRule {
  let executablePath = rule.executablePath.trim();
  if (executablePath.startsWith('"') && executablePath.endsWith('"') && executablePath.length > 1) {
    executablePath = executablePath.slice(1, -1);
  }
  return {
    ...rule,
    patterns: rule.patterns.split(";").map(token => token.trim()).filter(Boolean).join(";"),
    executablePath
  };
}

export function validateAssociationRule(rule: FileAssociationRule): string | null {
  try {
    parseAssociationExtensions(rule.patterns);
    const path = normalizeAssociationRule(rule).executablePath;
    if (/[<>|?*"\u0000-\u001f]/u.test(path)) return "程序路径含有无效字符";
    parseWindowsArguments(rule.argumentsTemplate);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "关联规则无效";
  }
}

export function associationProgramFallback(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

export function associationRulesError(rules: readonly FileAssociationRule[]): string | null {
  const ids = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    const error = !rule.id || ids.has(rule.id) ? "规则标识重复或为空，请删除后重新新建" : validateAssociationRule(rule);
    if (error) return `第 ${index + 1} 条关联：${error}`;
    ids.add(rule.id);
  }
  return null;
}
