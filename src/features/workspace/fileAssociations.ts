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

type AssociationExpressionFields = Pick<FileAssociationRule, "patterns" | "executablePath" | "argumentsTemplate">;

/** Parse the draft without throwing; malformed path quotes remain visible to validation. */
export function parseAssociationExpression(expression: string): AssociationExpressionFields {
  const separator = expression.indexOf(">");
  const patterns = separator < 0 ? expression : expression.slice(0, separator);
  const command = separator < 0 ? "" : expression.slice(separator + 1).trimStart();
  if (command.startsWith('"')) {
    const end = command.indexOf('"', 1);
    if (end < 0 || (end + 1 < command.length && !/[ \t]/.test(command[end + 1]))) {
      return { patterns, executablePath: command, argumentsTemplate: "" };
    }
    return { patterns, executablePath: command.slice(1, end), argumentsTemplate: command.slice(end + 1).trimStart() };
  }
  const end = command.search(/[ \t]/);
  return end < 0
    ? { patterns, executablePath: command, argumentsTemplate: "" }
    : { patterns, executablePath: command.slice(0, end), argumentsTemplate: command.slice(end).trimStart() };
}

export function formatAssociationCommand(rule: Pick<FileAssociationRule, "executablePath" | "argumentsTemplate">): string {
  const { executablePath: path, argumentsTemplate } = rule;
  const quotePath = (/[ \t]/.test(path) || (!path && !!argumentsTemplate)) && !path.includes('"');
  const executable = quotePath ? `"${path}"` : path;
  return argumentsTemplate ? `${executable} ${argumentsTemplate}` : executable;
}

export function formatAssociationExpression(rule: FileAssociationRule): string {
  return `${rule.patterns} > ${formatAssociationCommand(rule)}`;
}

export function normalizeAssociationRule(rule: FileAssociationRule): FileAssociationRule {
  return {
    ...rule,
    patterns: rule.patterns.split(";").map(token => token.trim()).filter(Boolean).join(";"),
    executablePath: rule.executablePath.trim()
  };
}

export function validateAssociationRule(rule: FileAssociationRule): string | null {
  try {
    parseAssociationExtensions(rule.patterns);
    const path = normalizeAssociationRule(rule).executablePath;
    if (path.includes('"')) return "程序路径的引号或参数分隔格式不正确";
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
