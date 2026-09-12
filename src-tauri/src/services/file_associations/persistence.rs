use crate::{
    domain::models::{FileAssociationRule, ShortcutBinding},
    services::metadata_store::MetadataStore,
};
use anyhow::Result;

pub fn commit_model_metadata(
    store: &mut MetadataStore,
    shortcuts: Vec<ShortcutBinding>,
    rules: Option<Vec<FileAssociationRule>>,
) -> Result<()> {
    let mut staged = store.clone();
    staged.set_shortcuts(shortcuts);
    if let Some(rules) = rules {
        staged.file_associations = super::normalize_rules(rules)?;
    }
    staged.persist()?;
    *store = staged;
    Ok(())
}
