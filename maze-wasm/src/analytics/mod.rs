mod snapshot;
mod post_edit;

pub use snapshot::build_analytics_snapshot;

use wasm_bindgen::prelude::*;
use serde::Serialize;
use maze_core::{space::Tessellation, space::{SquarePoint, HexPoint, TriPoint}, Maze, graph::Graph};
use crate::dto::ComputeAnalyticsConfig;
use crate::generation_config::{self, GenerateConfig, TessellationType};
use post_edit::{apply_split_points, build_graph_from_post_edit_edges, build_field_from_nodes, preset_edges_for_post_edit, resolve_preset_nodes_for_post_edit};

#[wasm_bindgen]
pub fn compute_analytics(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: ComputeAnalyticsConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    dispatch_compute_analytics(cfg)
}

fn dispatch_compute_analytics(cfg: ComputeAnalyticsConfig) -> Result<JsValue, JsValue> {
    match cfg.tessellation.tessellation_type {
        TessellationType::Square => {
            run_compute_analytics::<maze_core::space::SquareTessellation>(
                cfg,
                |p: SquarePoint| (p.x, p.y),
                |[x, y]| Some(SquarePoint { x, y }),
            )
        }
        TessellationType::Hex => {
            run_compute_analytics::<maze_core::space::HexTessellation>(
                cfg,
                |p: HexPoint| (p.q, p.r),
                |[q, r]| Some(HexPoint { q, r }),
            )
        }
        TessellationType::Tri => {
            run_compute_analytics::<maze_core::space::TriTessellation>(
                cfg,
                |p: TriPoint| (p.col, p.row),
                |[col, row]| Some(TriPoint { col, row }),
            )
        }
    }
}

/// Wraps each analytics-only rule group in its own synthetic rule — see the call site's doc
/// comment in `run_compute_analytics` for why. Split out so the wrapping itself (one synthetic
/// rule per group, distinct ids, no strategy) can be unit-tested without going through `JsValue`.
// Wraps every active rule group in its own singleton rule, all under one synthetic stage — this
// path never dispatches repair (analytics-only, `QualityControlEngine::run_check_only`, see
// GitHub issue #106), so stage granularity has no observable effect here; a single stage is the
// simplest shape satisfying `build_qc_and_repair`'s "every strategy-bearing rule must be in a
// stage" invariant (moot here, since no rule has a strategy).
//
// Grouped by the web side's real `QcRuleState` (GitHub issue #245's teleport-route-protection
// bugfix) — each `AnalyticsRuleGroupConfig.params` carries that rule's own rule-level params (e.g.
// `protect_route`) straight onto its synthetic rule (`resolve_rule_params` reads a rule's
// `params`), unlike the old flat-check-list shape where a rule-level param had no home at all and
// silently stayed at its `RuleParams::default()` regardless of what the user configured — e.g.
// disabling "protect start/finish" had no effect on `teleport_duplicates_connection` here even
// though it worked correctly on the generate path.
fn analytics_only_stages(rule_groups: Vec<crate::dto::AnalyticsRuleGroupConfig>) -> Vec<generation_config::StageConfig> {
    let rules: Vec<generation_config::QcRuleConfig> = rule_groups.into_iter()
        .enumerate()
        .map(|(i, group)| generation_config::QcRuleConfig {
            id: format!("analytics_only_{i}"),
            checks: group.checks,
            strategy: None,
            params: group.params,
        })
        .collect();
    vec![generation_config::StageConfig { id: "analytics_only_stage".to_string(), name: "Analytics".to_string(), rules }]
}

