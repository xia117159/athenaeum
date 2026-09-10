import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import "./color-filter-help.css";

const SECTIONS = [
  {
    title: "变量",
    terms: "Name Extension Path Size Created Modified Accessed Age Attributes Type File Directory",
    rows: [
      ["Name", "文件或文件夹名称"],
      ["Extension", "文件的最后一个后缀，包含开头的点；无后缀时为空，文件夹为 Unknown"],
      ["Path", "完整路径"],
      ["Size", "已知的文件大小；文件夹为 Unknown"],
      ["Created / Modified / Accessed", "来源提供的创建、修改和访问时间"],
      ["Age", "当前时间减去 Modified；时间缺失或位于未来时为 Unknown"],
      ["Attributes", "来源能够确定的属性集合"],
      ["Type", "始终可用，值为 File 或 Directory"]
    ]
  },
  {
    title: "运算符与优先级",
    terms: "operators precedence comparison HAS NOT AND OR equal",
    rows: [
      ["==  !=  <  <=  >  >=", "等于、不等于和有序比较；比较不能连续书写"],
      ["Attributes HAS Hidden", "属性集合包含指定属性"],
      ["Attributes NOT HAS ReadOnly", "能够确定该属性不存在"],
      ["( )  ->  NOT  ->  比较  ->  AND  ->  OR", "从高到低的运算优先级；AND 和 OR 从左向右结合"],
      ["Name / Extension / Path", "字符串只支持 == 和 !=；Size、Age、日期支持有序比较"]
    ]
  },
  {
    title: "大小与时间单位",
    terms: "Size Age B KB MB GB TB m h d w y integer binary",
    rows: [
      ["Size >= 20MB", "大小必须是无符号整数加一个单位；1 KB = 1,024 B"],
      ["B / KB / MB / GB / TB", "大小单位使用 1,024 进制，不区分大小写"],
      ["Age > 7d", "寿命必须是无符号整数加一个单位"],
      ["m / h / d / w / y", "分钟、小时、24 小时日、7 天周和 365 天年"],
      ["20 MB / 1.5GB / 1d12h", "空格、小数和复合数量均无效"]
    ]
  },
  {
    title: "通配符与字符串",
    terms: "Name Extension Path wildcard shorthand escape quoted case sensitive semicolon",
    rows: [
      ["个人", "名称完整等于“个人”的快速写法"],
      ["*个人*", "名称中包含“个人”的快速写法"],
      ["*.txt", "名称以 .txt 结尾的快速写法"],
      ["*.cpp;*.md;*.json", "分号分隔多个同级表达式，任一段命中即命中"],
      ["Extension == \".log\";*.tmp", "分号段各自独立解析：可以是完整表达式或快速写法"],
      ["Extension == \".txt\"", "后缀名为 .txt；Extension == \"\" 匹配无后缀文件"],
      ["Path == \"*\\\\Archive\\\\*\"", "两个反斜杠表示路径中的一个反斜杠，星号仍是通配符"],
      ["* / ? / \\* / \\? / \\\\ / \\\"", "分别表示任意长度、单个字符、字面通配符、反斜杠和引号"],
      ["区分大小写", "仅影响 Name、Extension、Path 及其通配符；默认关闭"]
    ]
  },
  {
    title: "日期",
    terms: "Created Modified Accessed date ISO RFC3339 timezone boundary",
    rows: [
      ["Modified >= \"2026-01-01\"", "日期按桌面进程当前系统时区的自然日边界比较"],
      ["Accessed == \"2026-09-07\"", "时间位于指定本地自然日内"],
      ["Created < \"2026-09-07T08:00:00Z\"", "RFC 3339 时间戳按实际时刻比较"],
      ["YYYY-MM-DD", "== 表示当天；< 表示当天开始前；> 表示下一天开始及以后"]
    ]
  },
  {
    title: "属性与可用性",
    terms: "Attributes Hidden System ProtectedSystem ReadOnly Symlink Archive Windows SFTP FTP",
    rows: [
      ["Hidden", "Windows 本地按系统属性判断；SFTP 名称以点开头时视为隐藏；FTP 列表无法证明时为 Unknown"],
      ["System / ProtectedSystem / Archive", "Windows 本地可用；远程来源为 Unknown"],
      ["ReadOnly / Symlink", "本地可用；SFTP/FTP 仅在服务端信息足以证明时可用"],
      ["Created / Accessed", "FTP 不提供；SFTP 不提供 Created，其他字段取决于服务端元数据"]
    ]
  },
  {
    title: "缺失值与三值逻辑",
    terms: "Unknown True False Kleene missing NOT HAS",
    rows: [
      ["True / False / Unknown", "规则只有最终结果为 True 才匹配；缺失事实产生 Unknown"],
      ["NOT Unknown", "结果仍为 Unknown；未知值不会被否定成匹配"],
      ["False AND Unknown", "结果为 False；True AND Unknown 为 Unknown"],
      ["True OR Unknown", "结果为 True；False OR Unknown 为 Unknown"],
      ["!= / NOT HAS", "只有事实已知时才是对应相等或 HAS 结果的反值"]
    ]
  },
  {
    title: "规则优先级",
    terms: "priority order first match enabled style foreground background",
    rows: [
      ["列表顶部优先", "按列表顺序判断，只应用第一条最终为 True 的已启用且有颜色的规则"],
      ["前景色 / 背景色", "两种颜色可独立设置；未设置的通道继承文件列表默认样式"],
      ["全局开关", "关闭后不显示任何规则颜色，但不会删除规则或匹配结果"],
      ["文件 / 文件夹 / 全部", "每条规则的目标范围会在表达式求值前过滤"]
    ]
  },
  {
    title: "完整示例",
    terms: "examples Name Extension Size Age Modified Attributes Type",
    rows: [
      ["Name == \"*个人*\"", "名称包含“个人”"],
      ["Type == File AND Extension == \".log\" AND Age >= 7d", "修改超过 7 天的日志文件"],
      ["Attributes HAS Hidden OR Attributes HAS System", "隐藏或系统条目"],
      ["NOT (Attributes HAS ReadOnly) AND Name == \"report-????.xlsx\"", "已知非只读且名称符合模式"],
      ["Size < 1GB AND Age >= 2h", "小于 1 GB 且至少两小时前修改的文件"]
    ]
  },
  {
    title: "常见错误与限制",
    terms: "errors limits invalid expression syntax tokens depth length",
    rows: [
      ["Name = 个人", "无效：相等运算符必须写成 ==，字符串含空格时必须加双引号"],
      ["*.cpp;;*.md", "无效：分号之间不允许出现空段"],
      ["(Name == a; Name == b)", "无效：括号内的裸分号不是合法符号；需分组请把分号段各自加括号"],
      ["1 < Size < 2MB", "无效：比较不能连写，请使用 Size > 1B AND Size < 2MB"],
      ["Szie >= 20MB", "无效：变量名拼写错误不会退回名称快速写法"],
      ["Name ==", "无效：缺少右侧值"],
      ["1024 / 256 / 24", "每条表达式最多 1024 个字符、256 个词法单元、24 层括号或语法树深度"],
      ["256 条规则 / 128 个字符", "配置最多 256 条规则；规则名去除两端空白后最多 128 个 Unicode 字符"],
      ["16 个文本比较", "全部已启用规则合计最多包含 16 个 Name、Extension 或 Path 比较；分号段的文本比较逐一计入；其他变量不占用此预算"]
    ]
  }
] as const;

export function ColorFilterHelpWindowView() {
  const [query, setQuery] = useState("");
  const sections = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return SECTIONS;
    return SECTIONS.filter((section) =>
      `${section.title} ${section.terms} ${section.rows.flat().join(" ")}`.toLocaleLowerCase().includes(needle)
    );
  }, [query]);

  return (
    <main className="color-filter-help" aria-labelledby="color-filter-help-title">
      <header className="color-filter-help__header">
        <h1 id="color-filter-help-title">颜色过滤器表达式</h1>
        <label className="color-filter-help__search">
          <Search size={16} aria-hidden="true" />
          <input aria-label="搜索帮助" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索变量、运算符或示例" autoFocus />
        </label>
      </header>
      <div className="color-filter-help__content">
        {sections.length === 0 ? <p className="color-filter-help__empty">未找到相关内容</p> : sections.map((section) => (
          <section key={section.title} className="color-filter-help__section">
            <h2>{section.title}</h2>
            <table>
              <tbody>{section.rows.map(([expression, meaning]) => (
                <tr key={expression}><td><code>{expression}</code></td><td>{meaning}</td></tr>
              ))}</tbody>
            </table>
          </section>
        ))}
      </div>
    </main>
  );
}
