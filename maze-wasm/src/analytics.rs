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
    ComputeAnalyticsConfig, PostEditEdgeDto, PostEditEndpointDto,
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

    // Iterates via `Field::all_points`/`nodes_at` (deterministic order — see their doc comments),
    // not `maze.graph.nodes()` (insertion-order, an implementation detail) — GitHub issue #221:
    // this makes "which node of a split point comes first in the snapshot" a real contract (the
    // point's original node, then each `add_node_at` in creation order), which the web-side
    // controller relies on to tell a point's original node apart from its extra split nodes.
    //
    // `all_points()` yields one entry per *NodeId* (see its doc comment), not per unique point —
    // for a split point with N nodes it repeats that point N times. Deduping by point here (first
    // occurrence wins, `all_points()`'s NodeId-sorted order is preserved) is required so
    // `nodes_at(p)` isn't flat-mapped once per repeat, which would emit a split point's node list
    // N times over (GitHub issue #223 surfaced this once split-junction rendering started reading
    // every node of a point instead of just one).
    let mut seen_points: std::collections::HashSet<T::Point> = std::collections::HashSet::new();
    let nodes: Vec<NodeDto> = maze.field
        .all_points()
        .filter(|p| seen_points.insert(*p))
        .flat_map(|p| maze.field.nodes_at(p).iter().map(move |&id| (id, p)))
        .filter_map(|(id, p)| {
            let id32 = u32::try_from(id).ok()?;
            let (x, y) = point_to_xy(p);
            Some(NodeDto { id: id32, x, y })
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
            run_compute_analytics::<maze_core::space::SquareTessellation>(
                cfg, pts,
                |p: SquarePoint| (p.x, p.y),
                |[x, y]| Some(SquarePoint { x, y }),
            )
        }
        TessellationType::Hex => {
            let pts: Vec<HexPoint> = cfg.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            run_compute_analytics::<maze_core::space::HexTessellation>(
                cfg, pts,
                |p: HexPoint| (p.q, p.r),
                |[q, r]| Some(HexPoint { q, r }),
            )
        }
        TessellationType::Tri => {
            let pts: Vec<TriPoint> = cfg.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            run_compute_analytics::<maze_core::space::TriTessellation>(
                cfg, pts,
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

/// Resolves one `PostEditEndpointDto` to a real `NodeId` (as `u64`). `Node` passes through as-is;
/// `Split` looks up `(point, slot_id)` in `split_map` (built by `apply_split_points`) — `Err` if
/// absent, meaning the edge list and `split_points` disagree about which slots exist (a caller
/// bug, not a panic-worthy invariant violation, so it's a `Result` like every other malformed-
/// input case on this path).
fn resolve_post_edit_endpoint(
    ep: &PostEditEndpointDto,
    split_map: &HashMap<([i32; 2], u32), u64>,
) -> Result<u64, String> {
    match ep {
        PostEditEndpointDto::Node { id } => Ok(*id as u64),
        PostEditEndpointDto::Split { point, slot_id } => {
            split_map.get(&(*point, *slot_id)).copied()
                .ok_or_else(|| format!("split endpoint {point:?}/slot {slot_id} was not created by split_points"))
        }
    }
}

/// Builds post-edit's passages (and read-only pass-through teleports) into `graph` — split out
/// from `run_compute_analytics` so the edge-kind matching itself can be unit-tested without a
/// `JsValue`/wasm context. "basic" adds both directions (bidirectional passage); "one_way" adds
/// only `from→to` (direction already normalized by the caller); "teleport" adds a single directed
/// `EdgeKind::Teleport` edge — a two-way teleport arrives as two separate "teleport" entries (one
/// per direction), matching how the web side extracts them 1:1 from the generated `EdgeDto` list
/// (see `extractTeleportEdges`), the same way "one_way" already represents only one direction
/// per entry unlike "basic".
///
/// `split_map` resolves any `Split` endpoint to its real `NodeId` (GitHub issue #221) — built by
/// `apply_split_points`, which must run first.
fn build_graph_from_post_edit_edges(
    graph: &mut Graph,
    edges: &[PostEditEdgeDto],
    split_map: &HashMap<([i32; 2], u32), u64>,
) -> Result<(), String> {
    for e in edges {
        let from_id = resolve_post_edit_endpoint(&e.from, split_map)?;
        let to_id   = resolve_post_edit_endpoint(&e.to, split_map)?;
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

/// Applies `split_points` (GitHub issue #221) to an already-built `Maze`, one `Maze::add_node_at`
/// call per entry, in deterministic `(point, slot_id)` order — so two calls with the same set of
/// entries (regardless of input order, and regardless of the add/remove history that produced
/// that set) always create nodes in the same relative order and therefore get the same `NodeId`s.
/// Returns the `(point, slot_id) -> NodeId` map `build_graph_from_post_edit_edges` needs to
/// resolve `Split` endpoints.
///
/// Every point is checked against the field with `xy_to_point`/`contains` *before* calling
/// `add_node_at` — `Field::add_node_at` panics on an unknown point, and a stale `split_points`
/// entry (e.g. a project saved when the point existed, loaded after the tessellation shrank) must
/// surface as an ordinary `Err`, not take down the whole call.
fn apply_split_points<T: Tessellation>(
    maze: &mut Maze<T>,
    xy_to_point: impl Fn([i32; 2]) -> Option<T::Point>,
    split_points: &[([i32; 2], u32)],
) -> Result<HashMap<([i32; 2], u32), u64>, String> {
    let mut sorted: Vec<([i32; 2], u32)> = split_points.to_vec();
    sorted.sort_unstable();

    let mut map = HashMap::new();
    for (xy, slot_id) in sorted {
        let point = xy_to_point(xy)
            .filter(|&p| maze.field.contains(p))
            .ok_or_else(|| format!("split_points references unknown point {xy:?}"))?;
        let node = maze.add_node_at(point);
        map.insert((xy, slot_id), node);
    }
    Ok(map)
}

fn run_compute_analytics<T: Tessellation + 'static>(
    cfg: ComputeAnalyticsConfig,
    pts: Vec<T::Point>,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
    xy_to_point: impl Fn([i32; 2]) -> Option<T::Point>,
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

    let mut maze = Maze::<T>::new(field, graph);

    // Split points must exist before edges are resolved — some edges may address a split node
    // by (point, slot_id) that only comes into being here (GitHub issue #221).
    let split_map = apply_split_points(&mut maze, xy_to_point, &cfg.split_points)
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
    fn snapshot_nodes_lists_a_split_points_nodes_exactly_once_each() {
        // GitHub issue #223 regression: `Field::all_points()` yields one entry per NodeId, so a
        // split point (2+ NodeIds at the same coordinate) used to make `nodes` list that point's
        // node pair once per its own node count — a 2-node split point appeared 2x (4 entries
        // instead of 2), a 3-node split point 3x, etc.
        let mut ids = IdGenerator::new();
        let mut field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 1, y: 0 };
        let extra = field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        g.add_node(extra);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(vec![]), &HashMap::new(), |p| (p.x, p.y)).unwrap();

        let at_split_point: Vec<_> = snapshot.nodes.iter().filter(|n| n.x == 1 && n.y == 0).collect();
        assert_eq!(at_split_point.len(), 2, "split point's node list must appear exactly once, not once per its own node count");
        let mut ids_seen: Vec<u32> = at_split_point.iter().map(|n| n.id).collect();
        ids_seen.sort_unstable();
        ids_seen.dedup();
        assert_eq!(ids_seen.len(), 2, "no duplicate NodeIds within the split point's entries");
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
        PostEditEdgeDto {
            from: PostEditEndpointDto::Node { id: from },
            to: PostEditEndpointDto::Node { id: to },
            kind: kind.to_string(),
        }
    }

    fn graph_with_nodes(ids: &[u64]) -> Graph {
        let mut graph = Graph::new();
        for &id in ids { graph.add_node(id); }
        graph
    }

    fn no_splits() -> HashMap<([i32; 2], u32), u64> {
        HashMap::new()
    }

    #[test]
    fn build_graph_from_post_edit_edges_basic_adds_both_directions() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "basic")], &no_splits()).unwrap();
        assert!(graph.edge_between(1, 2).is_some());
        assert!(graph.edge_between(2, 1).is_some());
        assert_eq!(graph.edges().count(), 2);
    }

    #[test]
    fn build_graph_from_post_edit_edges_one_way_adds_only_forward() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "one_way")], &no_splits()).unwrap();
        assert!(graph.edge_between(1, 2).is_some());
        assert!(graph.edge_between(2, 1).is_none());
        assert_eq!(graph.edges().count(), 1);
    }

    #[test]
    fn build_graph_from_post_edit_edges_teleport_adds_only_forward_as_teleport_kind() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "teleport")], &no_splits()).unwrap();
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
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "teleport"), edge(2, 1, "teleport")], &no_splits()).unwrap();
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport));
        assert!(graph.edges().any(|e| e.from == 2 && e.to == 1 && e.kind == EdgeKind::Teleport));
        assert_eq!(graph.edges().count(), 2);
    }

    #[test]
    fn build_graph_from_post_edit_edges_teleport_coexists_with_parallel_basic() {
        // A Basic and a Teleport edge in the same direction between the same pair must both
        // survive — kind-aware dedup in Graph::add_edge allows this (see graph::parallel_edges_tests).
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "basic"), edge(1, 2, "teleport")], &no_splits()).unwrap();
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Basic));
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport));
        assert_eq!(graph.edges().count(), 3, "basic(2 directions) + teleport(1 direction) = 3 edges");
    }

    #[test]
    fn build_graph_from_post_edit_edges_unknown_kind_is_rejected() {
        let mut graph = graph_with_nodes(&[1, 2]);
        let err = build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "wall")], &no_splits()).unwrap_err();
        assert!(err.contains("wall"), "error must mention the offending kind, got: {err}");
    }

    #[test]
    fn resolve_post_edit_endpoint_node_passthrough() {
        let map = no_splits();
        let ep = PostEditEndpointDto::Node { id: 42 };
        assert_eq!(resolve_post_edit_endpoint(&ep, &map).unwrap(), 42);
    }

    #[test]
    fn resolve_post_edit_endpoint_split_resolves_from_map() {
        let mut map = no_splits();
        map.insert(([1, 2], 0), 99);
        let ep = PostEditEndpointDto::Split { point: [1, 2], slot_id: 0 };
        assert_eq!(resolve_post_edit_endpoint(&ep, &map).unwrap(), 99);
    }

    #[test]
    fn resolve_post_edit_endpoint_split_missing_is_error() {
        let map = no_splits();
        let ep = PostEditEndpointDto::Split { point: [1, 2], slot_id: 0 };
        let err = resolve_post_edit_endpoint(&ep, &map).unwrap_err();
        assert!(err.contains("slot 0"), "error should mention the offending slot, got: {err}");
    }

    fn xy_to_square(xy: [i32; 2]) -> Option<SquarePoint> {
        Some(SquarePoint { x: xy[0], y: xy[1] })
    }

    #[test]
    fn apply_split_points_creates_nodes_regardless_of_input_order() {
        let mut ids1 = IdGenerator::new();
        let field1 = Field::new(square_rect(1, 1), &mut ids1).unwrap();
        let mut g1 = Graph::new();
        field1.build_nodes(&mut g1);
        let mut maze1: Maze<SquareTessellation> = Maze::new(field1, g1);
        let map1 = apply_split_points(&mut maze1, xy_to_square, &[([0, 0], 2), ([0, 0], 0), ([0, 0], 1)]).unwrap();

        let mut ids2 = IdGenerator::new();
        let field2 = Field::new(square_rect(1, 1), &mut ids2).unwrap();
        let mut g2 = Graph::new();
        field2.build_nodes(&mut g2);
        let mut maze2: Maze<SquareTessellation> = Maze::new(field2, g2);
        let map2 = apply_split_points(&mut maze2, xy_to_square, &[([0, 0], 0), ([0, 0], 1), ([0, 0], 2)]).unwrap();

        assert_eq!(map1[&([0, 0], 0)], map2[&([0, 0], 0)]);
        assert_eq!(map1[&([0, 0], 1)], map2[&([0, 0], 1)]);
        assert_eq!(map1[&([0, 0], 2)], map2[&([0, 0], 2)]);
    }

    /// `NodeId` is `IdGenerator`'s sequential counter (position in the creation queue), not a
    /// value derived from `(point, slot_id)` — so removing a slot from the set genuinely does
    /// shift the `NodeId` of slots that would've been created after it (GitHub issue #221's plan,
    /// "Ключевое архитектурное решение" section, records why this is expected and NOT something
    /// `apply_split_points` tries to prevent: the fix for cross-call stability lives on the web
    /// side, in never storing a raw resolved `NodeId` for a split node past one confirm call).
    /// This test pins that "no attempt at cross-call stability" contract down directly, so a
    /// future change doesn't silently reintroduce an assumption this crate never guaranteed.
    #[test]
    fn removing_a_slot_from_the_set_shifts_the_id_of_a_later_slot_across_calls() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let before = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0), ([0, 0], 1), ([0, 0], 2)]).unwrap();

        let mut ids2 = IdGenerator::new();
        let field2 = Field::new(square_rect(1, 1), &mut ids2).unwrap();
        let mut g2 = Graph::new();
        field2.build_nodes(&mut g2);
        let mut maze2: Maze<SquareTessellation> = Maze::new(field2, g2);
        // slot 1 (the middle one) removed from the set entirely.
        let after = apply_split_points(&mut maze2, xy_to_square, &[([0, 0], 0), ([0, 0], 2)]).unwrap();

        assert_eq!(before[&([0, 0], 0)], after[&([0, 0], 0)], "the first slot in the set is unaffected");
        assert_ne!(before[&([0, 0], 2)], after[&([0, 0], 2)],
            "the later slot's absolute NodeId does shift once an earlier slot disappears from the set");
    }

    /// Same set, same call — resolving `(point, slot_id)` twice within one `apply_split_points`
    /// output must obviously agree with itself (the actual guarantee this function makes).
    #[test]
    fn split_map_is_internally_consistent_within_one_call() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0), ([0, 0], 1)]).unwrap();

        assert_ne!(map[&([0, 0], 0)], map[&([0, 0], 1)], "distinct slots must resolve to distinct nodes");
        assert!(maze.graph.nodes().any(|n| n.id == map[&([0, 0], 0)]));
        assert!(maze.graph.nodes().any(|n| n.id == map[&([0, 0], 1)]));
    }

    #[test]
    fn apply_split_points_rejects_unknown_point() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let err = apply_split_points(&mut maze, xy_to_square, &[([5, 5], 0)]).unwrap_err();
        assert!(err.contains("[5, 5]"), "error should mention the offending point, got: {err}");
    }

    #[test]
    fn apply_split_points_rejects_point_removed_from_field_without_panicking() {
        // xy_to_point that maps every coordinate to a Some(...) point, but the point isn't in
        // the field — must not panic (Field::add_node_at panics on an unknown point), must
        // surface as an ordinary Err instead (e.g. a project saved before the tessellation shrank).
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let err = apply_split_points(&mut maze, xy_to_square, &[([9, 9], 0)]).unwrap_err();
        assert!(err.contains("[9, 9]"), "error should mention the offending point, got: {err}");
    }

    #[test]
    fn build_graph_from_post_edit_edges_accepts_split_endpoints_end_to_end() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let a = maze.field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();

        let split_map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0)]).unwrap();
        let split_node = split_map[&([0, 0], 0)];

        let edges = vec![PostEditEdgeDto {
            from: PostEditEndpointDto::Node { id: a as u32 },
            to: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0 },
            kind: "basic".to_string(),
        }];
        build_graph_from_post_edit_edges(&mut maze.graph, &edges, &split_map).unwrap();

        assert!(maze.graph.edge_between(a, split_node).is_some());
        assert!(maze.graph.edge_between(split_node, a).is_some());
    }

    /// Reproduces the reported bug: start/finish blocked by a wall, a split node added between
    /// them and wired to both as a detour — `meta.start`/`meta.finish` are resolved from the
    /// caller-supplied `start`/`finish` ids exactly as `run_compute_analytics` does (already-
    /// resolved plain ids on the wire — see `ComputeAnalyticsConfig.start`/`.finish`'s doc comment,
    /// GitHub issue #221's plan section on why those two fields differ from `edges`), so if this
    /// passes but the browser still shows "no route", the bug is client-side (stale `state.nodes`
    /// used to resolve `start`/`finish` on the frontend before sending), not in this WASM pipeline.
    #[test]
    fn route_exists_through_a_split_node_bridging_a_walled_off_pair() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let a = maze.field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let b = maze.field.nodes_at(SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
        // No edge at all between a and b — the direct passage is walled off.

        let split_map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0)]).unwrap();
        let split_node = split_map[&([0, 0], 0)];

        let edges = vec![
            PostEditEdgeDto {
                from: PostEditEndpointDto::Node { id: a as u32 },
                to: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0 },
                kind: "basic".to_string(),
            },
            PostEditEdgeDto {
                from: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0 },
                to: PostEditEndpointDto::Node { id: b as u32 },
                kind: "basic".to_string(),
            },
        ];
        build_graph_from_post_edit_edges(&mut maze.graph, &edges, &split_map).unwrap();

        maze.meta.start = Some(a);
        maze.meta.finish = Some(b);

        let route = maze.analysis.route_info(&maze.graph, &maze.meta);
        assert!(route.is_some(), "expected a route from a to b via the split node {split_node}, got None");
    }
}
