/** Parse a template before inserting paths: a substituted path is always one argv value. */
export function parseWindowsArguments(template: string): string[] {
  if (template.includes("\0")) throw new Error("参数不能包含空字符");
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  let index = 0;
  while (index < template.length) {
    const char = template[index];
    if (!quoted && (char === " " || char === "\t")) {
      if (started) args.push(current);
      current = "";
      started = false;
      index++;
      continue;
    }
    started = true;
    let slashes = 0;
    while (template[index] === "\\") { slashes++; index++; }
    if (template[index] === '"') {
      current += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2) current += '"';
      else if (quoted && template[index + 1] === '"') { current += '"'; index++; }
      else quoted = !quoted;
      index++;
    } else {
      current += "\\".repeat(slashes);
      if (index < template.length && (quoted || !/[ \t]/.test(template[index]))) current += template[index++];
    }
  }
  if (quoted) throw new Error("参数中的双引号未闭合");
  if (started) args.push(current);
  return args;
}

export function fileAssociationArguments(template: string, file: string): string[] {
  if (file.includes("\0")) throw new Error("文件路径不能包含空字符");
  const args = parseWindowsArguments(template);
  const hasPlaceholder = args.some(arg => arg.includes("{file}"));
  const result = args.map(arg => arg.replaceAll("{file}", file));
  if (!hasPlaceholder) result.push(file);
  return result;
}
