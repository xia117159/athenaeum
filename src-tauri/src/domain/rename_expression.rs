//! A pure, extensible rename template language. Filesystem state is supplied by the caller.
mod functions;
mod parser;
mod text;
pub use text::EvalText;

use chrono::{DateTime, FixedOffset};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

pub const MAX_EXPRESSION_BYTES: usize = 16 * 1024;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_DEPTH: usize = 64;
pub const MAX_STEPS: usize = 20_000_000;

#[derive(Debug, Clone)]
pub struct RenameContext {
    pub name: String,
    pub is_directory: bool,
    pub now: DateTime<FixedOffset>,
    pub modified: Option<DateTime<FixedOffset>>,
    pub created: Option<DateTime<FixedOffset>>,
    pub index: usize,
}

impl RenameContext {
    pub fn name_parts(&self) -> (&str, &str) {
        if !self.is_directory {
            if let Some((base, extension)) = self.name.rsplit_once('.') {
                if !base.is_empty() && !extension.is_empty() {
                    return (base, extension);
                }
            }
        }
        (&self.name, "")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub message: String,
    /// Zero-based UTF-8 byte range, end exclusive. Convert using the source for UI positions.
    pub start: usize,
    pub end: usize,
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Diagnostic {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionParameter {
    pub name: String,
    pub role: String,
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionExample {
    pub expression: String,
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub name: String,
    pub aliases: Vec<String>,
    pub parameters: Vec<FunctionParameter>,
    pub description: String,
    pub examples: Vec<FunctionExample>,
}

pub type EvalResult = Result<EvalText, String>;
pub type Evaluator = fn(&[EvalText], &mut Evaluation<'_, '_>) -> EvalResult;

/// Implementations return provenance-aware text; the parser has no builtin dispatch.
pub struct FunctionDefinition {
    pub info: FunctionInfo,
    pub evaluate: Evaluator,
}

#[derive(Default)]
pub struct FunctionRegistry {
    definitions: Vec<Arc<FunctionDefinition>>,
    lookup: HashMap<String, Arc<FunctionDefinition>>,
}

impl FunctionRegistry {
    pub fn builtins() -> Self {
        let mut registry = Self::default();
        functions::register(&mut registry);
        registry
    }

    pub fn register(&mut self, definition: FunctionDefinition) -> Result<(), String> {
        let names = std::iter::once(&definition.info.name)
            .chain(&definition.info.aliases)
            .map(|name| name.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let mut seen = std::collections::HashSet::new();
        for name in &names {
            if name.is_empty()
                || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                || !seen.insert(name)
                || self.lookup.contains_key(name)
            {
                return Err(format!("无效或重复的函数名称：{name}"));
            }
        }
        let definition = Arc::new(definition);
        for name in names {
            self.lookup.insert(name, definition.clone());
        }
        self.definitions.push(definition);
        Ok(())
    }

    pub fn catalog(&self) -> Vec<FunctionInfo> {
        self.definitions
            .iter()
            .map(|definition| definition.info.clone())
            .collect()
    }

    pub fn compile(&self, expression: &str) -> Result<CompiledExpression, Diagnostic> {
        let nodes = parser::parse(expression)?;
        Ok(CompiledExpression {
            nodes: self.bind(nodes)?,
        })
    }

    fn bind(&self, nodes: Vec<parser::Node>) -> Result<Vec<BoundNode>, Diagnostic> {
        nodes
            .into_iter()
            .map(|node| {
                Ok(match node {
                    parser::Node::Literal(text) => BoundNode::Literal(EvalText::literal(text)),
                    parser::Node::Base => BoundNode::Base,
                    parser::Node::Extension => BoundNode::Extension,
                    parser::Node::Call {
                        name,
                        args,
                        start,
                        end,
                    } => {
                        let definition = self
                            .lookup
                            .get(&name.to_ascii_lowercase())
                            .ok_or_else(|| Diagnostic {
                                message: format!("未知函数：{name}"),
                                start,
                                end,
                            })?
                            .clone();
                        let min = definition
                            .info
                            .parameters
                            .iter()
                            .filter(|p| !p.optional)
                            .count();
                        let max = definition.info.parameters.len();
                        if args.len() < min || args.len() > max {
                            return Err(Diagnostic {
                                message: format!(
                                    "{name} 需要 {min}–{max} 个参数，实际 {} 个",
                                    args.len()
                                ),
                                start,
                                end,
                            });
                        }
                        let args = args
                            .into_iter()
                            .map(|arg| self.bind(arg))
                            .collect::<Result<_, _>>()?;
                        BoundNode::Call {
                            definition,
                            args,
                            start,
                            end,
                        }
                    }
                })
            })
            .collect()
    }
}

enum BoundNode {
    Literal(EvalText),
    Base,
    Extension,
    Call {
        definition: Arc<FunctionDefinition>,
        args: Vec<Vec<BoundNode>>,
        start: usize,
        end: usize,
    },
}

pub struct CompiledExpression {
    nodes: Vec<BoundNode>,
}

pub struct Budget<'a> {
    remaining: usize,
    cancelled: &'a dyn Fn() -> bool,
}
impl<'a> Budget<'a> {
    pub fn new(cancelled: &'a dyn Fn() -> bool) -> Self {
        Self {
            remaining: MAX_STEPS,
            cancelled,
        }
    }
    pub fn charge(&mut self, steps: usize) -> Result<(), String> {
        if (self.cancelled)() {
            return Err("预览已取消".into());
        }
        self.remaining = self
            .remaining
            .checked_sub(steps)
            .ok_or("表达式计算量超限，请简化表达式")?;
        Ok(())
    }
}

pub struct Evaluation<'a, 'b> {
    pub context: &'a RenameContext,
    pub budget: &'a mut Budget<'b>,
    regex_cache: &'a mut HashMap<String, Regex>,
}
impl Evaluation<'_, '_> {
    pub fn charge(&mut self, steps: usize) -> Result<(), String> {
        self.budget.charge(steps)
    }
    pub fn regex(&mut self, pattern: &str) -> Result<Regex, String> {
        if pattern.len() > 4096 {
            return Err("正则表达式超过 4 KiB".into());
        }
        if let Some(regex) = self.regex_cache.get(pattern) {
            return Ok(regex.clone());
        }
        self.charge(pattern.len().saturating_mul(16))?;
        let regex = regex::RegexBuilder::new(pattern)
            .size_limit(2 * 1024 * 1024)
            .dfa_size_limit(2 * 1024 * 1024)
            .build()
            .map_err(|e| format!("无效正则表达式：{e}"))?;
        // Bound compiled-pattern memory even when the pattern depends on each item.
        if self.regex_cache.len() < 8 {
            self.regex_cache.insert(pattern.into(), regex.clone());
        }
        Ok(regex)
    }
}

impl CompiledExpression {
    pub fn evaluate(
        &self,
        context: &RenameContext,
        budget: &mut Budget<'_>,
        regex_cache: &mut HashMap<String, Regex>,
    ) -> Result<String, Diagnostic> {
        let mut evaluation = Evaluation {
            context,
            budget,
            regex_cache,
        };
        let output = eval_nodes(&self.nodes, &mut evaluation)?;
        if output.as_str().trim().is_empty() {
            return Err(Diagnostic {
                message: "新名称不能为空或仅包含空白".into(),
                start: 0,
                end: 0,
            });
        }
        let (_, extension) = context.name_parts();
        if !extension.is_empty() && !output.has_explicit_extension() {
            Ok(format!("{}.{extension}", output.as_str()))
        } else {
            Ok(output.into_string())
        }
    }
}

fn eval_nodes(
    nodes: &[BoundNode],
    evaluation: &mut Evaluation<'_, '_>,
) -> Result<EvalText, Diagnostic> {
    let mut output = EvalText::generated("");
    for node in nodes {
        let (start, end) = match node {
            BoundNode::Call { start, end, .. } => (*start, *end),
            _ => (0, 0),
        };
        let diagnostic = |message| Diagnostic {
            message,
            start,
            end,
        };
        evaluation.charge(1).map_err(diagnostic)?;
        let part = match node {
            BoundNode::Literal(text) => text.clone(),
            BoundNode::Base => EvalText::generated(evaluation.context.name_parts().0),
            BoundNode::Extension => EvalText::generated(evaluation.context.name_parts().1),
            BoundNode::Call {
                definition, args, ..
            } => {
                let values = args
                    .iter()
                    .map(|nodes| eval_nodes(nodes, evaluation))
                    .collect::<Result<Vec<_>, _>>()?;
                let input_bytes = values
                    .iter()
                    .map(|value| value.as_str().len())
                    .sum::<usize>();
                evaluation.charge(input_bytes).map_err(diagnostic)?;
                (definition.evaluate)(&values, evaluation).map_err(diagnostic)?
            }
        };
        evaluation.charge(part.as_str().len()).map_err(diagnostic)?;
        output.append(&part).map_err(diagnostic)?;
    }
    Ok(output)
}

#[cfg(test)]
pub fn evaluate(expression: &str, context: &RenameContext) -> Result<String, String> {
    FunctionRegistry::builtins()
        .compile(expression)
        .and_then(|compiled| {
            compiled.evaluate(context, &mut Budget::new(&|| false), &mut HashMap::new())
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests;
