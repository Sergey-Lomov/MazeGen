use super::check_factory::parse_cell_type_keys;
use super::qc_kind_registry::build_rule;
use crate::config::GenerateConfig;
use maze_core::{
    quality_control::{QualityControlEngine, RuleTrait, Stage},
    space::{Tessellation, cell_type_by_key},
};
use std::collections::{HashMap, HashSet};

pub fn build_qc_and_repair<T: Tessellation + 'static>(
    config: &GenerateConfig,
) -> Result<QualityControlEngine<T>, String> {
    let mut stages: Vec<Stage<T>> = Vec::new();
    let mut seen_stage_ids: HashSet<&str> = HashSet::new();
    let mut seen_rule_ids: HashSet<&str> = HashSet::new();

    for stage_cfg in &config.stages {
        if !seen_stage_ids.insert(stage_cfg.id.as_str()) {
            return Err(format!("duplicate stage id: {}", stage_cfg.id));
        }
        let mut rules: Vec<Box<dyn RuleTrait<T>>> = Vec::with_capacity(stage_cfg.rules.len());

        for rule_cfg in &stage_cfg.rules {
            if !seen_rule_ids.insert(rule_cfg.id.as_str()) {
                return Err(format!("duplicate rule id: {}", rule_cfg.id));
            }
            if rule_cfg.checks.is_empty() {
                return Err(format!("rule {} has no checks", rule_cfg.id));
            }
            rules.push(build_rule::<T>(rule_cfg)?);
        }

        stages.push(Stage::new(
            stage_cfg.id.clone(),
            stage_cfg.name.clone(),
            rules,
        ));
    }

    // Note: "rule with a strategy not assigned to any stage" can no longer happen structurally —
    // a `Rule` is built and pushed directly into the `Stage` it's configured under, there is no
    // longer a separate "all rules" list a strategy-bearing rule could fail to appear in.

    Ok(QualityControlEngine::new(stages))
}

/// Rejects a `forbid_cell_type_<key>` param whose key the built tessellation instance does not have (GitHub
/// issue #824; `Specs/space.md`'s "Cell types": an unknown key is a config error, never ignored).
/// Needs the instance, which `build_qc_and_repair` does not have, so callers run it separately.
pub fn validate_cell_type_params<T: Tessellation>(
    config: &GenerateConfig,
    tessellation: &T,
) -> Result<(), String> {
    let types = tessellation.cell_types();
    for rule_cfg in config.stages.iter().flat_map(|stage| &stage.rules) {
        for instance in &rule_cfg.checks {
            for key in parse_cell_type_keys(instance) {
                if cell_type_by_key(types, &key).is_none() {
                    let known: Vec<_> = types.iter().map(|t| t.key()).collect();
                    return Err(format!(
                        "rule {}: unknown cell type `{key}`, expected one of {known:?}",
                        rule_cfg.id
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Maps each check *instance* id (`"<rule_id>:<local_id>"`, the key issue groups are attributed
/// to) to its check *type* id — the `check_types` argument of
/// `maze_core::quality_control::resolve_issue_payload`.
pub fn build_check_types(config: &GenerateConfig) -> HashMap<String, String> {
    let mut check_types: HashMap<String, String> = HashMap::new();
    for stage_cfg in &config.stages {
        for rule_cfg in &stage_cfg.rules {
            let mut seen_local_ids: HashSet<&str> = HashSet::new();
            for instance in &rule_cfg.checks {
                if seen_local_ids.insert(instance.local_id.as_str()) {
                    let instance_id = format!("{}:{}", rule_cfg.id, instance.local_id);
                    check_types.insert(instance_id, instance.type_id.clone());
                }
            }
        }
    }
    check_types
}
