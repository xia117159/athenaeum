use super::{
    EvalResult, EvalText, Evaluation, Evaluator, FunctionDefinition, FunctionExample, FunctionInfo,
    FunctionParameter, FunctionRegistry, MAX_TEXT_BYTES,
};
use chrono::{Datelike, Timelike};

pub(super) fn register(registry: &mut FunctionRegistry) {
    let mut add = |name: &str,
                   parameters: &[(&str, &str, bool)],
                   description: &str,
                   examples: &[(&str, &str)],
                   evaluate: Evaluator| {
        registry
            .register(FunctionDefinition {
                info: FunctionInfo {
                    name: name.into(),
                    aliases: Vec::new(),
                    parameters: parameters
                        .iter()
                        .map(|(name, role, optional)| FunctionParameter {
                            name: (*name).into(),
                            role: (*role).into(),
                            optional: *optional,
                        })
                        .collect(),
                    description: description.into(),
                    examples: examples
                        .iter()
                        .map(|(expression, result)| FunctionExample {
                            expression: (*expression).into(),
                            result: (*result).into(),
                        })
                        .collect(),
                },
                evaluate,
            })
            .expect("builtin function names must be unique");
    };
    let text = [("text", "text", false)];
    add(
        "toupper",
        &text,
        "将文本转换为 Unicode 大写。函数名不区分大小写。",
        &[
            ("<TOUPPER *>", "TEST.txt"),
            ("<toupper New_<date yyyy-mm-dd>>", "NEW_2026-09-12.txt"),
        ],
        |args, _| args[0].change_case(true),
    );
    add(
        "tolower",
        &text,
        "将文本转换为 Unicode 小写。",
        &[
            ("<tolower *>", "test.txt"),
            ("<tolower <tohex New_<date yyyy-mm-dd>>>", "new_7ea-9-c.txt"),
        ],
        |args, _| args[0].change_case(false),
    );
    add(
        "tohex",
        &text,
        "将每段十进制数字转为大写十六进制；不加 0x，不保留前导零。可处理长整数。",
        &[("<tohex New_<date yyyy-mm-dd>>", "New_7EA-9-C.txt")],
        tohex,
    );
    add(
        "date",
        &[("format", "format", false)],
        "使用打开窗口时冻结的本机当前时间。",
        &[
            (
                "New_<date yyyy-mm-ddThh-mm-ss>",
                "New_2026-09-12T11-46-28.txt",
            ),
            ("New_<date yyyymmddhhmmss>", "New_20260912114628.txt"),
        ],
        |args, evaluation| format_date(&args[0], Some(evaluation.context.now)),
    );
    add(
        "datem",
        &[("format", "format", false)],
        "使用文件的修改时间（本机时区）。时间不可读取时该行报错。",
        &[("New_<datem yyyy-mm-dd>", "New_2026-08-24.txt")],
        |args, evaluation| format_date(&args[0], evaluation.context.modified),
    );
    add(
        "datec",
        &[("format", "format", false)],
        "使用文件的创建时间（本机时区）。时间不可读取时该行报错。",
        &[("New_<datec yyyy-mm-dd>", "New_2026-08-18.txt")],
        |args, evaluation| format_date(&args[0], evaluation.context.created),
    );
    add("counter", &[("start", "number", false), ("width", "number", false)],
        "序号 = 起点 + 预览行序号（从 0 开始）。位宽是最小长度，超过不截断；<#001> 等同于 <counter 1 3>。",
        &[("New<#1>", "New1.txt，New2.jpg，…"), ("New<#00>", "New00.txt，New01.jpg，…"),
          ("?-<#001>", "txt-001.txt")], counter);
    add("regular", &[("pattern", "pattern", false), ("text", "text", false)],
        "提取正则的第一次完整匹配；无匹配报错。使用 Rust regex 语法，不支持环视或反向引用；引用中的 \\d 可直接书写。",
        &[(r"<toupper <regular 'esn\d{4}gpa\d{3}' *>>", "ESN2025GPA001.zip（log_20260912114628_esn2025gpa001-4-控制台A.zip）")],
        |args, evaluation| {
            evaluation.charge(args[0].as_str().len().max(1).saturating_mul(args[1].as_str().len().max(1)))?;
            let regex = evaluation.regex(args[0].as_str())?;
            let matched = regex.find(args[1].as_str()).ok_or("正则表达式未匹配原名称")?;
            Ok(args[1].slice(matched.range()))
        });
    add(
        "trim",
        &text,
        "删除文本两端的 Unicode 空白。",
        &[("<trim '  New name  '>", "New name.txt")],
        |args, _| {
            let value = args[0].as_str();
            let start = value.len() - value.trim_start().len();
            let end = value.trim_end().len().max(start);
            Ok(args[0].slice(start..end))
        },
    );
    add(
        "replace",
        &[
            ("text", "text", false),
            ("old", "pattern", false),
            ("new", "text", false),
        ],
        "按字面内容替换全部匹配（区分大小写）；old 不能为空。",
        &[("<replace * 'Test' 'New name'>", "New name.txt")],
        replace,
    );
    add("substr", &[("text", "text", false), ("start", "number", false), ("length", "number", true)],
        "按 Unicode 字符截取；start 从 0 开始，负数从末尾数。length 可省略，必须非负，超出范围截到边界。",
        &[("<substr * 0 2>", "Te.txt"), ("<substr * -2>", "st.txt")], substr);
}

