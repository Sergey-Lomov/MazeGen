//! Single declarative source of truth for `check type_id -> KindTag -> (Issue type, builder)` —
//! see GitHub issue #407. Before this module, the same fact was hand-maintained three times:
//! the `KindTag` enum, `check_kind_for_type`'s `type_id => KindTag` match, and `build_rule`'s
//! `KindTag => build_rule_for!(...)` dispatch match, all three required to stay in lockstep by
//! hand (the class of gap GitHub issue #405 hit — a check id present in the wasm catalog but
//! missing from `check_kind_for_type`). `qc_kind_registry!` generates all three from one table.
//!
//! `codegen/src/quality_i18n.rs::find_missing_check_factory` text-scans this file's table
//! invocation (the `qc_kind_registry!` call below the macro's own definition) for `"<id>"`
//! literals — keep every check id spelled out as a string literal inside that invocation (not
//! built up programmatically) so that scan keeps working.

use std::collections::{HashMap, HashSet};
use maze_core::{
    space::Tessellation,
    quality_control::{
        RuleTrait, Rule,
        MissingEndpointsIssue, UnreachableFinishIssue, MissingLoopsIssue, InvalidLoopIssue,
        InvalidLoopGroupIssue,
        ExcessiveSccCountIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue, MissingRegionsIssue,
        InvalidTeleportIssue, InvalidTeleportGroupIssue, InvalidOneWayIssue, InvalidOneWayGroupIssue,
        MissingOneWaysIssue, MissingTeleportsIssue, InvalidSplitTileIssue, InvalidSplitTileGroupIssue,
        MissingSplitTilesIssue, InvalidSplitNodeIssue, InvalidSplitNodeConnectionGroupIssue,
        InvalidSplitNodeGroupIssue, InvalidSplitRouteIssue,
        MissingVerticalPassagesIssue, InvalidVerticalPassageGroupIssue,
        InvalidElevatorIssue, InvalidElevatorGroupIssue,
        InvalidElevatorStopGroupIssue,
    },
};
use super::check_factory::{
    composite_check_id,
    build_missing_endpoints_check, build_unreachable_finish_check, build_missing_loops_check,
    build_invalid_loop_check, build_invalid_loop_group_check, build_excessive_scc_count_check, build_region_needs_expansion_check,
    build_region_needs_shrink_check,
    build_missing_regions_check, build_invalid_teleport_check, build_teleport_group_proximity_check,
    build_invalid_one_way_check, build_one_way_group_proximity_check, build_missing_one_ways_check,
    build_missing_teleports_check, build_invalid_split_tile_check, build_split_group_check,
    build_missing_split_tiles_check, build_invalid_split_node_check, build_split_node_connection_group_check,
    build_split_node_group_check, build_invalid_split_route_check,
    build_missing_vertical_passages_check, build_invalid_vertical_passage_group_check,
    build_invalid_elevator_check, build_invalid_elevator_group_check, build_invalid_elevator_stop_group_check,
};
use super::strategy_factory::{build_strategy_erased, downcast_strategy, build_nested};
use super::rule_params::resolve_rule_params;

/// Generates the common body for one registry entry's `build_rule` arm: collects `rule_cfg`'s
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
        let rule_params = resolve_rule_params(&rule_cfg.params)
            .map_err(|e| format!("rule {}: {e}", rule_cfg.id))?;
        let mut checks: Vec<(String, Box<dyn maze_core::quality_control::Check<T, $IssueTy>>)> = Vec::with_capacity(rule_cfg.checks.len());
        let mut seen_local_ids: HashSet<&str> = HashSet::new();
        for instance in &rule_cfg.checks {
            if !seen_local_ids.insert(instance.local_id.as_str()) {
                return Err(format!("rule {} has duplicate local_id: {}", rule_cfg.id, instance.local_id));
            }
            if let Some(param_id) = instance.params.keys().find(|k| maze_core::quality_control::rule_param_applies_to(k, &instance.type_id)) {
                return Err(format!(
                    "check {} ({}) in rule {} has a local \"{param_id}\" param — {param_id} is a rule-level parameter (GitHub issue #253), configure it on the rule instead",
                    instance.local_id, instance.type_id, rule_cfg.id,
                ));
            }
            let instance_id = composite_check_id(&rule_cfg.id, &instance.local_id);
            let check = $check_ctor::<T>(instance, instance_id, &rule_params)
                .ok_or_else(|| format!("checks in rule {} produce different issue kinds", rule_cfg.id))?;
            checks.push((instance.local_id.clone(), check));
        }

        let (strategy, param_overrides, nested) = match &rule_cfg.strategy {
            Some(strategy_cfg) => {
                if strategy_cfg.slot_id.is_some() {
                    return Err(format!("rule {}'s top-level strategy must not declare slot_id", rule_cfg.id));
                }
                let erased = build_strategy_erased::<T>(&strategy_cfg.id, &strategy_cfg.params, &rule_params)?;
                let nested = build_nested::<T>(erased.as_ref(), &strategy_cfg.nested, &rule_params)?;
                let typed = downcast_strategy::<T, $IssueTy>(erased)?;
                (Some(typed), strategy_cfg.params.clone(), nested)
            }
            None => (None, HashMap::new(), Vec::new()),
        };

        let rule = Rule::<T, $IssueTy>::new(rule_cfg.id.clone(), checks, strategy, param_overrides, nested);
        Ok(Box::new(rule) as Box<dyn RuleTrait<T>>)
    }};
}

