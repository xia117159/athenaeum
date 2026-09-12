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

const expression = String.raw`*.md;.json;txt > D:\Program Files (x86)\Notepad++\notepad++.exe`;
const parsed = parseAssociationExpression(expression);
assert.equal(parsed.patterns, "*.md;.json;txt ");
assert.equal(parsed.executablePath, String.raw` D:\Program Files (x86)\Notepad++\notepad++.exe`);
assert.equal(formatAssociationExpression(normalizeAssociationRule(rule("edit", parsed))), expression);
for (let length = 0; length <= expression.length; length++) {
  const raw = expression.slice(0, length);
  const pieces = parseAssociationExpression(raw);
  assert.equal(raw.includes(">") ? pieces.patterns + ">" + pieces.executablePath : pieces.patterns, raw);
}
assert.deepEqual(parseAssociationExpression("*.md;"), {patterns:"*.md;", executablePath:""});
assert.ok(validateAssociationRule(rule("bad", parseAssociationExpression("txt > editor > exe"))));
assert.equal(associationProgramFallback(String.raw`C:\中文目录\编辑器.exe`), "编辑器.exe");
assert.equal(associationProgramFallback("C:\\"), "C:\\");
console.log("ok - association aliases, ordered matching, raw expressions and Windows argv contract");
