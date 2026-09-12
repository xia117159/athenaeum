use super::{
    file_associations,
    metadata_store::MetadataStore,
    settings_store::{validate_shortcuts, SettingsStore},
};
use crate::domain::models::SettingsModelUpdate;
use anyhow::{Context, Result};

/// Publish settings only after disk writes succeed. The stores are locked by the caller.
pub fn commit_model(
    metadata: &mut MetadataStore,
    settings: &mut SettingsStore,
    model: SettingsModelUpdate,
) -> Result<()> {
    validate_shortcuts(&model.shortcuts)?;
    let rules = model
        .file_associations
        .map(file_associations::normalize_rules)
        .transpose()?;
    let mut staged = settings.clone();
    staged.set_detail_columns(model.columns);
    staged.set_navigation_columns(model.navigation_columns);
    staged.set_details_row_height(model.details_row_height);
    staged.set_size_bar_mode(model.size_bar_mode);
    staged.set_folder_expansion_enabled(model.folder_expansion_enabled);
    staged.set_tooltip_hover_delay_ms(model.tooltip_hover_delay_ms);
    staged.set_metadata_retention_hours(model.metadata_retention_hours);
    staged.set_file_visibility(model.file_visibility);
    staged.set_context_menu(model.context_menu);
    staged.set_theme(model.theme);
    staged.persist()?;
    if let Err(error) = file_associations::commit_model_metadata(metadata, model.shortcuts, rules) {
        settings
            .persist()
            .context(format!("关联规则未保存：{error}；常规设置回滚也失败"))?;
        return Err(error);
    }
    *settings = staged;
    Ok(())
}

#[cfg(test)]
#[path = "settings_model_tests.rs"]
mod tests;
