import type { RenameFunctionInfo } from "../../app/batchRename";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { createBatchRenameGateway } from "./batchRenameGateway";
import "./batch-rename-help.css";

const loadCatalog = createBatchRenameGateway().functions;
const sections = [
  { title: "名称、扩展名与通配符", rows: [
    ["默认保留扩展名", "原名 Test.txt：ThisNew → ThisNew.txt；ThisNew.txt → ThisNew.txt；ThisNew.md → ThisNew.md。"],
    ["*：原基本名", "New-* → New-Test.txt；*-<date yyyy> → Test-2026.txt。"],
    ["?：原扩展名（不含点）", "?-<#001> → txt-001.txt。原扩展名的大小写保留。"],
    ["多点名称与文件夹", "archive.v1.txt 使用 * → archive.v1.txt；*.md → archive.v1.md；new.* → new.archive.v1.txt。文件夹的 * 代表完整名称，不自动追加扩展名。"],
    ["无扩展名", "无扩展名文件不追加点；.gitignore 按无扩展名处理。通过原名提取的点不会自动替换原扩展名。"]
  ] },
  { title: "函数、嵌套与引用", rows: [
    ["<函数名 参数1 参数2>", "函数名不区分大小写，参数之间用空白分隔；可以把文本、*、? 和嵌套调用拼接成一个参数。"],
    ["<TOUPPER *>", "TEST.txt。等同于 <toupper *>；函数只变换参数中的文本。"],
    ["<toupper New_<date yyyy-mm-dd>>", "NEW_2026-09-12.txt。先计算内层，再计算外层。"],
    ["<tolower <tohex New_<date yyyy-mm-dd>>>", "new_7ea-9-c.txt。十六进制默认大写；外层 tolower 可转为小写。"],
    ["单引号或双引号", "<toupper 'New file'> 或 <toupper \"New file\"> → NEW FILE.txt。引号里的空格和 *、?、尖括号均为字面文本。"],
    ["引用与反斜杠", "引用中可转义当前引号和反斜杠；\\d 等其它序列原样保留。函数结果不会再次被当作表达式执行。"]
  ] },
  { title: "序号与日期", rows: [
    ["New<#1>", "New1.txt、New2.jpg、… New74.png。起点是 1，最小位宽是 1。"],
    ["New<#00>", "New00.txt、New01.jpg、… New235.png。起点是 0，超过两位时不截断。"],
    ["<#001> / <counter 1 3>", "两种写法等价：001、002、003…；按打开窗口时捕获的列表顺序编号。每个计数表达式使用各自的起点。"],
    ["New_<date yyyy-mm-ddThh-mm-ss>", "New_2026-09-12T11-46-28.txt，使用当前日期。"],
    ["New_<date yyyymmddhhmmss>", "New_20260912114628.txt。"],
    ["New_<datem yyyy-mm-dd>", "New_2026-08-24.txt，使用文件修改日期。"],
    ["New_<datec yyyy-mm-dd>", "New_2026-08-18.txt，使用文件创建日期。"],
    ["yyyy / yy、mm / m、dd / d、hh / h、ss / s", "年、月/分钟、日、24 小时、秒；小时字段之前的 mm/m 为月份，之后为分钟。两位字段补零，分隔文字原样保留。"],
    ["日期冻结", "日期按本机时区计算，并在打开窗口时冻结。等待、编辑和确认不会改变本次使用的时间；无法读取文件日期时该行报错。"]
  ] },
  { title: "正则提取示例", rows: [
    ["原名称", "log_20260912114628_esn2025gpa001-4-控制台A.zip"],
    ["<toupper <regular 'esn\\d{4}gpa\\d{3}' *>>", "ESN2025GPA001.zip。regular 返回第一次完整匹配；没有匹配时整批不能确认。"],
    ["正则语法", "使用 Rust regex 语法，支持字符类、分组与重复次数，不支持环视和反向引用。建议把正则放在单引号或双引号中。"]
  ] },
  { title: "预览、历史与撤销", rows: [
    ["打开入口", "默认 Ctrl+M 打开批量窗口，单个文件也可使用，可在快捷键设置中修改。多选 F2、工具栏或右键菜单“重命名”进入本窗口；单选 F2 仍行内编辑。"],
    ["预览与确认", "所有选中项都会列出；新名称的新增/替换部分高亮，原名称中删除的部分带删除线。有一项无效或全部未变化时，“确认”不可用。"],
    ["历史记录", "只保留成功执行的完整表达式，最近 20 条；区分大小写，重复项置顶。下拉支持上下键、Enter 选择、Escape 收起。"],
    ["Ctrl+Z 整批撤销", "一批是一条持久操作历史，一次 Ctrl+Z 撤销整批；在表达式输入框中 Ctrl+Z 保持文字撤销。关闭批量窗口后可从文件列表撤销。"],
    ["取消与恢复", "执行时取消会等待已改项目恢复。失败时保留实际位置与恢复记录；原名被占用时不会覆盖，可处理冲突后在操作历史中重试撤销。"],
    ["本轮支持", "本地文件和文件夹，支持混合选择与父子目录。FTP/SFTP 的批量重命名暂未提供。"]
  ] },
  { title: "常见错误与限制", rows: [
    ["无效表达式", "检查函数名、参数数量、引号与尖括号是否闭合。空名称、纯空白名称和正则未匹配均不能执行。"],
    ["Windows 文件名", "不能包含 < > : \" / \\ | ? * 或控制字符，不能以点或空格结尾；CON、NUL、COM1 等设备保留名不可使用。"],
    ["冲突与来源变化", "同目录的新名称不能重复，也不能覆盖未移动的项目。已选项目之间可以交换名称。预览后原文件被替换或修改时需关闭并重新预览。"],
    ["规模限制", "每次最多 10000 个项目；表达式最多 16 KiB，嵌套最多 64 层。过大结果、过长正则或超出计算量时会显示诊断，请缩小批次或简化表达式。"]
  ] }
];

