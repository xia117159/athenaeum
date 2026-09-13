import assert from "node:assert/strict";
import fixtures from "./fileAssociationContract.fixtures.json";
import type { FileAssociationRule } from "../../app/fileAssociations";
import {
  associationProgramFallback, formatAssociationExpression, matchingFileAssociations,
  normalizeAssociationRule, parseAssociationExpression, parseAssociationExtensions, validateAssociationRule
} from "./fileAssociations";
import { fileAssociationArguments } from "./windowsArguments";

const rule = (id: string, patch: Partial<FileAssociationRule> = {}): FileAssociationRule => ({
  id, patterns: "txt", executablePath: String.raw`C:\Editor\editor.exe`, argumentsTemplate: "{file}", ...patch
});

for (const test of fixtures.extensions) {
  if (test.expected === null) assert.throws(() => parseAssociationExtensions(test.input), test.input);
  else assert.deepEqual(parseAssociationExtensions(test.input), test.expected, test.input);
}
for (const test of fixtures.matching) {
  assert.equal(matchingFileAssociations([rule("match", { patterns: test.patterns })], test.path).length > 0,
    test.expected, JSON.stringify(test));
}
for (const test of fixtures.arguments) {
  if (test.expected === null) assert.throws(() => fileAssociationArguments(test.template, test.file), test.template);
  else assert.deepEqual(fileAssociationArguments(test.template, test.file), test.expected, test.template);
}

const ordered = [rule("empty", {executablePath:""}), rule("bad", {patterns:"*"}), rule("missing", {
  executablePath: String.raw`X:\not-installed.exe`
}), rule("last")];
assert.deepEqual(matchingFileAssociations(ordered, "D:\\file.txt").map(item => item.id), ["missing", "last"]);
assert.equal(validateAssociationRule(rule("blank", {patterns:"", executablePath:""})), null);
assert.ok(validateAssociationRule(rule("bad", {argumentsTemplate:'"unfinished'})));

const expressionRule = (value: string) => normalizeAssociationRule(rule("expression", parseAssociationExpression(value)));
const expression = String.raw`*.md;.json;txt > "D:\Program Files (x86)\Notepad++\notepad++.exe" --new-window {file}`;
const parsed = expressionRule(expression);
assert.equal(parsed.executablePath, String.raw`D:\Program Files (x86)\Notepad++\notepad++.exe`, "split program path from its arguments");
assert.equal(parsed.argumentsTemplate, "--new-window {file}");
assert.equal(formatAssociationExpression(parsed), expression);
const openedFile = String.raw`F:\资料\my notes.md`;
assert.deepEqual(fileAssociationArguments(parsed.argumentsTemplate, openedFile), ["--new-window", openedFile]);

for (const input of [
  String.raw`txt > "D:\Program Files\Editor\editor.exe"`,
  String.raw`txt > D:\Editor\editor.exe`,
  String.raw`txt > "D:\Editor\editor.exe"   `
]) {
  const noArguments = expressionRule(input);
  assert.equal(noArguments.argumentsTemplate, "", "all command-line parameters are optional");
  assert.equal(validateAssociationRule(noArguments), null);
  assert.deepEqual(fileAssociationArguments(noArguments.argumentsTemplate, openedFile), [openedFile]);
  assert.deepEqual(expressionRule(formatAssociationExpression(noArguments)), noArguments);
}
const noPlaceholder = expressionRule(String.raw`txt > C:\Editor\editor.exe --new-window`);
assert.deepEqual(fileAssociationArguments(noPlaceholder.argumentsTemplate, openedFile), ["--new-window", openedFile]);
const quotedArguments = expressionRule(String.raw`txt > C:\Editor\editor.exe --title "a > b" "" "{file}"`);
assert.equal(validateAssociationRule(quotedArguments), null, "a > character inside an argument is not another association separator");
assert.deepEqual(fileAssociationArguments(quotedArguments.argumentsTemplate, openedFile), ["--title", "a > b", "", openedFile]);
assert.deepEqual(expressionRule(formatAssociationExpression(quotedArguments)), quotedArguments);

for (const invalid of [
  String.raw`txt > ""C:\Editor\editor.exe""`,
  String.raw`txt > """C:\Editor\editor.exe"""`,
  String.raw`txt > "C:\Program Files\editor.exe`,
  String.raw`txt > "C:\editor.exe"--new-window`,
  String.raw`txt > C:\edi"tor.exe`,
  String.raw`txt > C:\editor.exe --title "unfinished`
]) {
  const draft = expressionRule(invalid);
  assert.ok(validateAssociationRule(draft), invalid);
  assert.ok(validateAssociationRule(expressionRule(formatAssociationExpression(draft))), "formatting cannot silently repair invalid input");
  let normalized = draft;
  for (let attempt = 0; attempt < 4; attempt++) {
    normalized = normalizeAssociationRule(normalized);
    assert.ok(validateAssociationRule(normalized), "blur, section changes and saving cannot peel away malformed quotes");
  }
}
const incomplete = expressionRule('txt > "" --new-window');
assert.equal(incomplete.executablePath, "");
assert.equal(incomplete.argumentsTemplate, "--new-window");
assert.equal(validateAssociationRule(incomplete), null);
assert.deepEqual(matchingFileAssociations([incomplete], "notes.txt"), []);
assert.deepEqual(expressionRule(formatAssociationExpression(incomplete)), incomplete);
assert.deepEqual(parseAssociationExpression("*.md;"), {patterns:"*.md;", executablePath:"", argumentsTemplate:""});
assert.deepEqual(expressionRule("txt >"), rule("expression", {patterns:"txt", executablePath:"", argumentsTemplate:""}));
assert.ok(validateAssociationRule(rule("bad", parseAssociationExpression("txt > ed>itor.exe"))));
assert.equal(associationProgramFallback(String.raw`C:\中文目录\编辑器.exe`), "编辑器.exe");
assert.equal(associationProgramFallback("C:\\"), "C:\\");
console.log("ok - association aliases, ordered matching, raw expressions and Windows argv contract");
