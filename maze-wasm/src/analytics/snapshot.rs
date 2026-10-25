use super::snapshot_dto::{
    cross_element_group_map_dto, edge_group_map_dto, missing_elevator_stops_map_dto,
    region_payload_map_dto, route_payload_map_dto, split_face_requirement_dto, split_group_map_dto,
};
use crate::dto::{
    EdgeDto, EdgeKindDto, ElementsStatsDto, FloorScoped, GraphStatsDto, IssueDto, IssuePayloadDto,
    JunctionBucket, MazeSnapshot, MazeStatisticsDto, NavEdgeDto, NavNodeDto, NodeDto, NodeStatsDto,
    RouteInfoDto, SpatialEdgeStatsDto, SplitGroupDto, VerticalStatsDto,
};
use maze_core::random::MazeRng;
use maze_core::{
    Maze,
    generation::PresetState,
    graph::split_topology::split_totals_scoped,
    graph::stats::{
        average_degree, compute_elevator_stop_count_scoped, compute_node_stats_scoped,
        compute_spatial_edge_stats_scoped, compute_teleport_edge_stats,
        compute_teleport_edge_stats_scoped, compute_vertical_stats,
    },
    quality_control::{
        CycleAnalysisOverflowedIssue, Issue, IssuePayload, QualityControlEngine,
        RepairLimitReachedIssue, resolve_issue_payload,
    },
    space::Tessellation,
};
use rand::SeedableRng;
use std::collections::HashMap;

