use std::collections::HashSet;
use maze_core::{
    space::Tessellation,
    quality_control::{QualityControlEngine, RuleTrait, Stage},
};
use crate::config::GenerateConfig;
use super::qc_kind_registry::build_rule;

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

        stages.push(Stage::new(stage_cfg.id.clone(), stage_cfg.name.clone(), rules));
    }

    // Note: "rule with a strategy not assigned to any stage" can no longer happen structurally —
    // a `Rule` is built and pushed directly into the `Stage` it's configured under, there is no
    // longer a separate "all rules" list a strategy-bearing rule could fail to appear in.

    Ok(QualityControlEngine::new(stages))
}
