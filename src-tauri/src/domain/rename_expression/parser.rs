use super::{Diagnostic, MAX_DEPTH, MAX_EXPRESSION_BYTES};

pub(super) enum Node {
    Literal(String),
    Base,
    Extension,
    Call {
        name: String,
        args: Vec<Vec<Node>>,
        start: usize,
        end: usize,
    },
}

pub(super) fn parse(source: &str) -> Result<Vec<Node>, Diagnostic> {
    if source.len() > MAX_EXPRESSION_BYTES {
        return Err(Diagnostic {
            message: "表达式超过 16 KiB".into(),
            start: 0,
            end: source.len(),
        });
    }
    Parser {
        source,
        position: 0,
    }
    .template(false, 0)
}

struct Parser<'a> {
    source: &'a str,
    position: usize,
}
impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.source[self.position..].chars().next()
    }
    fn advance(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.position += ch.len_utf8();
        Some(ch)
    }
    fn error(&self, message: impl Into<String>, start: usize) -> Diagnostic {
        Diagnostic {
            message: message.into(),
            start,
            end: self.position,
        }
    }
    fn skip_space(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.advance();
        }
    }
    fn template(&mut self, argument: bool, depth: usize) -> Result<Vec<Node>, Diagnostic> {
        if depth > MAX_DEPTH {
            return Err(self.error("函数嵌套超过 64 层", self.position));
        }
        let mut nodes = Vec::new();
        let mut literal = String::new();
        while let Some(ch) = self.peek() {
            if argument && (ch.is_whitespace() || ch == '>') {
                break;
            }
            if ch == '>' {
                return Err(self.error("多余的闭合括号 >", self.position));
            }
            if matches!(ch, '*' | '?' | '<' | '\'' | '"') {
                if !literal.is_empty() {
                    nodes.push(Node::Literal(std::mem::take(&mut literal)));
                }
                match ch {
                    '*' => {
                        self.advance();
                        nodes.push(Node::Base);
                    }
                    '?' => {
                        self.advance();
                        nodes.push(Node::Extension);
                    }
                    '<' => nodes.push(self.call(depth + 1)?),
                    _ => nodes.push(Node::Literal(self.quoted()?)),
                }
            } else {
                literal.push(ch);
                self.advance();
            }
        }
        if !literal.is_empty() {
            nodes.push(Node::Literal(literal));
        }
        Ok(nodes)
    }
    fn quoted(&mut self) -> Result<String, Diagnostic> {
        let start = self.position;
        let quote = self.advance().unwrap();
        let mut text = String::new();
        while let Some(ch) = self.advance() {
            if ch == quote {
                return Ok(text);
            }
            if ch == '\\' {
                if self
                    .peek()
                    .is_some_and(|next| next == quote || next == '\\')
                {
                    text.push(self.advance().unwrap());
                    continue;
                }
            }
            text.push(ch);
        }
        Err(self.error("字符串引号未闭合", start))
    }
    fn call(&mut self, depth: usize) -> Result<Node, Diagnostic> {
        let start = self.position;
        self.advance();
        if self.peek() == Some('#') {
            self.advance();
            let digits_start = self.position;
            while self.peek().is_some_and(|ch| ch.is_ascii_digit()) {
                self.advance();
            }
            let digits = &self.source[digits_start..self.position];
            if digits.is_empty() || self.advance() != Some('>') {
                return Err(self.error("序号格式应为 <#001>，只能包含十进制数字", start));
            }
            return Ok(Node::Call {
                name: "counter".into(),
                args: vec![
                    vec![Node::Literal(digits.into())],
                    vec![Node::Literal(digits.len().to_string())],
                ],
                start,
                end: self.position,
            });
        }
        let name_start = self.position;
        while self
            .peek()
            .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            self.advance();
        }
        let name = self.source[name_start..self.position].to_owned();
        if name.is_empty() {
            return Err(self.error("缺少函数名称", start));
        }
        if self
            .peek()
            .is_some_and(|ch| !ch.is_whitespace() && ch != '>')
        {
            return Err(self.error("函数名称与参数之间需要空格", start));
        }
        let mut args = Vec::new();
        loop {
            self.skip_space();
            match self.peek() {
                Some('>') => {
                    self.advance();
                    break;
                }
                None => return Err(self.error("函数缺少闭合括号 >", start)),
                _ => args.push(self.template(true, depth)?),
            }
        }
        Ok(Node::Call {
            name,
            args,
            start,
            end: self.position,
        })
    }
}
