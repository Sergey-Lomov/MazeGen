use std::collections::{HashMap, HashSet};
use maze_core::{
    space::Tessellation,
    quality_control::{
        QualityControlEngine, RuleTrait, Rule, Stage,
        MissingEndpointsIssue, UnreachableFinishIssue, MissingLoopsIssue, InvalidLoopIssue,
        InvalidLoopGroupIssue,
        ExcessiveSccCountIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue, MissingRegionsIssue,
        InvalidTeleportIssue, InvalidTeleportGroupIssue, InvalidOneWayIssue, InvalidOneWayGroupIssue,
        MissingOneWaysIssue, MissingTeleportsIssue,
    },
};
use crate::config::GenerateConfig;
use super::check_factory::{
    KindTag, check_kind_for_type, composite_check_id,
    build_missing_endpoints_check, build_unreachable_finish_check, build_missing_loops_check,
    build_invalid_loop_check, build_invalid_loop_group_check, build_excessive_scc_count_check, build_region_needs_expansion_check,
    build_region_needs_shrink_check,
    build_missing_regions_check, build_invalid_teleport_check, build_teleport_group_proximity_check,
    build_invalid_one_way_check, build_one_way_group_proximity_check, build_missing_one_ways_check,
    build_missing_teleports_check,
};
use super::strategy_factory::{build_strategy_erased, downcast_strategy, build_nested};

/// Generates the common body for one `KindTag` arm of `build_rule::<T>`: collects `rule_cfg`'s
/// checks via `$check_ctor` (erroring if any `type_id` doesn't belong to this arm's `I`, i.e.
/// `$check_ctor` returns `None` — the runtime equivalent of the old "checks in rule produce
/// different issue kinds" check, except now a mismatched check simply can't be constructed as
/// `Check<T, I>` for this arm's `I` in the first place), resolves the top-level strategy (if any)
/// via `build_strategy_erased` + `downcast_strategy::<T, $IssueTy>`, and constructs `Rule::<T,
/// $IssueTy>::new(...)` — wrapped in `Box::new(...) as Box<dyn RuleTrait<T>>` for the caller's
/// `Vec<Box<dyn RuleTrait<T>>>`. See GitHub issue #113's plan §9 for why this can't be a plain
/// generic function (the concrete `$IssueTy` must be chosen by the macro caller's own match arm,
/// not passed as a runtime value).
macro_rules! build_rule_for {
    ($IssueTy:ty, $check_ctor:ident, $rule_cfg:expr) => {{
        let rule_cfg = $rule_cfg;
        let mut checks: Vec<(String, Box<dyn maze_core::quality_control::Check<T, $IssueTy>>)> = Vec::with_capacity(rule_cfg.checks.len());
        let mut seen_local_ids: HashSet<&str> = HashSet::new();
        for instance in &rule_cfg.checks {
            if !seen_local_ids.insert(instance.local_id.as_str()) {
                return Err(format!("rule {} has duplicate local_id: {}", rule_cfg.id, instance.local_id));
            }
            let instance_id = composite_check_id(&rule_cfg.id, &instance.local_id);
            let check = $check_ctor::<T>(instance, instance_id)
                .ok_or_else(|| format!("checks in rule {} produce different issue kinds", rule_cfg.id))?;
            checks.push((instance.local_id.clone(), check));
        }

        let (strategy, param_overrides, nested) = match &rule_cfg.strategy {
            Some(strategy_cfg) => {
                if strategy_cfg.slot_id.is_some() {
                    return Err(format!("rule {}'s top-level strategy must not declare slot_id", rule_cfg.id));
                }
                let erased = build_strategy_erased::<T>(&strategy_cfg.id)?;
                let nested = build_nested::<T>(erased.as_ref(), &strategy_cfg.nested)?;
                let typed = downcast_strategy::<T, $IssueTy>(erased)?;
                (Some(typed), strategy_cfg.params.clone(), nested)
            }
            None => (None, HashMap::new(), Vec::new()),
        };

        let rule = Rule::<T, $IssueTy>::new(rule_cfg.id.clone(), checks, strategy, param_overrides, nested);
        Ok(Box::new(rule) as Box<dyn RuleTrait<T>>)
    }};
}

/// Builds one `Box<dyn RuleTrait<T>>` from a `QcRuleConfig` — dispatches on the first check's
/// `type_id` (via `check_kind_for_type`) to pick which `KindTag`, and therefore which concrete
/// `I`, this rule's checks/strategy share; see `build_rule_for!`'s own doc comment for what each
/// arm does. `rule_cfg.checks` must be non-empty (checked by the caller, `build_qc_and_repair`).
fn build_rule<T: Tessellation + 'static>(rule_cfg: &crate::config::QcRuleConfig) -> Result<Box<dyn RuleTrait<T>>, String> {
    match check_kind_for_type(&rule_cfg.checks[0].type_id) {
        KindTag::MissingEndpoints => build_rule_for!(MissingEndpointsIssue, build_missing_endpoints_check, rule_cfg),
        KindTag::UnreachableFinish => build_rule_for!(UnreachableFinishIssue, build_unreachable_finish_check, rule_cfg),
        KindTag::MissingLoops => build_rule_for!(MissingLoopsIssue, build_missing_loops_check, rule_cfg),
        KindTag::InvalidLoop => build_rule_for!(InvalidLoopIssue, build_invalid_loop_check, rule_cfg),
        KindTag::InvalidLoopGroup => build_rule_for!(InvalidLoopGroupIssue, build_invalid_loop_group_check, rule_cfg),
        KindTag::ExcessiveSccCount => build_rule_for!(ExcessiveSccCountIssue, build_excessive_scc_count_check, rule_cfg),
        KindTag::RegionNeedsExpansion => build_rule_for!(RegionNeedsExpansionIssue, build_region_needs_expansion_check, rule_cfg),
        KindTag::RegionNeedsShrink => build_rule_for!(RegionNeedsShrinkIssue, build_region_needs_shrink_check, rule_cfg),
        KindTag::MissingRegions => build_rule_for!(MissingRegionsIssue, build_missing_regions_check, rule_cfg),
        KindTag::InvalidTeleport => build_rule_for!(InvalidTeleportIssue, build_invalid_teleport_check, rule_cfg),
        KindTag::InvalidTeleportGroup => build_rule_for!(InvalidTeleportGroupIssue, build_teleport_group_proximity_check, rule_cfg),
        KindTag::InvalidOneWay => build_rule_for!(InvalidOneWayIssue, build_invalid_one_way_check, rule_cfg),
        KindTag::InvalidOneWayGroup => build_rule_for!(InvalidOneWayGroupIssue, build_one_way_group_proximity_check, rule_cfg),
        KindTag::MissingOneWays => build_rule_for!(MissingOneWaysIssue, build_missing_one_ways_check, rule_cfg),
        KindTag::MissingTeleports => build_rule_for!(MissingTeleportsIssue, build_missing_teleports_check, rule_cfg),
    }
}

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
