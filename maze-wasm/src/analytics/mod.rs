mod snapshot;
mod post_edit;

pub use snapshot::build_analytics_snapshot;

use wasm_bindgen::prelude::*;
use serde::Serialize;
use maze_core::{space::Tessellation, space::{SquarePoint, HexPoint, TriPoint}, Maze, graph::Graph};
use crate::dto::ComputeAnalyticsConfig;
use crate::generation_config::{self, GenerateConfig, TessellationType};
use post_edit::{apply_split_points, build_graph_from_post_edit_edges, build_field_from_nodes};

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

/// Wraps each analytics-only check in its own synthetic singleton rule — see the call site's
/// doc comment in `run_compute_analytics` for why. Split out so the wrapping itself (one rule
/// per check, distinct ids, no strategy) can be unit-tested without going through `JsValue`.
// Wraps every active check in its own singleton rule, all under one synthetic stage — this path
// never dispatches repair (analytics-only, `QualityControlEngine::run_check_only`, see GitHub
// issue #106), so stage granularity has no observable effect here; a single stage is the
// simplest shape satisfying `build_qc_and_repair`'s "every strategy-bearing rule must be in a
// stage" invariant (moot here, since no rule has a strategy).
fn analytics_only_stages(checks: Vec<generation_config::CheckInstanceConfig>) -> Vec<generation_config::StageConfig> {
    let rules: Vec<generation_config::QcRuleConfig> = checks.into_iter()
        .enumerate()
        .map(|(i, instance)| generation_config::QcRuleConfig {
            id: format!("analytics_only_{i}"),
            checks: vec![instance],
            strategy: None,
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
    field.build_nodes(&mut graph);

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
    let stages = analytics_only_stages(cfg.checks);
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
    let snapshot = build_analytics_snapshot(&mut maze, Some(&qc_engine), None, &check_types, point_to_xy,
        |id, _, pos| index_by_node.get(&id).copied().unwrap_or(pos as u32))
        .map_err(|e| JsValue::from_str(&e))?;

    snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn analytics_only_stages_wraps_each_check_in_its_own_singleton_rule() {
        let checks = vec![
            generation_config::CheckInstanceConfig { local_id: "a".to_string(), type_id: "missing_endpoints".to_string(), params: HashMap::new() },
            generation_config::CheckInstanceConfig { local_id: "b".to_string(), type_id: "unreachable_finish".to_string(), params: HashMap::new() },
        ];
        let stages = analytics_only_stages(checks);
        assert_eq!(stages.len(), 1, "analytics-only path uses one synthetic stage");
        let rules = &stages[0].rules;
        assert_eq!(rules.len(), 2);
        assert_ne!(rules[0].id, rules[1].id, "each synthetic rule needs a distinct id");
        for rule in rules {
            assert_eq!(rule.checks.len(), 1, "one check per synthetic rule");
            assert!(rule.strategy.is_none(), "analytics-only path never dispatches repair");
        }
    }
}
