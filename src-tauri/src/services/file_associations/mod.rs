mod arguments;
mod persistence;
pub mod programs;
mod rules;
pub use arguments::file_arguments;
pub use persistence::commit_model_metadata;
pub use rules::{matches, normalize_rules};
#[cfg(test)]
use rules::{parse_extensions, validate_rule};

#[cfg(test)]
mod persistence_tests;
#[cfg(test)]
mod program_tests;
#[cfg(test)]
mod tests;