export function BatchRenameHelpWindowView({ loadFunctions = loadCatalog }: { loadFunctions?: () => Promise<RenameFunctionInfo[]> }) {
  const [functions, setFunctions] = useState<RenameFunctionInfo[]>([]);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    let disposed = false;
    void loadFunctions().then(catalog => { if (!disposed) setFunctions(catalog); })
      .catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; };
  }, [loadFunctions]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (value: unknown) => !needle || JSON.stringify(value).toLocaleLowerCase().includes(needle);
  const visible = sections.filter(matches), catalog = functions.filter(matches);
  return <main className="batch-rename-help">
    <header><h1>批量重命名帮助</h1><label><Search size={15} aria-hidden="true" /><input aria-label="搜索帮助" placeholder="搜索规则、函数或示例"
      value={query} onChange={event => setQuery(event.target.value)} /></label></header>
    <article>
      <p className="batch-rename-help__intro">除特别说明外，示例原名为 <code>Test.txt</code>。日期示例使用 2026 年 9 月 12 日，实际以打开窗口时的日期为准。</p>
      {visible.map(section => <section key={section.title}><h2>{section.title}</h2><table><tbody>
        {section.rows.map(([expression, description]) => <tr key={expression}><td><code>{expression}</code></td><td>{description}</td></tr>)}
      </tbody></table></section>)}
      {catalog.length ? <section><h2>函数目录</h2>{catalog.map(fn => <section key={fn.name} className="batch-rename-help__function">
        <h3><code>{`<${fn.name}${fn.parameters.map(parameter => ` ${parameter.optional ? `[${parameter.name}]` : parameter.name}`).join("")}>`}</code></h3>
        <p>{fn.description}{fn.aliases.length ? ` 别名：${fn.aliases.join("、")}。` : ""}</p>
        <table><tbody>{fn.examples.map((example, index) => <tr key={index}><td><code>{example.expression}</code></td><td>{example.result}</td></tr>)}</tbody></table>
      </section>)}</section> : null}
      {error ? <p role="status" className="batch-rename-help__error">无法读取函数目录：{error}</p> : null}
      {!functions.length && !error ? <p role="status">正在读取函数目录…</p> : null}
      {!visible.length && !catalog.length && functions.length ? <p>没有匹配的帮助内容。</p> : null}
    </article>
  </main>;
}