fn run_compute_analytics<T: Tessellation + 'static>(
    cfg: ComputeAnalyticsConfig,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
    xy_to_point: impl Fn([i32; 2]) -> Option<T::Point>,
) -> Result<JsValue, JsValue>
where
    T::Point: Copy,
{
    if cfg.nodes.is_empty() {
        return Err(JsValue::from_str("nodes must not be empty"));
    }

    let (field, existing_by_index, index_by_node) = build_field_from_nodes::<T>(&cfg.nodes, &xy_to_point)
        .map_err(|e| JsValue::from_str(&e))?;

    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }

    let mut maze = Maze::<T>::new(field, graph);

    // Split points must exist before edges are resolved — some edges may address a split node
    // by (point, slot_id) that only comes into being here (GitHub issue #221).
    let split_map = apply_split_points(&mut maze, xy_to_point, &cfg.split_points, &existing_by_index)
        .map_err(|e| JsValue::from_str(&e))?;

    build_graph_from_post_edit_edges(&mut maze.graph, &cfg.edges, &split_map)
        .map_err(|e| JsValue::from_str(&e))?;

    maze.meta.start  = cfg.start.map(|id| id as u64);
    maze.meta.finish = cfg.finish.map(|id| id as u64);

    // Build QC engine from config (no repair). Each active check becomes its own synthetic
    // singleton rule (id/kind discarded immediately below) — `build_qc_and_repair` is rule-driven
    // (see GitHub issue #60) and no longer accepts a flat check list, but this path has no real
    // rules of its own and never dispatches repair (see `build_analytics_snapshot`'s
    // `run_check_only` path, GitHub issue #106), so a throwaway one-check-per-rule wrapper is the
    // simplest way to satisfy that shape without rule semantics actually mattering here.
    let stages = analytics_only_stages(cfg.rule_groups);
    let qc_config = GenerateConfig {
        tessellation: cfg.tessellation,
        stages,
        ..GenerateConfig::default()
    };
    let (qc_engine, check_types) = crate::runner::build_qc_and_repair_with_types::<T>(&qc_config)
        .map_err(|e| JsValue::from_str(&e))?;

    // Reuses each node's real `i` from the client's own `cfg.nodes` where known (GitHub issue
    // #236) — falls back to position only for a node not in `cfg.nodes` at all, i.e. a split node
    // this exact call just minted via `apply_split_points`, which by construction sits at the
    // point's next free position (no hole possible for a node that never existed before this call).
    //
    // Post-edit rebuilds `Field`/`Graph` straight from the client's node/edge list, never from
    // `PresetConnection`s, so there is no `PresetState` to reuse from generation — but the
    // project's preset connections (`cfg.preset_connections`) are still sent alongside precisely
    // so their edges can be resolved fresh here and flagged `preset_locked` in the snapshot
    // (GitHub issue #245). Only `preset_edges`/`preset_declared_nodes` are populated (the rest of
    // `PresetState` — locks, teleport adjacency, etc. — has no meaning on this repair-less,
    // generation-less path). `preset_declared_nodes` here means "the preset snapshot currently
    // declares this split node", not "minted in this call" (that's the generate path's meaning) —
    // `is_preset_locked_node` doesn't care which, only membership.
    let mut preset_state = maze_core::generation::PresetState::empty();
    preset_state.preset_edges = preset_edges_for_post_edit(&cfg.preset_connections, &existing_by_index, &split_map);
    preset_state.preset_declared_nodes = resolve_preset_nodes_for_post_edit(&cfg.preset_split_points, &existing_by_index, &split_map);
    let snapshot = build_analytics_snapshot(&mut maze, Some(&qc_engine), None, &check_types, &preset_state, false, point_to_xy,
        |id, _, pos| index_by_node.get(&id).copied().unwrap_or(pos as u32))
        .map_err(|e| JsValue::from_str(&e))?;

    snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn group(checks: Vec<generation_config::CheckInstanceConfig>, params: HashMap<String, String>) -> crate::dto::AnalyticsRuleGroupConfig {
        crate::dto::AnalyticsRuleGroupConfig { checks, params }
    }

    fn check(type_id: &str) -> generation_config::CheckInstanceConfig {
        generation_config::CheckInstanceConfig { local_id: type_id.to_string(), type_id: type_id.to_string(), params: HashMap::new() }
    }

    #[test]
    fn analytics_only_stages_wraps_each_rule_group_in_its_own_singleton_rule() {
        let rule_groups = vec![
            group(vec![check("missing_endpoints")], HashMap::new()),
            group(vec![check("unreachable_finish")], HashMap::new()),
        ];
        let stages = analytics_only_stages(rule_groups);
        assert_eq!(stages.len(), 1, "analytics-only path uses one synthetic stage");
        let rules = &stages[0].rules;
        assert_eq!(rules.len(), 2);
        assert_ne!(rules[0].id, rules[1].id, "each synthetic rule needs a distinct id");
        for rule in rules {
            assert_eq!(rule.checks.len(), 1, "one check per rule group in this test");
            assert!(rule.strategy.is_none(), "analytics-only path never dispatches repair");
        }
    }

    // GitHub issue #245 regression: a rule group's own rule-level params (e.g. `protect_route`)
    // must survive onto its synthetic rule, not get dropped -- this is what let
    // `teleport_duplicates_connection`'s route protection be silently stuck at its default on the
    // post-edit path regardless of what the user actually configured.
    #[test]
    fn analytics_only_stages_carries_each_groups_rule_level_params_onto_its_synthetic_rule() {
        let mut params = HashMap::new();
        params.insert("protect_route".to_string(), "false".to_string());
        let rule_groups = vec![
            group(vec![check("teleport_duplicates_connection")], params.clone()),
            group(vec![check("missing_endpoints")], HashMap::new()),
        ];

        let stages = analytics_only_stages(rule_groups);
        let rules = &stages[0].rules;

        assert_eq!(rules[0].params.get("protect_route").map(String::as_str), Some("false"), "the first group's protect_route: false must reach its synthetic rule");
        assert!(rules[1].params.is_empty(), "a group with no rule-level params must not gain any");
    }

    // GitHub issue #245 follow-up: extends preset_locked to node/route-based split issue kinds.
    // Full-chain integration test driving the real post-edit analytics path (`preset_split_points`
    // -> `resolve_preset_nodes_for_post_edit` -> `PresetState.preset_declared_nodes` ->
    // `is_preset_locked_node` -> `IssuePayloadDto::InvalidSplitTile`) end to end, to catch a field
    // getting lost anywhere across that chain -- not just that each link is correct in isolation
    // (already covered by `post_edit.rs`'s `resolve_preset_nodes_for_post_edit_tests` and
    // `maze-core`'s own `issue_payload.rs` resolver tests).
    mod post_edit_split_node_preset_locked_integration_tests {
        use super::*;
        use maze_core::space::{SquarePoint, SquareTessellation};
        use maze_core::quality_control::{QualityControlEngine, Rule, RuleTrait, Stage, SplitNodeConnectionCountCheck, InvalidSplitNodeIssue};
        use maze_core::quality_control::checks::split_node_connection_count::{SplitNodeConnectionDirection};
        use maze_core::quality_control::Comparison;
        use crate::dto::{NodeDto, PostEditEdgeDto, PostEditEndpointDto, IssuePayloadDto};
        use crate::generation_config::PresetConnectionDto;
        use maze_runner::config::{PresetEndpointDto, PresetConnectionStateDto};
        use crate::analytics::build_analytics_snapshot;

        #[test]
        fn preset_declared_split_node_with_only_a_preset_protected_edge_reaches_the_dto_marked_preset_locked() {
            let xy_to_point = |[x, y]: [i32; 2]| Some(SquarePoint { x, y });
            let point_to_xy = |p: SquarePoint| (p.x, p.y);

            // Original nodes at (0,0) and (1,0), ids 1 and 2 -- mirrors NodeDto's real wire shape.
            let nodes = vec![
                NodeDto { id: 1, x: 0, y: 0, i: 0, level: 0 },
                NodeDto { id: 2, x: 1, y: 0, i: 0, level: 0 },
            ];
            // A split point declared at (0,0) slot 0 (not present in `nodes` yet -- freshly
            // declared by the preset snapshot, mirroring `state.presetSplitPoints`).
            let split_points = vec![(([0, 0]), 0u32)];

            let (field, existing_by_index, index_by_node) = build_field_from_nodes::<SquareTessellation>(&nodes, &xy_to_point).unwrap();
            let mut graph = Graph::new();
            for node in field.all_node_ids() { graph.add_node(node); }
            let mut maze = Maze::<SquareTessellation>::new(field, graph);
            let split_map = apply_split_points(&mut maze, xy_to_point, &split_points, &existing_by_index).unwrap();
            let split_node = split_map[&([0, 0], 0)];

            // The split node's only edge is a preset Passage to the original neighbor at (1,0).
            let edges = vec![PostEditEdgeDto {
                from: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0 },
                to: PostEditEndpointDto::Node { id: 2 },
                kind: "basic".to_string(),
            }];
            build_graph_from_post_edit_edges(&mut maze.graph, &edges, &split_map).unwrap();

            let preset_connections = vec![PresetConnectionDto {
                from: PresetEndpointDto { point: [0, 0], slot: Some(0) },
                to: PresetEndpointDto { point: [1, 0], slot: None },
                state: PresetConnectionStateDto::Passage,
            }];

            let mut preset_state = maze_core::generation::PresetState::empty();
            preset_state.preset_edges = preset_edges_for_post_edit(&preset_connections, &existing_by_index, &split_map);
            preset_state.preset_declared_nodes = resolve_preset_nodes_for_post_edit(&split_points, &existing_by_index, &split_map);
            assert!(preset_state.preset_declared_nodes.contains(&split_node), "sanity: the split node must actually be resolved as preset-declared");

            // Threshold of 2, comparison Lt, direction Any -- the split node's single connection
            // (count 1) flags it.
            let check = SplitNodeConnectionCountCheck { instance_id: "split_node_connection_count".to_string(), count: 2, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Any };
            let rule: Rule<SquareTessellation, InvalidSplitNodeIssue> = Rule::new(
                "r".to_string(),
                vec![("split_node_connection_count".to_string(), Box::new(check) as Box<dyn maze_core::quality_control::Check<SquareTessellation, InvalidSplitNodeIssue>>)],
                None,
                HashMap::new(),
                vec![],
            );
            let qc = QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![Box::new(rule) as Box<dyn RuleTrait<SquareTessellation>>])]);

            let snapshot = build_analytics_snapshot(&mut maze, Some(&qc), None, &HashMap::new(), &preset_state, false, point_to_xy,
                |id, _, pos| index_by_node.get(&id).copied().unwrap_or(pos as u32)).unwrap();

            let issue_dto = snapshot.issues.iter().find(|i| i.kind == "invalid_split_node")
                .expect("snapshot must carry the invalid_split_node issue");
            let IssuePayloadDto::InvalidSplitTile { groups } = &issue_dto.payload else {
                panic!("expected InvalidSplitTile (reused shape), got {:?}", issue_dto.payload)
            };
            let all_elements: Vec<_> = groups.values().flatten().collect();
            assert!(!all_elements.is_empty(), "payload must carry at least the flagged split node");
            assert!(all_elements.iter().any(|g| g.preset_locked && g.tiles.iter().any(|t| t.nodes == vec![split_node as u32])),
                "the preset-declared split node with a fully preset-protected edge must reach the DTO marked preset_locked");
        }
    }
}
