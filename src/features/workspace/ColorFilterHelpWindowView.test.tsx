import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorFilterHelpWindowView } from "./ColorFilterHelpWindowView";

const markup = renderToStaticMarkup(<ColorFilterHelpWindowView />);

for (const example of [
  "个人",
  "*个人*",
  "*.txt",
  "*.cpp;*.md;*.json",
  "任一段命中即命中",
  "*.cpp;;*.md",
  "(Name == a; Name == b)",
  "Extension == &quot;.txt&quot;",
  "Size &gt;= 20MB",
  "Modified &gt;= &quot;2026-01-01&quot;",
  "Type == File",
  "Attributes HAS Hidden",
  "Attributes NOT HAS ReadOnly",
  "==  !=  &lt;  &lt;=  &gt;  &gt;=",
  "Path == &quot;*\\\\Archive\\\\*&quot;",
  "1 KB = 1,024 B",
  "1d12h",
  "1 &lt; Size &lt; 2MB",
  "1024",
  "256",
  "24",
  "16 个文本比较"
]) {
  assert.equal(markup.includes(example), true, `help should include ${example}`);
}
for (const section of [
  "变量",
  "运算符与优先级",
  "大小与时间单位",
  "通配符与字符串",
  "属性与可用性",
  "缺失值与三值逻辑",
  "规则优先级",
  "完整示例",
  "常见错误与限制"
]) {
  assert.equal(markup.includes(`>${section}<`), true, `help should include the ${section} section`);
}
assert.equal(markup.includes("Name = 个人"), true, "help should explain invalid single-equals syntax");
console.log("ok - color filter help contains the complete searchable language reference");
