use std::collections::HashMap;
use rand::SeedableRng;
use serde::Serialize;
use wasm_bindgen::prelude::*;
use maze_core::random::MazeRng;
use maze_core::{
    space::Tessellation,
    quality_control::{
        QualityControlEngine, Issue, CycleAnalysisOverflowedIssue,
        RepairLimitReachedIssue, IssuePayload, resolve_issue_payload,
    },
    compute_node_stats, compute_spatial_edge_stats, compute_teleport_edge_stats,
    graph::{Graph, EdgeKind},
    ids::IdGenerator,
    space::{Field, SquarePoint, HexPoint, TriPoint},
    Maze,
};
use crate::dto::{
    EdgeDto, EdgeKindDto, IssueDto, IssuePayloadDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto,
    NodeStatsDto, SpatialEdgeStatsDto, TeleportEdgeStatsDto, RouteInfoDto, JunctionBucket, GraphAnalyticsDto,
    ComputeAnalyticsConfig, PostEditEdgeDto,
};
use crate::generation_config::{self, GenerateConfig, TessellationType};

/// Compute analytics snapshot from a fully-built maze (GraphInput).
/// Independent of the generation pipeline — accepts any Maze<T> with a populated graph.
/// `qc_engine`: used to run quality checks (no repair). Pass None to skip QC (e.g. when
/// caller already has authoritative issues from a repair cycle).
pub fn build_analytics_snapshot<T: Tessellation>(
    maze: &mut Maze<T>,
    qc_engine: Option<&QualityControlEngine<T>>,
    issues_override: Option<Vec<Box<dyn Issue>>>,
    check_types: &HashMap<String, String>,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<MazeSnapshot, String> {
    let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let graph_analytics = maze.analysis.graph_analytics(&maze.graph, &maze.meta);

    let mut raw_issues: Vec<Box<dyn Issue>> = if let Some(i) = issues_override {
        i
    } else if let Some(engine) = qc_engine {
        // No generation seed exists on this path (the maze is already built, e.g. loaded from
        // the editor) — a fixed seed keeps a randomized check (MaxLoopDensityCheck) at least
        // deterministic per call, consistent with every other check's no-side-effects contract.
        let mut rng = MazeRng::seed_from_u64(0);
        engine.run_check_only(maze, &mut rng, maze_core::generation::pipeline::now_ms)
    } else {
        vec![]
    };
    // Not a toggleable QC check — `compute_graph_analytics` always runs, so this surfaces
    // through the same Issue/IssuesBlock UI rather than a separate ad-hoc warning (see #22
    // follow-up review): a dense, heavily preset-connected graph can exceed
    // `find_all_simple_cycles`'s `MAX_SIMPLE_CYCLES` bound and abort cycle analysis.
    if graph_analytics.cycle_analysis_overflowed {
        raw_issues.push(Box::new(CycleAnalysisOverflowedIssue::default()));
    }

    // Computed once here (before the issues map needs it for `RegionsNeedingExpansion`) and reused
    // below for `graph_analytics_dto.node_component` — cached per `graph.version()`, so the
    // second call is a cache hit, not a recomputation.
    let scc = maze.analysis.scc(&maze.graph);

    let issues: Vec<IssueDto> = raw_issues.iter().map(|issue| {
        let issue = issue.as_ref();
        let payload = match resolve_issue_payload(issue, &maze.graph, &scc) {
            IssuePayload::None => IssuePayloadDto::None,
            // Grouped by source check id (not one flat list) so a merged issue rendered as
            // several bubbles (one per `source_checks` entry) highlights only the cycles *that
            // check* flagged on hover — see `IssuePayloadDto::InvalidLoop`'s doc comment.
            IssuePayload::InvalidLoop { edges } => IssuePayloadDto::InvalidLoop { edges },
            IssuePayload::RegionNeedsExpansion { nodes } => IssuePayloadDto::RegionNeedsExpansion { nodes },
            IssuePayload::RegionNeedsShrink { nodes } => IssuePayloadDto::RegionNeedsShrink { nodes },
            IssuePayload::InvalidTeleport { groups } => IssuePayloadDto::InvalidTeleport { groups },
            IssuePayload::InvalidOneWay { groups } => IssuePayloadDto::InvalidOneWay { groups },
        };
        let source_checks = issue.source_checks().iter().map(|s| s.to_string()).collect();
        let mut details: HashMap<String, HashMap<String, String>> = issue.details().iter()
            .map(|(check_id, kv)| (
                check_id.to_string(),
                kv.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            ))
            .collect();
        // `REPAIR_LIMIT_REACHED` carries no source check (pushed directly by `build_maze`, not a
        // toggleable `Check<T, I>`), so its detail can't be keyed by a check instance id like the
        // others — keyed by the issue's own kind string instead, the only stable key available here.
        if let Some(RepairLimitReachedIssue { limit, .. }) = issue.as_any().downcast_ref::<RepairLimitReachedIssue>() {
            details.insert(issue.kind().to_string(), HashMap::from([("limit".to_string(), limit.as_str().to_string())]));
        }
        // Invariant: every key in `source_checks` has a matching entry here, no extras — both
        // come from the same composite-id set built while constructing the active checks (see
        // `build_qc_and_repair_impl`/`check_types` in `runner.rs`), not a separate pass that
        // could drift from it.
        let source_check_types: HashMap<String, String> = issue.source_checks().iter()
            .filter_map(|s| check_types.get(s).map(|t| (s.clone(), t.clone())))
            .collect();
        IssueDto { kind: issue.kind().to_string(), payload, source_checks, source_check_types, details }
    }).collect();

    let nodes: Vec<NodeDto> = maze.graph
        .nodes()
        .filter_map(|n| {
            let id = u32::try_from(n.id).ok()?;
            maze.field.point_of(n.id).map(|p| {
                let (x, y) = point_to_xy(p);
                NodeDto { id, x, y }
            })
        })
        .collect();

    let edges: Vec<EdgeDto> = maze.graph
        .edges()
        .filter_map(|e| {
            let kind = match e.kind {
                maze_core::graph::EdgeKind::Basic => EdgeKindDto::Basic,
                maze_core::graph::EdgeKind::Teleport => EdgeKindDto::Teleport,
            };
            Some(EdgeDto {
                from: u32::try_from(e.from).ok()?,
                to:   u32::try_from(e.to).ok()?,
                kind,
            })
        })
        .collect();

    let meta_start  = maze.meta.start.and_then(|id| u32::try_from(id).ok());
    let meta_finish = maze.meta.finish.and_then(|id| u32::try_from(id).ok());

    let nav_nodes: Vec<NavNodeDto> = nav.nodes.iter()
        .filter_map(|n| u32::try_from(n.node_id).ok().map(|id| NavNodeDto { node_id: id }))
        .collect();

    let nav_edges: Vec<NavEdgeDto> = nav.edges()
        .filter_map(|e| {
            let from = u32::try_from(e.from).ok()?;
            let to   = u32::try_from(e.to).ok()?;
            let path = e.path.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
            Some(NavEdgeDto { from, to, path })
        })
        .collect();

    let pure_cycle_node_ids: Vec<u32> = graph_analytics.pure_cycle_nav_nodes.iter()
        .filter_map(|&nav_id| nav.nodes.get(nav_id))
        .filter_map(|n| u32::try_from(n.node_id).ok())
        .collect();

    let pure_cycle_edge_pairs: Vec<[u32; 2]> = graph_analytics.pure_cycle_edge_indices.iter()
        .filter_map(|&idx| {
            let edge = nav.edge_by_idx(idx);
            let from_node = nav.nodes.get(edge.from)?.node_id;
            let to_node   = nav.nodes.get(edge.to)?.node_id;
            let from = u32::try_from(from_node).ok()?;
            let to   = u32::try_from(to_node).ok()?;
            Some([from, to])
        })
        .collect();

    let node_component: HashMap<String, usize> = scc.components.iter()
        .enumerate()
        .flat_map(|(comp_id, comp)| {
            comp.iter().filter_map(move |&node_id| {
                u32::try_from(node_id).ok().map(|id| (id.to_string(), comp_id))
            })
        })
        .collect();

    let region_classes: HashMap<String, String> = maze.analysis.region_classes(&maze.graph, &maze.meta).into_iter()
        .map(|(comp_id, class)| (comp_id.to_string(), class.as_str().to_string()))
        .collect();

    let graph_analytics_dto = GraphAnalyticsDto {
        node_count:        graph_analytics.node_count,
        edge_count:        graph_analytics.edge_count,
        component_count:   scc.components.len(),
        cycle_count:       graph_analytics.cycle_count,
        cycle_region_count: graph_analytics.cycle_region_count,
        node_component,
        pure_cycle_node_ids,
        pure_cycle_edge_pairs,
        cycle_analysis_overflowed: graph_analytics.cycle_analysis_overflowed,
        region_classes,
    };

    let raw_node_stats = compute_node_stats(&maze.graph, &maze.field);
    let node_stats = NodeStatsDto {
        dead_ends: raw_node_stats.dead_ends,
        straight:  raw_node_stats.straight,
        turns:     raw_node_stats.turns,
        junctions: raw_node_stats.junctions.iter()
            .map(|&(degree, count)| JunctionBucket { degree, count })
            .collect(),
        teleport_entries: raw_node_stats.teleport_entries,
    };

    let raw_edge_stats = compute_spatial_edge_stats(&maze.graph, &maze.field);
    let edge_stats = SpatialEdgeStatsDto {
        bidirectional:    raw_edge_stats.bidirectional,
        one_way_passages: raw_edge_stats.one_way_passages,
        walls:            raw_edge_stats.walls,
    };

    let raw_teleport_stats = compute_teleport_edge_stats(&maze.graph);
    let teleport_edge_stats = TeleportEdgeStatsDto {
        two_way: raw_teleport_stats.two_way,
        one_way: raw_teleport_stats.one_way,
    };

    let route_info = maze.analysis.route_info(&maze.graph, &maze.meta).map(|r| RouteInfoDto {
        path_length:    r.path_length,
        junction_count: r.junction_count,
        one_way_count:  r.one_way_count,
        score:          maze.meta.route_score,
        path:           r.path.iter().filter_map(|&id| u32::try_from(id).ok()).collect(),
    });

    Ok(MazeSnapshot {
        nodes,
        edges,
        start: meta_start,
        finish: meta_finish,
        issues,
        nav_nodes,
        nav_edges,
        node_stats,
        edge_stats,
        teleport_edge_stats,
        route_info,
        graph_analytics: graph_analytics_dto,
        timing: None,
    })
}

#[wasm_bindgen]
pub fn compute_analytics(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: ComputeAnalyticsConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    dispatch_compute_analytics(cfg)
}

fn dispatch_compute_analytics(cfg: ComputeAnalyticsConfig) -> Result<JsValue, JsValue> {
    match cfg.tessellation.tessellation_type {
        TessellationType::Square => {
            let pts: Vec<SquarePoint> = cfg.tessellation.points.iter()
                .map(|&[x, y]| SquarePoint { x, y }).collect();
            run_compute_analytics::<maze_core::space::SquareTessellation>(cfg, pts, |p: SquarePoint| (p.x, p.y))
        }
        TessellationType::Hex => {
            let pts: Vec<HexPoint> = cfg.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            run_compute_analytics::<maze_core::space::HexTessellation>(cfg, pts, |p: HexPoint| (p.q, p.r))
        }
        TessellationType::Tri => {
            let pts: Vec<TriPoint> = cfg.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            run_compute_analytics::<maze_core::space::TriTessellation>(cfg, pts, |p: TriPoint| (p.col, p.row))
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

/// Builds post-edit's passages (and read-only pass-through teleports) into `graph` — split out
/// from `run_compute_analytics` so the edge-kind matching itself can be unit-tested without a
/// `JsValue`/wasm context. "basic" adds both directions (bidirectional passage); "one_way" adds
/// only `from→to` (direction already normalized by the caller); "teleport" adds a single directed
/// `EdgeKind::Teleport` edge — a two-way teleport arrives as two separate "teleport" entries (one
/// per direction), matching how the web side extracts them 1:1 from the generated `EdgeDto` list
/// (see `extractTeleportEdges`), the same way "one_way" already represents only one direction
/// per entry unlike "basic".
fn build_graph_from_post_edit_edges(graph: &mut Graph, edges: &[PostEditEdgeDto]) -> Result<(), String> {
    for e in edges {
        let from_id = e.from as u64;
        let to_id   = e.to   as u64;
        match e.kind.as_str() {
            "basic" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
                graph.build_initial_edge(to_id, from_id, EdgeKind::Basic);
            }
            "one_way" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
            }
            "teleport" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Teleport);
            }
            other => return Err(format!("unknown edge kind: {other}")),
        }
    }
    Ok(())
}