/// Declares the whole `KindTag` table in one place: `Variant => IssueTy, build_fn, [type_ids...]`.
/// Generates `KindTag`, `check_kind_for_type` (`type_id -> KindTag`), and `build_rule` (dispatches
/// on the first check's `type_id` to pick which `KindTag`, and therefore which concrete `I`, this
/// rule's checks/strategy share, then expands `build_rule_for!` for that `IssueTy`/`build_fn`
/// pair — the `build_rule_for!` expansion is what makes the `IssueTy <-> build_fn` pairing
/// compile-time checked: a mismatched pair fails to typecheck here, not at some later call site).
macro_rules! qc_kind_registry {
    ($($Variant:ident => $IssueTy:ty, $build_fn:ident, [$($type_id:literal),+ $(,)?]);+ $(;)?) => {
        /// One tag per concrete `Issue` type — the compile-time-known "which `I`" a rule's
        /// checks/strategy share, chosen at runtime from the first check's `type_id` (via
        /// `check_kind_for_type`) and then used to pick a `build_rule_for!` macro arm, which
        /// fixes `I` for the rest of that rule's construction. Not `IssueKind` itself: `IssueKind`
        /// is the runtime-erased representation (config/DTO/serialization, see GitHub issue
        /// #113's plan §2); `KindTag` exists purely to drive this registry's dispatch.
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub(crate) enum KindTag {
            $($Variant),+
        }

        pub(crate) fn check_kind_for_type(type_id: &str) -> KindTag {
            match type_id {
                $( $($type_id => KindTag::$Variant,)+ )+
                other => panic!("unknown check type_id: {other}"),
            }
        }

        /// Builds one `Box<dyn RuleTrait<T>>` from a `QcRuleConfig` — dispatches on the first
        /// check's `type_id` (via `check_kind_for_type`) to pick which `KindTag`, and therefore
        /// which concrete `I`, this rule's checks/strategy share. `rule_cfg.checks` must be
        /// non-empty (checked by the caller, `build_qc_and_repair`).
        pub(crate) fn build_rule<T: Tessellation + 'static>(rule_cfg: &crate::config::QcRuleConfig) -> Result<Box<dyn RuleTrait<T>>, String> {
            match check_kind_for_type(&rule_cfg.checks[0].type_id) {
                $( KindTag::$Variant => build_rule_for!($IssueTy, $build_fn, rule_cfg), )+
            }
        }
    };
}