fn decimal_digits(value: &str) -> Result<&str, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("需要非负十进制整数".into());
    }
    let trimmed = value.trim_start_matches('0');
    Ok(if trimmed.is_empty() { "0" } else { trimmed })
}

fn counter(args: &[EvalText], evaluation: &mut Evaluation<'_, '_>) -> EvalResult {
    let start = decimal_digits(args[0].as_str())?;
    let width = args[1]
        .as_str()
        .parse::<usize>()
        .map_err(|_| "序号位宽需要非负整数")?;
    if width > MAX_TEXT_BYTES {
        return Err("序号位宽超限".into());
    }
    let mut carry = evaluation.context.index;
    let mut digits = Vec::new();
    for digit in start.bytes().rev() {
        evaluation.charge(1)?;
        let sum = usize::from(digit - b'0') + carry % 10;
        digits.push((sum % 10) as u8 + b'0');
        carry = carry / 10 + sum / 10;
    }
    while carry > 0 {
        digits.push((carry % 10) as u8 + b'0');
        carry /= 10;
    }
    digits.resize(digits.len().max(width), b'0');
    digits.reverse();
    Ok(EvalText::generated(
        String::from_utf8(digits).expect("decimal ASCII"),
    ))
}

fn tohex(args: &[EvalText], evaluation: &mut Evaluation<'_, '_>) -> EvalResult {
    let input = &args[0];
    let text = input.as_str();
    let mut result = EvalText::generated("");
    let mut cursor = 0;
    while cursor < text.len() {
        let start = cursor;
        let digit_run = text.as_bytes()[cursor].is_ascii_digit();
        while cursor < text.len() && text.as_bytes()[cursor].is_ascii_digit() == digit_run {
            cursor += text[cursor..].chars().next().unwrap().len_utf8();
        }
        if !digit_run {
            result.append(&input.slice(start..cursor))?;
            continue;
        }
        let decimal = decimal_digits(&text[start..cursor])?;
        let mut hex = vec![0u8];
        for digit in decimal.bytes() {
            evaluation.charge(hex.len())?;
            let mut carry = digit - b'0';
            for nibble in &mut hex {
                let value = *nibble as u16 * 10 + carry as u16;
                *nibble = (value % 16) as u8;
                carry = (value / 16) as u8;
            }
            while carry > 0 {
                hex.push(carry % 16);
                carry /= 16;
            }
        }
        let converted: String = hex
            .into_iter()
            .rev()
            .map(|nibble| b"0123456789ABCDEF"[nibble as usize] as char)
            .collect();
        result.append(&EvalText::generated(converted))?;
    }
    Ok(result)
}

fn replace(args: &[EvalText], evaluation: &mut Evaluation<'_, '_>) -> EvalResult {
    let input = &args[0];
    let old = args[1].as_str();
    let replacement = &args[2];
    if old.is_empty() {
        return Err("replace 的 old 参数不能为空".into());
    }
    let mut result = EvalText::generated("");
    let mut cursor = 0;
    for (offset, _) in input.as_str().match_indices(old) {
        evaluation.charge(1 + replacement.as_str().len())?;
        result.append(&input.slice(cursor..offset))?;
        result.append(replacement)?;
        cursor = offset + old.len();
    }
    result.append(&input.slice(cursor..input.as_str().len()))?;
    Ok(result)
}

fn substr(args: &[EvalText], _: &mut Evaluation<'_, '_>) -> EvalResult {
    let input = &args[0];
    let start = args[1]
        .as_str()
        .parse::<i64>()
        .map_err(|_| "substr 的 start 参数需要整数")?;
    let positions = input
        .as_str()
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(input.as_str().len()))
        .collect::<Vec<_>>();
    let count = positions.len() - 1;
    let offset = if start < 0 {
        (count as i64).saturating_add(start).max(0) as usize
    } else {
        (start as u64).min(count as u64) as usize
    };
    let end = if let Some(length) = args.get(2) {
        let length = length
            .as_str()
            .parse::<usize>()
            .map_err(|_| "substr 的 length 参数需要非负整数")?;
        offset.saturating_add(length).min(count)
    } else {
        count
    };
    Ok(input.slice(positions[offset]..positions[end]))
}

fn format_date(
    format: &EvalText,
    date: Option<chrono::DateTime<chrono::FixedOffset>>,
) -> EvalResult {
    let date = date.ok_or("无法读取此项目的日期")?;
    let mut output = String::new();
    let mut after_hour = false;
    let mut chars = format.as_str().chars().peekable();
    while let Some(ch) = chars.next() {
        if !matches!(ch, 'y' | 'm' | 'd' | 'h' | 's') {
            output.push(ch);
            continue;
        }
        let mut width = 1;
        while chars.peek() == Some(&ch) {
            chars.next();
            width += 1;
        }
        let value = match ch {
            'y' if width == 4 => date.year(),
            'y' if width == 2 => date.year().rem_euclid(100),
            'm' if width <= 2 => {
                if after_hour {
                    date.minute() as i32
                } else {
                    date.month() as i32
                }
            }
            'd' if width <= 2 => date.day() as i32,
            'h' if width <= 2 => {
                after_hour = true;
                date.hour() as i32
            }
            's' if width <= 2 => date.second() as i32,
            _ => return Err(format!("无效日期字段：{}", ch.to_string().repeat(width))),
        };
        output.push_str(&format!("{value:0width$}"));
    }
    Ok(EvalText::generated(output))
}
