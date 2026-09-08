use std::{collections::HashSet, sync::Arc};

use tauri::{AppHandle, Emitter, State};

use crate::{
    domain::color_filter::{
        color_rule_schema_version, ColorFilterConfigSnapshot, ColorFilterMutationResult,
        ColorFilterValidationResult, ColorRule, ColorRuleInput, ReplaceColorRulesRequest,
        ReplaceColorRulesResult,
    },
    services::{
        color_filter::{
            text_comparison_count, validate_expression, validate_expression_storage_limits,
            MAX_COLOR_FILTER_TEXT_SCAN_BUDGET, MAX_COLOR_RULE_COUNT, MAX_COLOR_RULE_NAME_SCALARS,
        },
        metadata_store::MetadataStore,
        AppState,
    },
};

const COLOR_FILTER_CHANGED_EVENT: &str = "color-filter-changed";

fn emit_changed_with(mut emit: impl FnMut() -> Result<(), String>) -> Vec<String> {
    match emit() {
        Ok(()) => Vec::new(),
        Err(error) => vec![format!("failed to emit color filter change: {error}")],
    }
}

fn emit_changed(app: &AppHandle, snapshot: &ColorFilterConfigSnapshot) -> Vec<String> {
    let warnings = emit_changed_with(|| {
        app.emit(COLOR_FILTER_CHANGED_EVENT, snapshot)
            .map_err(|error| error.to_string())
    });
    for warning in &warnings {
        eprintln!("warning: {warning}");
    }
    warnings
}

pub(crate) fn set_enabled_in_store(
    metadata: &mut MetadataStore,
    enabled: bool,
) -> Result<ColorFilterConfigSnapshot, String> {
    if metadata.color_filter_enabled == enabled {
        return Ok(metadata.color_filter_snapshot());
    }
    let mut staged = metadata.clone();
    staged.color_filter_enabled = enabled;
    if !staged.color_rules_migration_dirty() {
        staged
            .increment_color_revisions(false)
            .map_err(|error| error.to_string())?;
    }
    staged.persist().map_err(|error| error.to_string())?;
    *metadata = staged;
    Ok(metadata.color_filter_snapshot())
}

pub(crate) fn replace_rules_in_store(
    metadata: &mut MetadataStore,
    request: ReplaceColorRulesRequest,
) -> Result<ReplaceColorRulesResult, String> {
    if !request.force && request.base_rules_revision != metadata.color_rules_revision {
        return Ok(ReplaceColorRulesResult::Conflict {
            snapshot: metadata.color_filter_snapshot(),
            warnings: Vec::new(),
        });
    }
    let rules = normalize_inputs(metadata, request.rules)?;
    let mut staged = metadata.clone();
    staged.color_rules = rules;
    if !staged.color_rules_migration_dirty() {
        staged
            .increment_color_revisions(true)
            .map_err(|error| error.to_string())?;
    }
    staged.persist().map_err(|error| error.to_string())?;
    *metadata = staged;
    Ok(ReplaceColorRulesResult::Applied {
        snapshot: metadata.color_filter_snapshot(),
        warnings: Vec::new(),
    })
}

