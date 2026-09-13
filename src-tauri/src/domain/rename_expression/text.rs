use super::MAX_TEXT_BYTES;
use std::ops::Range;

/// Byte offsets only mark literal dots that survived evaluation, never guessed suffixes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalText {
    text: String,
    explicit_dot_offsets: Vec<usize>,
}

impl EvalText {
    pub fn literal(text: impl Into<String>) -> Self {
        let text = text.into();
        let explicit_dot_offsets = text.match_indices('.').map(|(index, _)| index).collect();
        Self {
            text,
            explicit_dot_offsets,
        }
    }
    pub fn generated(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            explicit_dot_offsets: Vec::new(),
        }
    }
    pub fn as_str(&self) -> &str {
        &self.text
    }
    pub fn into_string(self) -> String {
        self.text
    }
    pub fn has_explicit_extension(&self) -> bool {
        self.text.rfind('.').is_some_and(|offset| {
            offset > 0
                && offset + 1 < self.text.len()
                && self.explicit_dot_offsets.binary_search(&offset).is_ok()
        })
    }
    pub fn append(&mut self, other: &Self) -> Result<(), String> {
        if self.text.len().saturating_add(other.text.len()) > MAX_TEXT_BYTES {
            return Err("表达式输出超过 64 KiB".into());
        }
        let offset = self.text.len();
        self.explicit_dot_offsets.extend(
            other
                .explicit_dot_offsets
                .iter()
                .map(|index| offset + index),
        );
        self.text.push_str(&other.text);
        Ok(())
    }
    /// Callers obtain byte ranges from char boundaries or regex matches.
    pub fn slice(&self, range: Range<usize>) -> Self {
        Self {
            text: self.text[range.clone()].to_owned(),
            explicit_dot_offsets: self
                .explicit_dot_offsets
                .iter()
                .copied()
                .filter(|offset| range.contains(offset))
                .map(|offset| offset - range.start)
                .collect(),
        }
    }
    pub fn change_case(&self, upper: bool) -> Result<Self, String> {
        let text = if upper {
            self.text.to_uppercase()
        } else {
            self.text.to_lowercase()
        };
        if text.len() > MAX_TEXT_BYTES {
            return Err("表达式输出超过 64 KiB".into());
        }
        let explicit_dot_offsets = self
            .text
            .match_indices('.')
            .zip(text.match_indices('.'))
            .filter(|((before, _), _)| self.explicit_dot_offsets.binary_search(before).is_ok())
            .map(|(_, (after, _))| after)
            .collect();
        Ok(Self {
            text,
            explicit_dot_offsets,
        })
    }
}
