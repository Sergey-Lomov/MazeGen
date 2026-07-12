use std::collections::HashMap;
use rand::SeedableRng;
use maze_core::random::MazeRng;
use maze_core::{
    space::Tessellation,
    quality_control::{
        QualityControlEngine, Issue, CycleAnalysisOverflowedIssue, InvalidLoopIssue,
        RegionNeedsExpansionIssue, RepairLimitReachedIssue, QcNoProgressIssue,
    },
    compute_node_stats, compute_spatial_edge_stats, compute_teleport_edge_stats,
    Maze,
};
use crate::dto::{
    EdgeDto, EdgeKindDto, IssueDto, IssuePayloadDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto,
    NodeStatsDto, SpatialEdgeStatsDto, TeleportEdgeStatsDto, RouteInfoDto, JunctionBucket, GraphAnalyticsDto,
};

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

    // Used below for `graph_analytics_dto.node_component` — cached per `graph.version()`.
    let scc = maze.analysis.scc(&maze.graph);

    let issues: Vec<IssueDto> = raw_issues.iter().map(|issue| {
        let issue = issue.as_ref();
        // Grouped by source check id (not one flat list) so a merged issue rendered as several
        // bubbles (one per `source_checks` entry) highlights only the cycles/regions *that check*
        // flagged on hover — see `IssuePayloadDto::InvalidLoop`'s doc comment. Since GitHub issue
        // #98 (cycles) / #99 (regions), `report_check`/`run_check_only` produce one
        // `InvalidLoopIssue`/`RegionNeedsExpansionIssue` per invalid cycle/undersized region (not
        // one merged batch) — each issue's own `source_checks()` names every check id that flagged
        // its single `cycle`/`region`, already resolved to `EdgeId`s/`NodeId`s, no further resolve
        // needed here. Two different issues (from two different checks) flagging the *same*
        // physical cycle/region deliberately do NOT collapse into one entry — each check's bubble
        // must show its own cycle/region independently, even if it happens to be the same edge/
        // node set as another check's.
        let mut invalid_loop_edges: HashMap<String, Vec<Vec<[u32; 2]>>> = HashMap::new();
        if let Some(InvalidLoopIssue { cycle, .. }) = issue.as_any().downcast_ref::<InvalidLoopIssue>() {
            let edge_pairs: Vec<[u32; 2]> = cycle.iter().filter_map(|&eid| {
                let edge = maze.graph.edge(eid)?;
                let from = u32::try_from(edge.from).ok()?;
                let to = u32::try_from(edge.to).ok()?;
                Some([from, to])
            }).collect();
            // Dedup only within this one issue's own source-check list (defensive against a
            // malformed `source_checks()` with a repeated id) — never across different issues.
            let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
            for source in issue.source_checks() {
                if seen.insert(source.as_str()) {
                    invalid_loop_edges.entry(source.clone()).or_default().push(edge_pairs.clone());
                }
            }
        }
        let mut region_needs_expansion_nodes: HashMap<String, Vec<Vec<u32>>> = HashMap::new();
        if let Some(RegionNeedsExpansionIssue { region, .. }) = issue.as_any().downcast_ref::<RegionNeedsExpansionIssue>() {
            let node_ids: Vec<u32> = region.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
            let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
            for source in issue.source_checks() {
                if seen.insert(source.as_str()) {
                    region_needs_expansion_nodes.entry(source.clone()).or_default().push(node_ids.clone());
                }
            }
        }
        debug_assert!(
            invalid_loop_edges.is_empty() || region_needs_expansion_nodes.is_empty(),
            "issue {:?} produced both InvalidLoop and RegionNeedsExpansion payload data — \
             at most one concrete Issue type should match per issue",
            issue.kind()
        );
        let payload = if !invalid_loop_edges.is_empty() {
            IssuePayloadDto::InvalidLoop { edges: invalid_loop_edges }
        } else if !region_needs_expansion_nodes.is_empty() {
            IssuePayloadDto::RegionNeedsExpansion { nodes: region_needs_expansion_nodes }
        } else {
            IssuePayloadDto::None
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
        // Same rationale as `REPAIR_LIMIT_REACHED` above — `QC_NO_PROGRESS` carries no source
        // check either. `rule_ids` is joined into one comma-separated string since `details`'
        // values are flat strings, not lists; the web side only needs it for display, not
        // further parsing into a structured rule reference.
        if let Some(QcNoProgressIssue { rule_ids, .. }) = issue.as_any().downcast_ref::<QcNoProgressIssue>() {
            details.insert(issue.kind().to_string(), HashMap::from([("rule_ids".to_string(), rule_ids.join(", "))]));
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
        debug_steps: vec![],
        timing: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use maze_core::graph::EdgeKind;
    use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use maze_core::{Graph, IdGenerator};
    use maze_core::quality_control::{CYCLE_ANALYSIS_OVERFLOWED, InvalidLoopIssue};

    /// Two different checks independently flagging the exact same physical cycle must surface as
    /// two separate `IssueDto` entries (one bubble per check), never collapsed into one — see
    /// GitHub issue #98's UI invariant. Simulates the post-#98 report-path shape directly
    /// (`issues_override`) rather than exercising real checks, since the point here is the
    /// grouping/dedup logic in `build_analytics_snapshot` itself.
    #[test]
    fn two_checks_flagging_the_same_cycle_produce_two_separate_issues() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let e0 = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let e1 = g.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let e2 = g.build_initial_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let same_cycle = vec![e0, e1, e2];
        let issues: Vec<Box<dyn Issue>> = vec![
            Box::new(InvalidLoopIssue::new_from_check("rule:min_loop_length", 0, same_cycle.clone(), vec![], vec![])),
            Box::new(InvalidLoopIssue::new_from_check("rule:max_loop_length", 0, same_cycle.clone(), vec![], vec![])),
        ];

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &HashMap::new(), |p| (p.x, p.y)).unwrap();

        let invalid_loop_issues: Vec<_> = snapshot.issues.iter()
            .filter(|i| i.kind == "invalid_loop")
            .collect();
        assert_eq!(invalid_loop_issues.len(), 2, "two independent issues must stay two IssueDto entries, not merge into one");
        for dto in &invalid_loop_issues {
            let IssuePayloadDto::InvalidLoop { edges } = &dto.payload else { panic!("expected InvalidLoop payload") };
            assert_eq!(edges.len(), 1, "each issue's payload must only carry its own check's entry");
        }
    }

    /// `IssueMeta::push_source` (the only way `source_checks()` ever grows past construction,
    /// used exclusively by `IssueMerge::merge`) already dedups by id — so a single issue's
    /// `source_checks()` can never legitimately contain a repeat. This pins the grouping loop's
    /// own defensive dedup (a `HashSet` guard per issue, see the loop in
    /// `build_analytics_snapshot`) against the ordinary, non-duplicated case: one issue, one
    /// source check, one bucket entry.
    #[test]
    fn one_issue_one_source_check_produces_exactly_one_bucket_entry() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let e0 = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let e1 = g.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let e2 = g.build_initial_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidLoopIssue::new_from_check("rule:min_loop_length", 0, vec![e0, e1, e2], vec![], vec![]);
        let issues: Vec<Box<dyn Issue>> = vec![Box::new(issue)];

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &HashMap::new(), |p| (p.x, p.y)).unwrap();

        let dto = snapshot.issues.iter().find(|i| i.kind == "invalid_loop").unwrap();
        let IssuePayloadDto::InvalidLoop { edges } = &dto.payload else { panic!("expected InvalidLoop payload") };
        assert_eq!(edges.get("rule:min_loop_length").map(|v| v.len()), Some(1));
    }

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
                let here = field.node_at(SquarePoint { x, y }).unwrap();
                if x + 1 < SIDE {
                    let right = field.node_at(SquarePoint { x: x + 1, y }).unwrap();
                    g.build_initial_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field.node_at(SquarePoint { x, y: y + 1 }).unwrap();
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
        let a = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
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
        let a = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
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
        let a = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let c = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
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
}