fn normalize_inputs(
    metadata: &MetadataStore,
    inputs: Vec<ColorRuleInput>,
) -> Result<Vec<ColorRule>, String> {
    if inputs.len() > MAX_COLOR_RULE_COUNT {
        return Err(format!("color rule count exceeds {MAX_COLOR_RULE_COUNT}"));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let rules = inputs
        .into_iter()
        .enumerate()
        .map(|(index, input)| {
            let id = input.id.trim().to_string();
            let name = input.name.trim().to_string();
            if id.is_empty() || !ids.insert(id.clone()) {
                return Err(format!(
                    "color rule {} has an empty or duplicate id",
                    index + 1
                ));
            }
            if name.is_empty() {
                return Err(format!(
                    "color rule {} has an empty name",
                    index + 1
                ));
            }
            if name.chars().count() > MAX_COLOR_RULE_NAME_SCALARS {
                return Err(format!(
                    "color rule {} name exceeds {MAX_COLOR_RULE_NAME_SCALARS} Unicode scalar values",
                    index + 1
                ));
            }
            if !names.insert(name.to_lowercase()) {
                return Err(format!("color rule {} has a duplicate name", index + 1));
            }
            validate_color(input.foreground_color_hex.as_deref())?;
            validate_color(input.background_color_hex.as_deref())?;
            validate_expression_storage_limits(&input.expression)?;
            let validation = validate_expression(&input.expression);
            if input.enabled && !validation.valid {
                return Err(validation.message.unwrap_or_else(|| {
                    format!("color rule {} has an invalid expression", index + 1)
                }));
            }
            if input.enabled
                && input.foreground_color_hex.is_none()
                && input.background_color_hex.is_none()
            {
                return Err(format!("enabled color rule {} requires a color", index + 1));
            }
            let preserved_migration = metadata
                .color_rules
                .iter()
                .find(|rule| rule.id == id && editable_fields_equal(rule, &input));
            Ok(ColorRule {
                schema_version: color_rule_schema_version(),
                id,
                name,
                enabled: input.enabled,
                target: input.target,
                expression: input.expression,
                case_sensitive: input.case_sensitive,
                foreground_color_hex: input
                    .foreground_color_hex
                    .map(|value| value.to_ascii_lowercase()),
                background_color_hex: input
                    .background_color_hex
                    .map(|value| value.to_ascii_lowercase()),
                priority: index as u32 + 1,
                migration_diagnostic: preserved_migration
                    .and_then(|rule| rule.migration_diagnostic.clone()),
                migration_source: preserved_migration
                    .and_then(|rule| rule.migration_source.clone()),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let text_scan_cost = rules
        .iter()
        .filter(|rule| rule.enabled)
        .try_fold(0_usize, |total, rule| {
            text_comparison_count(&rule.expression).map(|count| total + count)
        })?;
    if text_scan_cost > MAX_COLOR_FILTER_TEXT_SCAN_BUDGET {
        return Err(format!(
            "enabled Name/Extension/Path comparisons exceed the aggregate limit of {MAX_COLOR_FILTER_TEXT_SCAN_BUDGET}"
        ));
    }
    Ok(rules)
}

fn editable_fields_equal(rule: &ColorRule, input: &ColorRuleInput) -> bool {
    rule.name == input.name
        && rule.enabled == input.enabled
        && rule.target == input.target
        && rule.expression == input.expression
        && rule.case_sensitive == input.case_sensitive
        && rule.foreground_color_hex == input.foreground_color_hex
        && rule.background_color_hex == input.background_color_hex
}

fn validate_color(value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|value| {
        value.len() != 7
            || !value.starts_with('#')
            || !value[1..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
    }) {
        return Err("color must use #RRGGBB".into());
    }
    Ok(())
}

#[tauri::command]
pub fn set_color_filter_enabled(
    enabled: bool,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<ColorFilterMutationResult, String> {
    let snapshot = set_enabled_in_store(
        &mut state.metadata.write().expect("metadata lock poisoned"),
        enabled,
    )?;
    let warnings = emit_changed(&app, &snapshot);
    Ok(ColorFilterMutationResult { snapshot, warnings })
}

#[tauri::command]
pub fn replace_color_rules(
    request: ReplaceColorRulesRequest,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<ReplaceColorRulesResult, String> {
    let mut result = replace_rules_in_store(
        &mut state.metadata.write().expect("metadata lock poisoned"),
        request,
    )?;
    if let ReplaceColorRulesResult::Applied { snapshot, warnings } = &mut result {
        *warnings = emit_changed(&app, snapshot);
    }
    Ok(result)
}

#[tauri::command]
pub fn validate_color_filter_rule(expression: String) -> ColorFilterValidationResult {
    validate_expression(&expression)
}

#[cfg(test)]
mod tests;