qc_kind_registry! {
    MissingEndpoints => MissingEndpointsIssue, build_missing_endpoints_check, ["missing_endpoints"];
    UnreachableFinish => UnreachableFinishIssue, build_unreachable_finish_check, ["unreachable_finish"];
    MissingLoops => MissingLoopsIssue, build_missing_loops_check, ["min_loops_count", "min_loop_density"];
    InvalidLoop => InvalidLoopIssue, build_invalid_loop_check, [
        "loop_length", "external_escape_diversity", "loop_distance_from_start", "loop_distance_from_finish"
    ];
    InvalidLoopGroup => InvalidLoopGroupIssue, build_invalid_loop_group_check, ["max_loop_density", "max_loops_count"];
    ExcessiveSccCount => ExcessiveSccCountIssue, build_excessive_scc_count_check, ["scc_count"];
    RegionNeedsExpansion => RegionNeedsExpansionIssue, build_region_needs_expansion_check, ["min_region_size", "min_region_ratio"];
    RegionNeedsShrink => RegionNeedsShrinkIssue, build_region_needs_shrink_check, ["max_region_size", "max_region_ratio"];
    MissingRegions => MissingRegionsIssue, build_missing_regions_check, ["min_region_count"];
    InvalidTeleport => InvalidTeleportIssue, build_invalid_teleport_check, [
        "teleport_duplicates_connection", "teleport_waypoint_distance", "teleport_geometric_length",
        "teleport_graph_distance", "teleport_super_hub_avoidance", "teleport_split_intersection"
    ];
    InvalidTeleportGroup => InvalidTeleportGroupIssue, build_teleport_group_proximity_check, ["teleport_group_proximity"];
    InvalidOneWay => InvalidOneWayIssue, build_invalid_one_way_check, ["one_way_waypoint_distance"];
    InvalidOneWayGroup => InvalidOneWayGroupIssue, build_one_way_group_proximity_check, [
        "one_way_group_geometric_proximity", "one_way_group_graph_proximity", "one_way_group_super_hub",
        "max_one_way_count", "max_one_way_ratio"
    ];
    MissingOneWays => MissingOneWaysIssue, build_missing_one_ways_check, ["min_one_way_count", "min_one_way_ratio"];
    MissingTeleports => MissingTeleportsIssue, build_missing_teleports_check, ["min_teleport_count", "min_teleport_ratio"];
    InvalidSplitTile => InvalidSplitTileIssue, build_invalid_split_tile_check, [
        "split_distance_from_waypoint", "split_teleport_intersection"
    ];
    InvalidSplitTileGroup => InvalidSplitTileGroupIssue, build_split_group_check, [
        "max_split_count", "max_split_density", "split_group_geometric_proximity", "split_group_graph_proximity"
    ];
    MissingSplitTiles => MissingSplitTilesIssue, build_missing_split_tiles_check, ["split_count", "split_density"];
    InvalidSplitNode => InvalidSplitNodeIssue, build_invalid_split_node_check, ["split_node_connection_count"];
    InvalidSplitNodeConnectionGroup => InvalidSplitNodeConnectionGroupIssue, build_split_node_connection_group_check, [
        "split_node_connection_per_neighbor", "split_node_connection_per_face"
    ];
    InvalidSplitNodeGroup => InvalidSplitNodeGroupIssue, build_split_node_group_check, ["max_split_tile_node_count"];
    InvalidSplitRoute => InvalidSplitRouteIssue, build_invalid_split_route_check, ["split_node_connection_traversal_distance"];
    MissingVerticalPassages => MissingVerticalPassagesIssue, build_missing_vertical_passages_check, [
        "min_vertical_passage_count", "min_vertical_passage_ratio"
    ];
    InvalidVerticalPassageGroup => InvalidVerticalPassageGroupIssue, build_invalid_vertical_passage_group_check, [
        "max_vertical_passage_count", "max_vertical_passage_ratio",
        "vertical_passage_group_geometric_proximity", "vertical_passage_group_graph_proximity"
    ];
    InvalidElevator => InvalidElevatorIssue, build_invalid_elevator_check, ["elevator_stop_count", "elevator_span"];
    InvalidElevatorGroup => InvalidElevatorGroupIssue, build_invalid_elevator_group_check, ["max_elevator_count", "max_elevator_density"];
    InvalidElevatorStopGroup => InvalidElevatorStopGroupIssue, build_invalid_elevator_stop_group_check, ["max_elevator_stops", "max_elevator_stops_per_floor", "elevator_stops_skip", "elevator_stops_span"];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[should_panic(expected = "unknown check type_id: not_a_real_check")]
    fn unknown_type_id_panics() {
        check_kind_for_type("not_a_real_check");
    }

    #[test]
    fn known_type_id_resolves() {
        assert_eq!(check_kind_for_type("missing_endpoints"), KindTag::MissingEndpoints);
        assert_eq!(check_kind_for_type("min_loop_density"), KindTag::MissingLoops);
        assert_eq!(check_kind_for_type("max_elevator_density"), KindTag::InvalidElevatorGroup);
    }
}