/// Compute analytics snapshot from a fully-built maze (GraphInput).
/// Independent of the generation pipeline — accepts any Maze<T> with a populated graph.
/// `qc_engine`: used to run quality checks (no repair). Pass None to skip QC (e.g. when
/// caller already has authoritative issues from a repair cycle).
#[allow(clippy::too_many_arguments)]
pub fn build_analytics_snapshot<T: Tessellation>(
    maze: &mut Maze<T>,
    qc_engine: Option<&QualityControlEngine<T>>,
    issues_override: Option<Vec<Box<dyn Issue>>>,
    check_types: &HashMap<String, String>,
    // Whether each flagged cycle/group/node/route is preset-protected (GitHub issue #245) is
    // resolved against this — `runner.rs`'s generation/repair path passes the real
    // `repair_preset_state`; `compute_analytics`'s post-edit path reconstructs an equivalent
    // `PresetState` independently (its graph is rebuilt straight from the client's post-edit
    // node/edge list, never from `PresetConnection`s) via `preset_edges_for_post_edit`/
    // `resolve_preset_nodes_for_post_edit`, resolved fresh against the rebuilt field each call.
    preset_state: &PresetState,
    cell_to_xy: impl Fn(T::CellId) -> (i32, i32),
    // Node's stable per-point index (GitHub issue #236, `NodeDto.i` doc comment) — `0` is always
    // the point's original node. A fresh maze (generation) has no removal history yet, so a node's
    // position within `nodes_at(point)` (the default every call site but `run_compute_analytics`
    // passes) already equals its real `i`. `run_compute_analytics` instead passes a lookup that
    // prefers the client's own `cfg.nodes` (post-edit's removal history can leave a hole in the
    // `i` sequence that a freshly recomputed position would wrongly compact away), falling back to
    // `split_map` (GitHub issue #626) for a node this exact call just minted via
    // `apply_split_points` — never to raw position, since a re-added slot's `slot_id` can exceed
    // the point's current node count once an earlier sibling was removed.
    index_of: impl Fn(maze_core::ids::NodeId, T::CellId, usize) -> u32,
    // The project's configured `scored_endpoints` weights, if that strategy is configured on any
    // rule (GitHub issue #532) — used to compute `route_info.score` directly from the current
    // `maze.meta.start`/`finish`, independent of whether a repair actually dispatched (see
    // `MazeAnalysis::route_score`). `None` when no rule configures that strategy: there is
    // genuinely no score to show, not a bug, so `route_info.score` stays `None` too.
    score_weights: Option<&maze_core::repair::strategies::ScoreWeights>,
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

    let issues: Vec<IssueDto> = raw_issues
        .iter()
        .map(|issue| {
            let issue = issue.as_ref();
            let payload = match resolve_issue_payload(
                issue,
                &maze.graph,
                &maze.field,
                &scc,
                preset_state,
                Some(check_types),
            ) {
                IssuePayload::None => IssuePayloadDto::None,
                // Grouped by source check id (not one flat list) so a merged issue rendered as
                // several bubbles (one per `source_checks` entry) highlights only the cycles *that
                // check* flagged on hover — see `IssuePayloadDto::InvalidLoop`'s doc comment.
                IssuePayload::InvalidLoop { edges } => IssuePayloadDto::InvalidLoop {
                    edges: edge_group_map_dto(edges),
                },
                IssuePayload::RegionNeedsExpansion { nodes } => {
                    IssuePayloadDto::RegionNeedsExpansion {
                        nodes: region_payload_map_dto(nodes),
                    }
                }
                IssuePayload::RegionNeedsShrink { nodes } => IssuePayloadDto::RegionNeedsShrink {
                    nodes: region_payload_map_dto(nodes),
                },
                IssuePayload::InvalidTeleport { groups } => IssuePayloadDto::InvalidTeleport {
                    groups: edge_group_map_dto(groups),
                },
                IssuePayload::InvalidOneWay { groups } => IssuePayloadDto::InvalidOneWay {
                    groups: edge_group_map_dto(groups),
                },
                IssuePayload::InvalidVerticalPassage { groups } => {
                    IssuePayloadDto::InvalidVerticalPassage {
                        groups: edge_group_map_dto(groups),
                    }
                }
                IssuePayload::InvalidSplitTile { groups } => IssuePayloadDto::InvalidSplitTile {
                    groups: split_group_map_dto(groups),
                },
                IssuePayload::InvalidSplitRoute { routes } => IssuePayloadDto::InvalidSplitRoute {
                    routes: route_payload_map_dto(routes),
                },
                IssuePayload::ExcessiveSccCount { preset_locked } => {
                    IssuePayloadDto::ExcessiveSccCount { preset_locked }
                }
                IssuePayload::InvalidElevator { groups } => IssuePayloadDto::InvalidElevator {
                    groups: edge_group_map_dto(groups),
                },
                IssuePayload::InvalidElevatorStop { nodes } => {
                    IssuePayloadDto::InvalidElevatorStop {
                        nodes: region_payload_map_dto(nodes),
                    }
                }
                IssuePayload::InvalidDeadEnd { nodes } => IssuePayloadDto::InvalidDeadEnd {
                    nodes: region_payload_map_dto(nodes),
                },
                IssuePayload::AreaDeficit { areas } => IssuePayloadDto::AreaDeficit { areas },
                IssuePayload::MissingElevatorStopCount { groups } => {
                    IssuePayloadDto::MissingElevatorStopCount {
                        groups: missing_elevator_stops_map_dto(groups),
                    }
                }
                IssuePayload::InvalidCrossElementGroup { groups } => {
                    IssuePayloadDto::InvalidCrossElementGroup {
                        groups: cross_element_group_map_dto(groups),
                    }
                }
            };
            let source_checks = issue
                .source_checks()
                .iter()
                .map(|s| s.to_string())
                .collect();
            let mut details: HashMap<String, HashMap<String, String>> = issue
                .details()
                .iter()
                .map(|(check_id, kv)| {
                    (
                        check_id.to_string(),
                        kv.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
                    )
                })
                .collect();
            // `REPAIR_LIMIT_REACHED` carries no source check (pushed directly by `build_maze`, not a
            // toggleable `Check<T, I>`), so its detail can't be keyed by a check instance id like the
            // others — keyed by the issue's own kind string instead, the only stable key available here.
            if let Some(RepairLimitReachedIssue { limit, .. }) =
                issue.as_any().downcast_ref::<RepairLimitReachedIssue>()
            {
                details.insert(
                    issue.kind().to_string(),
                    HashMap::from([("limit".to_string(), limit.as_str().to_string())]),
                );
            }
            // Invariant: every key in `source_checks` has a matching entry here, no extras — both
            // come from the same composite-id set built while constructing the active checks (see
            // `build_qc_and_repair_impl`/`check_types` in `runner.rs`), not a separate pass that
            // could drift from it.
            let source_check_types: HashMap<String, String> = issue
                .source_checks()
                .iter()
                .filter_map(|s| check_types.get(s).map(|t| (s.clone(), t.clone())))
                .collect();
            IssueDto {
                kind: issue.kind().to_string(),
                payload,
                source_checks,
                source_check_types,
                details,
            }
        })
        .collect();

    // Iterates via `Field::all_cells`/`nodes_at` (deterministic order — see their doc comments),
    // not `maze.graph.nodes()` (insertion-order, an implementation detail) — GitHub issue #221:
    // this makes "which node of a split point comes first in the snapshot" a real contract (the
    // point's original node, then each `add_node_at` in creation order), which the web-side
    // controller relies on to tell a point's original node apart from its extra split nodes.
    //
    // `all_cells()` yields one entry per *NodeId* (see its doc comment), not per unique point —
    // for a split point with N nodes it repeats that point N times. Deduping by point here (first
    // occurrence wins, `all_cells()`'s NodeId-sorted order is preserved) is required so
    // `nodes_at(p)` isn't flat-mapped once per repeat, which would emit a split point's node list
    // N times over (GitHub issue #223 surfaced this once split-junction rendering started reading
    // every node of a point instead of just one).
    let levels: Vec<maze_core::space::LevelId> = maze.field.levels_ordered().collect();
    let mut nodes: Vec<NodeDto> = Vec::new();
    for (level_index, &level) in levels.iter().enumerate() {
        let mut seen_points: std::collections::HashSet<T::CellId> =
            std::collections::HashSet::new();
        let points: Vec<T::CellId> = maze
            .field
            .field_of(level)
            .expect("levels_ordered always resolves")
            .all_cells()
            .filter(|p| seen_points.insert(*p))
            .collect();
        for p in points {
            for (pos, &id) in maze.field.nodes_at(level, p).iter().enumerate() {
                let Some(id32) = u32::try_from(id).ok() else {
                    continue;
                };
                let (x, y) = cell_to_xy(p);
                let i = index_of(id, p, pos);
                nodes.push(NodeDto {
                    id: id32,
                    x,
                    y,
                    i,
                    level: level_index as u32,
                });
            }
        }
    }

    let edges: Vec<EdgeDto> = maze
        .graph
        .edges()
        .filter_map(|e| {
            let kind = match e.kind {
                maze_core::graph::EdgeKind::Basic => EdgeKindDto::Basic,
                maze_core::graph::EdgeKind::Teleport => EdgeKindDto::Teleport,
                maze_core::graph::EdgeKind::VerticalPassage => EdgeKindDto::VerticalPassage,
                maze_core::graph::EdgeKind::Elevator => EdgeKindDto::Elevator,
            };
            Some(EdgeDto {
                from: u32::try_from(e.from).ok()?,
                to: u32::try_from(e.to).ok()?,
                kind,
            })
        })
        .collect();

    let meta_start = maze.meta.start.and_then(|id| u32::try_from(id).ok());
    let meta_finish = maze.meta.finish.and_then(|id| u32::try_from(id).ok());

    let nav_nodes: Vec<NavNodeDto> = nav
        .nodes
        .iter()
        .filter_map(|n| {
            u32::try_from(n.node_id)
                .ok()
                .map(|id| NavNodeDto { node_id: id })
        })
        .collect();

    let nav_edges: Vec<NavEdgeDto> = nav
        .edges()
        .filter_map(|e| {
            let from = u32::try_from(e.from).ok()?;
            let to = u32::try_from(e.to).ok()?;
            let path = e
                .path
                .iter()
                .filter_map(|&id| u32::try_from(id).ok())
                .collect();
            Some(NavEdgeDto { from, to, path })
        })
        .collect();

    let pure_cycle_node_ids: Vec<u32> = graph_analytics
        .pure_cycle_nav_nodes
        .iter()
        .filter_map(|&nav_id| nav.nodes.get(nav_id))
        .filter_map(|n| u32::try_from(n.node_id).ok())
        .collect();

    let pure_cycle_edge_pairs: Vec<[u32; 2]> = graph_analytics
        .pure_cycle_edge_indices
        .iter()
        .filter_map(|&idx| {
            let edge = nav.edge_by_idx(idx);
            let from_node = nav.nodes.get(edge.from)?.node_id;
            let to_node = nav.nodes.get(edge.to)?.node_id;
            let from = u32::try_from(from_node).ok()?;
            let to = u32::try_from(to_node).ok()?;
            Some([from, to])
        })
        .collect();

    let node_component: HashMap<String, usize> = scc
        .components
        .iter()
        .enumerate()
        .flat_map(|(comp_id, comp)| {
            comp.iter().filter_map(move |&node_id| {
                u32::try_from(node_id)
                    .ok()
                    .map(|id| (id.to_string(), comp_id))
            })
        })
        .collect();

    let region_classes: HashMap<String, String> = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta)
        .into_iter()
        .map(|(comp_id, class)| (comp_id.to_string(), class.as_str().to_string()))
        .collect();

    let graph_stats = GraphStatsDto {
        floor_count: maze.field.level_count(),
        node_count: graph_analytics.node_count,
        edge_count: graph_analytics.edge_count,
        component_count: scc.components.len(),
        average_degree: average_degree(&maze.graph),
        cycle_count: graph_analytics.cycle_count,
        cycle_region_count: graph_analytics.cycle_region_count,
        simple_cycle_count: graph_analytics.simple_cycle_count,
        node_component,
        pure_cycle_node_ids,
        pure_cycle_edge_pairs,
        cycle_analysis_overflowed: graph_analytics.cycle_analysis_overflowed,
        region_classes,
    };

    // Real geometric cell count — `Field::all_cells()`, deduped by point (mirrors
    // `split_totals_scoped`'s own `seen_points` dedup), not reconstructed from `cell_stats`
    // (which would double-count a split point's every extra node).
    let level_cell_count = |level: maze_core::space::LevelId| -> usize {
        maze.field.field_of(level).map_or(0, |f| {
            let mut seen = std::collections::HashSet::new();
            f.all_cells().filter(|p| seen.insert(*p)).count()
        })
    };
    let cell_count = FloorScoped {
        total: levels.iter().map(|&l| level_cell_count(l)).sum(),
        by_floor: levels
            .iter()
            .enumerate()
            .map(|(idx, &level)| (idx.to_string(), level_cell_count(level)))
            .collect(),
    };

    let node_stats_dto = |raw: maze_core::graph::stats::GeometricNodeStats| NodeStatsDto {
        dead_ends: raw.dead_ends,
        straight: raw.straight,
        turns: raw.turns,
        junctions: raw
            .junctions
            .iter()
            .map(|&(degree, count)| JunctionBucket { degree, count })
            .collect(),
    };
    let cell_stats = FloorScoped {
        total: node_stats_dto(compute_node_stats_scoped(&maze.graph, &maze.field, None)),
        by_floor: levels
            .iter()
            .enumerate()
            .map(|(idx, &level)| {
                (
                    idx.to_string(),
                    node_stats_dto(compute_node_stats_scoped(
                        &maze.graph,
                        &maze.field,
                        Some(level),
                    )),
                )
            })
            .collect(),
    };

    let edge_stats_dto = |raw: &maze_core::graph::stats::SpatialEdgeStats| SpatialEdgeStatsDto {
        bidirectional: raw.bidirectional,
        walls: raw.walls,
        total_pairs: raw.total_pairs,
    };
    // Computed once per level (total + each floor) and shared by `passage_stats` and
    // `elements_stats`'s `one_way_passages` below — both need the same
    // `compute_spatial_edge_stats_scoped` result, which is not free to recompute (walks
    // `adjacency_pairs` and every node's `classify_node` shape).
    let raw_edge_stats_total = compute_spatial_edge_stats_scoped(&maze.graph, &maze.field, None);
    let raw_edge_stats_by_floor: Vec<maze_core::graph::stats::SpatialEdgeStats> = levels
        .iter()
        .map(|&level| compute_spatial_edge_stats_scoped(&maze.graph, &maze.field, Some(level)))
        .collect();

    let passage_stats = FloorScoped {
        total: edge_stats_dto(&raw_edge_stats_total),
        by_floor: raw_edge_stats_by_floor
            .iter()
            .enumerate()
            .map(|(idx, raw)| (idx.to_string(), edge_stats_dto(raw)))
            .collect(),
    };

    let split_groups_dto = |groups: HashMap<
        maze_core::graph::split_topology::SplitTopology,
        usize,
    >|
     -> Vec<SplitGroupDto> {
        groups
            .into_iter()
            .map(|(topology, count)| SplitGroupDto {
                shape: topology.shape,
                topology: topology
                    .nodes
                    .into_iter()
                    .map(|node_faces| {
                        node_faces
                            .into_iter()
                            .map(split_face_requirement_dto)
                            .collect()
                    })
                    .collect(),
                count,
            })
            .collect()
    };
    let elements_stats_dto =
        |level: Option<maze_core::space::LevelId>,
         edge_stats: &maze_core::graph::stats::SpatialEdgeStats| {
            let teleport_stats = match level {
                None => compute_teleport_edge_stats(&maze.graph),
                Some(l) => compute_teleport_edge_stats_scoped(&maze.graph, &maze.field, l),
            };
            let (split_tile_count, split_node_count, split_groups) =
                split_totals_scoped(&maze.graph, &maze.field, level);
            ElementsStatsDto {
                one_way_passages: edge_stats.one_way_passages,
                two_way_teleports: teleport_stats.two_way,
                one_way_teleports: teleport_stats.one_way,
                split_tile_count,
                split_node_count,
                split_groups: split_groups_dto(split_groups),
            }
        };
    let elements_stats = FloorScoped {
        total: elements_stats_dto(None, &raw_edge_stats_total),
        by_floor: levels
            .iter()
            .zip(raw_edge_stats_by_floor.iter())
            .enumerate()
            .map(|(idx, (&level, raw))| (idx.to_string(), elements_stats_dto(Some(level), raw)))
            .collect(),
    };

    let raw_vertical_stats = compute_vertical_stats(&maze.graph, &maze.field);
    let vertical_stats = VerticalStatsDto {
        bidirectional_passages: raw_vertical_stats.bidirectional_passages,
        one_way_passages_up: raw_vertical_stats.one_way_passages_up,
        one_way_passages_down: raw_vertical_stats.one_way_passages_down,
        elevator_groups: raw_vertical_stats.elevator_groups,
        elevator_stop_count: raw_vertical_stats.elevator_stop_count,
        average_elevator_stops: raw_vertical_stats.average_elevator_stops,
        cross_floor_teleports: raw_vertical_stats.cross_floor_teleports,
    };

    // Reuses one `elevator_groups()` union-find pass for every floor, rather than recomputing it
    // once per floor inside `compute_elevator_stop_count_scoped`.
    let elevator_groups = maze.graph.elevator_groups();
    let elevator_stop_count = FloorScoped {
        total: raw_vertical_stats.elevator_stop_count,
        by_floor: levels
            .iter()
            .enumerate()
            .map(|(idx, &level)| {
                (
                    idx.to_string(),
                    compute_elevator_stop_count_scoped(&elevator_groups, &maze.field, level),
                )
            })
            .collect(),
    };

    let statistics = MazeStatisticsDto {
        graph_stats,
        cell_count,
        cell_stats,
        passage_stats,
        elements_stats,
        vertical_stats,
        elevator_stop_count,
    };

    let score = score_weights.and_then(|w| {
        maze.analysis
            .route_score(&maze.graph, &maze.field, &maze.meta, w)
    });
    let route_info = maze
        .analysis
        .route_info(&maze.graph, &maze.field, &maze.meta)
        .map(|r| RouteInfoDto {
            path_length: r.path_length,
            junction_count: r.junction_count,
            one_way_count: r.one_way_count,
            split_count: r.split_count,
            teleport_count: r.teleport_count,
            vertical_bidirectional_count: r.vertical_bidirectional_count,
            vertical_one_way_count: r.vertical_one_way_count,
            elevator_count: r.elevator_count,
            score,
            path: r
                .path
                .iter()
                .filter_map(|&id| u32::try_from(id).ok())
                .collect(),
        });

    Ok(MazeSnapshot {
        nodes,
        edges,
        start: meta_start,
        finish: meta_finish,
        issues,
        nav_nodes,
        nav_edges,
        route_info,
        statistics,
        timing: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use maze_core::graph::{EdgeKind, Graph};
    use maze_core::ids::IdGenerator;
    use maze_core::quality_control::CYCLE_ANALYSIS_OVERFLOWED;
    use maze_core::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use std::sync::Arc;

    #[test]
    fn pushes_cycle_analysis_overflowed_issue_on_overflow() {
        // Same 6x6 fully-bidirectional grid as the cycles.rs/min_loop_length.rs regression
        // tests for issue #22 (2,444,782 simple cycles — far past MAX_SIMPLE_CYCLES).
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(
            Arc::default(),
            square_rect(SIDE as usize, SIDE as usize),
            &mut ids,
        )
        .unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field
                    .nodes_at(level, SquarePoint { x, y })
                    .first()
                    .copied()
                    .unwrap();
                if x + 1 < SIDE {
                    let right = field
                        .nodes_at(level, SquarePoint { x: x + 1, y })
                        .first()
                        .copied()
                        .unwrap();
                    g.build_initial_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field
                        .nodes_at(level, SquarePoint { x, y: y + 1 })
                        .first()
                        .copied()
                        .unwrap();
                    g.build_initial_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let snapshot = build_analytics_snapshot(
            &mut maze,
            None,
            Some(vec![]),
            &HashMap::new(),
            &PresetState::empty(),
            |p| (p.x, p.y),
            |_, _, pos| pos as u32,
            None,
        )
        .unwrap();

        assert!(snapshot.statistics.graph_stats.cycle_analysis_overflowed);
        assert!(
            snapshot
                .issues
                .iter()
                .any(|i| i.kind == CYCLE_ANALYSIS_OVERFLOWED.to_string())
        );
    }

    #[test]
    fn no_overflow_issue_on_sparse_graph() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .nodes_at(level, SquarePoint { x: 0, y: 0 })
            .first()
            .copied()
            .unwrap();
        let b = field
            .nodes_at(level, SquarePoint { x: 1, y: 0 })
            .first()
            .copied()
            .unwrap();
        g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let snapshot = build_analytics_snapshot(
            &mut maze,
            None,
            Some(vec![]),
            &HashMap::new(),
            &PresetState::empty(),
            |p| (p.x, p.y),
            |_, _, pos| pos as u32,
            None,
        )
        .unwrap();

        assert!(!snapshot.statistics.graph_stats.cycle_analysis_overflowed);
        assert!(
            !snapshot
                .issues
                .iter()
                .any(|i| i.kind == CYCLE_ANALYSIS_OVERFLOWED.to_string())
        );
    }

    #[test]
    fn statistics_dto_reflects_cells_passages_and_elements() {
        // 3x1 line: a-b bidirectional (open passage), b-c wall (no edge at all).
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .nodes_at(level, SquarePoint { x: 0, y: 0 })
            .first()
            .copied()
            .unwrap();
        let b = field
            .nodes_at(level, SquarePoint { x: 1, y: 0 })
            .first()
            .copied()
            .unwrap();
        g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let snapshot = build_analytics_snapshot(
            &mut maze,
            None,
            Some(vec![]),
            &HashMap::new(),
            &PresetState::empty(),
            |p| (p.x, p.y),
            |_, _, pos| pos as u32,
            None,
        )
        .unwrap();
        let stats = &snapshot.statistics;

        assert_eq!(stats.cell_count.total, 3);
        assert_eq!(
            stats.cell_stats.total.dead_ends, 3,
            "b-c is a wall, so b has only one shape neighbor (a) and is also a dead end"
        );
        assert_eq!(stats.cell_stats.total.straight, 0);
        assert_eq!(
            stats.passage_stats.total.total_pairs, 2,
            "3x1 field has 2 adjacent pairs"
        );
        assert_eq!(stats.passage_stats.total.bidirectional, 1);
        assert_eq!(stats.passage_stats.total.walls, 1);
        assert_eq!(stats.elements_stats.total.one_way_passages, 0);
        assert_eq!(stats.elements_stats.total.two_way_teleports, 0);
        assert_eq!(stats.elements_stats.total.split_tile_count, 0);

        assert_eq!(
            stats.cell_count.by_floor.get("0"),
            Some(&3),
            "single-floor maze mirrors the total in by_floor[\"0\"]"
        );
        assert_eq!(
            stats.passage_stats.by_floor.get("0").map(|s| s.total_pairs),
            Some(2)
        );
    }

    #[test]
    fn snapshot_nodes_lists_a_split_points_nodes_exactly_once_each() {
        // GitHub issue #223 regression: `Field::all_cells()` yields one entry per NodeId, so a
        // split point (2+ NodeIds at the same coordinate) used to make `nodes` list that point's
        // node pair once per its own node count — a 2-node split point appeared 2x (4 entries
        // instead of 2), a 3-node split point 3x, etc.
        let mut ids = IdGenerator::new();
        let mut field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let extra = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        g.add_node(extra);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let snapshot = build_analytics_snapshot(
            &mut maze,
            None,
            Some(vec![]),
            &HashMap::new(),
            &PresetState::empty(),
            |p| (p.x, p.y),
            |_, _, pos| pos as u32,
            None,
        )
        .unwrap();

        let at_split_point: Vec<_> = snapshot
            .nodes
            .iter()
            .filter(|n| n.x == 1 && n.y == 0)
            .collect();
        assert_eq!(
            at_split_point.len(),
            2,
            "split point's node list must appear exactly once, not once per its own node count"
        );
        let mut ids_seen: Vec<u32> = at_split_point.iter().map(|n| n.id).collect();
        ids_seen.sort_unstable();
        ids_seen.dedup();
        assert_eq!(
            ids_seen.len(),
            2,
            "no duplicate NodeIds within the split point's entries"
        );
    }

    #[test]
    fn statistics_dto_reflects_elevator_stop_count_by_floor() {
        // GitHub issue #436: a 3-floor field with one elevator group spanning floors 0 and 2
        // (floor 1 has no stop) — checks `elevator_stop_count.by_floor` wiring end-to-end through
        // `build_analytics_snapshot`, not just `compute_elevator_stop_count_scoped` in isolation.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let level0 = field.single_level_id();
        let _level1 =
            field.add_level(Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap());
        let level2 =
            field.add_level(Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a0 = field
            .nodes_at(level0, SquarePoint { x: 0, y: 0 })
            .first()
            .copied()
            .unwrap();
        let a2 = field
            .nodes_at(level2, SquarePoint { x: 0, y: 0 })
            .first()
            .copied()
            .unwrap();
        g.build_initial_bidirectional_edge(a0, a2, EdgeKind::Elevator);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let snapshot = build_analytics_snapshot(
            &mut maze,
            None,
            Some(vec![]),
            &HashMap::new(),
            &PresetState::empty(),
            |p| (p.x, p.y),
            |_, _, pos| pos as u32,
            None,
        )
        .unwrap();
        let stats = &snapshot.statistics;

        assert_eq!(stats.vertical_stats.elevator_groups, 1);
        assert_eq!(stats.vertical_stats.elevator_stop_count, 2);
        assert_eq!(stats.vertical_stats.average_elevator_stops, 2.0);
        assert_eq!(stats.elevator_stop_count.total, 2);
        assert_eq!(
            stats.elevator_stop_count.by_floor.get("0"),
            Some(&1),
            "level0's own stop"
        );
        assert_eq!(
            stats.elevator_stop_count.by_floor.get("1"),
            Some(&0),
            "middle floor has no stop"
        );
        assert_eq!(
            stats.elevator_stop_count.by_floor.get("2"),
            Some(&1),
            "level2's own stop"
        );
    }

    #[test]
    fn region_classes_empty_when_start_or_finish_unset() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .nodes_at(level, SquarePoint { x: 0, y: 0 })
            .first()
            .copied()
            .unwrap();
        let b = field
            .nodes_at(level, SquarePoint { x: 1, y: 0 })
            .first()
            .copied()
            .unwrap();
        g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        // Neither start nor finish set.

        let snapshot = build_analytics_snapshot(
            &mut maze,
            None,
            Some(vec![]),
            &HashMap::new(),
            &PresetState::empty(),
            |p| (p.x, p.y),
            |_, _, pos| pos as u32,
            None,
        )
        .unwrap();

        assert!(snapshot.statistics.graph_stats.region_classes.is_empty());
    }

    #[test]
    fn region_classes_populated_when_start_and_finish_set() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .nodes_at(level, SquarePoint { x: 0, y: 0 })
            .first()
            .copied()
            .unwrap();
        let b = field
            .nodes_at(level, SquarePoint { x: 1, y: 0 })
            .first()
            .copied()
            .unwrap();
        let c = field
            .nodes_at(level, SquarePoint { x: 2, y: 0 })
            .first()
            .copied()
            .unwrap();
        g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
        g.build_initial_bidirectional_edge(b, c, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(a);
        maze.meta.finish = Some(c);

        let snapshot = build_analytics_snapshot(
            &mut maze,
            None,
            Some(vec![]),
            &HashMap::new(),
            &PresetState::empty(),
            |p| (p.x, p.y),
            |_, _, pos| pos as u32,
            None,
        )
        .unwrap();

        // Fully bidirectional 3-node line collapses into a single SCC — start and finish share
        // a region, which is always "path" by definition.
        assert!(!snapshot.statistics.graph_stats.region_classes.is_empty());
        assert!(
            snapshot
                .statistics
                .graph_stats
                .region_classes
                .values()
                .all(|c| c == "path")
        );
    }
}
