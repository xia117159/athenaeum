use anyhow::{bail, Result};

/// Windows CRT argument rules, before inserting any file path.
pub(super) fn parse_arguments(template: &str) -> Result<Vec<String>> {
    if template.contains('\0') {
        bail!("参数不能包含空字符");
    }
    let chars: Vec<char> = template.chars().collect();
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut index = 0;
    while index < chars.len() {
        if !quoted && matches!(chars[index], ' ' | '\t') {
            if started {
                args.push(std::mem::take(&mut current));
            }
            started = false;
            index += 1;
            continue;
        }
        started = true;
        let mut slashes = 0;
        while chars.get(index) == Some(&'\\') {
            slashes += 1;
            index += 1;
        }
        if chars.get(index) == Some(&'"') {
            current.push_str(&"\\".repeat(slashes / 2));
            if slashes % 2 == 1 {
                current.push('"');
            } else if quoted && chars.get(index + 1) == Some(&'"') {
                current.push('"');
                index += 1;
            } else {
                quoted = !quoted;
            }
            index += 1;
        } else {
            current.push_str(&"\\".repeat(slashes));
            if let Some(&ch) = chars.get(index) {
                if quoted || !matches!(ch, ' ' | '\t') {
                    current.push(ch);
                    index += 1;
                }
            }
        }
    }
    if quoted {
        bail!("参数中的双引号未闭合");
    }
    if started {
        args.push(current);
    }
    Ok(args)
}

pub fn file_arguments(template: &str, file: &str) -> Result<Vec<String>> {
    if file.contains('\0') {
        bail!("文件路径不能包含空字符");
    }
    let args = parse_arguments(template)?;
    let has_placeholder = args.iter().any(|arg| arg.contains("{file}"));
    let mut result: Vec<String> = args
        .into_iter()
        .map(|arg| arg.replace("{file}", file))
        .collect();
    if !has_placeholder {
        result.push(file.to_string());
    }
    Ok(result)
}