fn run_compute_analytics<T: Tessellation + 'static>(
    cfg: ComputeAnalyticsConfig,
    pts: Vec<T::Point>,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<JsValue, JsValue>
where
    T::Point: Copy,
{
    if pts.is_empty() {
        return Err(JsValue::from_str("tessellation points must not be empty"));
    }

    let mut ids = IdGenerator::new();
    let field = Field::<T>::new(pts, &mut ids)
        .map_err(|e| JsValue::from_str(e))?;

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    build_graph_from_post_edit_edges(&mut graph, &cfg.edges)
        .map_err(|e| JsValue::from_str(&e))?;

    let mut maze = Maze::<T>::new(field, graph);
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

    let snapshot = build_analytics_snapshot(&mut maze, Some(&qc_engine), None, &check_types, point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;

    snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maze_core::space::{SquareTessellation, SquarePoint, square_rect};
    use maze_core::quality_control::CYCLE_ANALYSIS_OVERFLOWED;

    #[test]
    fn pushes_cycle_analysis_overflowed_issue_on_overflow() {
        // Same 6x6 fully-bidirectional grid as the cycles.rs/min_loop_length.rs regression
        // tests for issue #22 (2,444,782 simple cycles — far past MAX_SIMPLE_CYCLES).
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field.nodes_at(SquarePoint { x, y }).first().copied().unwrap();
                if x + 1 < SIDE {
                    let right = field.nodes_at(SquarePoint { x: x + 1, y }).first().copied().unwrap();
                    g.build_initial_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field.nodes_at(SquarePoint { x, y: y + 1 }).first().copied().unwrap();
                    g.build_initial_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(vec![]), &HashMap::new(), |p| (p.x, p.y)).unwrap();

        assert!(snapshot.graph_analytics.cycle_analysis_overflowed);
        assert!(snapshot.issues.iter().any(|i| i.kind == CYCLE_ANALYSIS_OVERFLOWED.to_string()));
    }

    #[test]
    fn no_overflow_issue_on_sparse_graph() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let b = field.nodes_at(SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
        g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(vec![]), &HashMap::new(), |p| (p.x, p.y)).unwrap();

        assert!(!snapshot.graph_analytics.cycle_analysis_overflowed);
        assert!(!snapshot.issues.iter().any(|i| i.kind == CYCLE_ANALYSIS_OVERFLOWED.to_string()));
    }

    #[test]
    fn region_classes_empty_when_start_or_finish_unset() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let b = field.nodes_at(SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
        g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        // Neither start nor finish set.

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(vec![]), &HashMap::new(), |p| (p.x, p.y)).unwrap();

        assert!(snapshot.graph_analytics.region_classes.is_empty());
    }

    #[test]
    fn region_classes_populated_when_start_and_finish_set() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let b = field.nodes_at(SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
        let c = field.nodes_at(SquarePoint { x: 2, y: 0 }).first().copied().unwrap();
        g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
        g.build_initial_bidirectional_edge(b, c, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(a);
        maze.meta.finish = Some(c);

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(vec![]), &HashMap::new(), |p| (p.x, p.y)).unwrap();

        // Fully bidirectional 3-node line collapses into a single SCC — start and finish share
        // a region, which is always "path" by definition.
        assert!(!snapshot.graph_analytics.region_classes.is_empty());
        assert!(snapshot.graph_analytics.region_classes.values().all(|c| c == "path"));
    }

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

    fn edge(from: u32, to: u32, kind: &str) -> PostEditEdgeDto {
        PostEditEdgeDto { from, to, kind: kind.to_string() }
    }

    fn graph_with_nodes(ids: &[u64]) -> Graph {
        let mut graph = Graph::new();
        for &id in ids { graph.add_node(id); }
        graph
    }

    #[test]
    fn build_graph_from_post_edit_edges_basic_adds_both_directions() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "basic")]).unwrap();
        assert!(graph.edge_between(1, 2).is_some());
        assert!(graph.edge_between(2, 1).is_some());
        assert_eq!(graph.edges().count(), 2);
    }

    #[test]
    fn build_graph_from_post_edit_edges_one_way_adds_only_forward() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "one_way")]).unwrap();
        assert!(graph.edge_between(1, 2).is_some());
        assert!(graph.edge_between(2, 1).is_none());
        assert_eq!(graph.edges().count(), 1);
    }

    #[test]
    fn build_graph_from_post_edit_edges_teleport_adds_only_forward_as_teleport_kind() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "teleport")]).unwrap();
        let e = graph.edges().find(|e| e.from == 1 && e.to == 2).expect("teleport edge must exist");
        assert_eq!(e.kind, EdgeKind::Teleport);
        assert!(graph.edge_between(2, 1).is_none(), "one \"teleport\" entry must add only one direction");
        assert_eq!(graph.edges().count(), 1);
    }

    #[test]
    fn build_graph_from_post_edit_edges_two_teleport_entries_produce_two_way_teleport() {
        // A two-way teleport is represented as two separate "teleport" entries (one per
        // direction), not a single entry that auto-adds both — mirrors how the web side
        // extracts each directed EdgeDto from generation 1:1 (see extractTeleportEdges).
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "teleport"), edge(2, 1, "teleport")]).unwrap();
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport));
        assert!(graph.edges().any(|e| e.from == 2 && e.to == 1 && e.kind == EdgeKind::Teleport));
        assert_eq!(graph.edges().count(), 2);
    }

    #[test]
    fn build_graph_from_post_edit_edges_teleport_coexists_with_parallel_basic() {
        // A Basic and a Teleport edge in the same direction between the same pair must both
        // survive — kind-aware dedup in Graph::add_edge allows this (see graph::parallel_edges_tests).
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "basic"), edge(1, 2, "teleport")]).unwrap();
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Basic));
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport));
        assert_eq!(graph.edges().count(), 3, "basic(2 directions) + teleport(1 direction) = 3 edges");
    }

    #[test]
    fn build_graph_from_post_edit_edges_unknown_kind_is_rejected() {
        let mut graph = graph_with_nodes(&[1, 2]);
        let err = build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "wall")]).unwrap_err();
        assert!(err.contains("wall"), "error must mention the offending kind, got: {err}");
    }
}
