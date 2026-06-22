use std::collections::HashMap;
use maze_core::{
    space::Tessellation,
    quality_control::{QualityControlEngine, Issue, IssueData},
    compute_node_stats, compute_spatial_edge_stats, compute_graph_analytics,
    Maze,
};
use crate::dto::{
    EdgeDto, IssueDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto,
    NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto, JunctionBucket, GraphAnalyticsDto,
};

/// Compute analytics snapshot from a fully-built maze (GraphInput).
/// Independent of the generation pipeline — accepts any Maze<T> with a populated graph.
/// `qc_engine`: used to run quality checks (no repair). Pass None to skip QC (e.g. when
/// caller already has authoritative issues from a repair cycle).
pub fn build_analytics_snapshot<T: Tessellation>(
    maze: &mut Maze<T>,
    qc_engine: Option<&QualityControlEngine<T>>,
    issues_override: Option<Vec<Issue>>,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<MazeSnapshot, String> {
    let raw_issues: Vec<Issue> = if let Some(i) = issues_override {
        i
    } else if let Some(engine) = qc_engine {
        engine.run(maze)
    } else {
        vec![]
    };

    let issues: Vec<IssueDto> = raw_issues.iter().map(|issue| {
        let short_loop_edges = match &issue.data {
            Some(IssueData::ShortLoops { all, short }) => Some(
                short.iter().filter_map(|&idx| all.get(idx)).map(|loop_edges| {
                    loop_edges.iter().filter_map(|&eid| {
                        let edge = maze.graph.edge(eid)?;
                        let from = u32::try_from(edge.from).ok()?;
                        let to = u32::try_from(edge.to).ok()?;
                        Some([from, to])
                    }).collect()
                }).collect()
            ),
            _ => None,
        };
        IssueDto { kind: issue.kind.to_string(), short_loop_edges }
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
            Some(EdgeDto {
                from: u32::try_from(e.from).ok()?,
                to:   u32::try_from(e.to).ok()?,
            })
        })
        .collect();

    let meta_start  = maze.meta.start.and_then(|id| u32::try_from(id).ok());
    let meta_finish = maze.meta.finish.and_then(|id| u32::try_from(id).ok());

    let graph_analytics = compute_graph_analytics(maze.analysis.nav_graph(&maze.graph, &maze.meta));

    let nav_nodes: Vec<NavNodeDto> = maze.analysis.nav_graph(&maze.graph, &maze.meta).nodes.iter()
        .filter_map(|n| u32::try_from(n.node_id).ok().map(|id| NavNodeDto { node_id: id }))
        .collect();

    let nav_edges: Vec<NavEdgeDto> = maze.analysis.nav_graph(&maze.graph, &maze.meta).edges()
        .filter_map(|e| {
            let from = u32::try_from(e.from).ok()?;
            let to   = u32::try_from(e.to).ok()?;
            let path = e.path.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
            Some(NavEdgeDto { from, to, path })
        })
        .collect();

    let pure_cycle_node_ids: Vec<u32> = {
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        graph_analytics.pure_cycle_nav_nodes.iter()
            .filter_map(|&nav_id| nav.nodes.get(nav_id))
            .filter_map(|n| u32::try_from(n.node_id).ok())
            .collect()
    };

    let pure_cycle_edge_pairs: Vec<[u32; 2]> = {
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        graph_analytics.pure_cycle_edge_indices.iter()
            .filter_map(|&idx| {
                let edge = nav.edge_by_idx(idx);
                let from_node = nav.nodes.get(edge.from)?.node_id;
                let to_node   = nav.nodes.get(edge.to)?.node_id;
                let from = u32::try_from(from_node).ok()?;
                let to   = u32::try_from(to_node).ok()?;
                Some([from, to])
            })
            .collect()
    };

    let scc = maze.analysis.scc(&maze.graph);
    let node_component: HashMap<u32, usize> = scc.components.iter()
        .enumerate()
        .flat_map(|(comp_id, comp)| {
            comp.iter().filter_map(move |&node_id| {
                u32::try_from(node_id).ok().map(|id| (id, comp_id))
            })
        })
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
    };

    let raw_node_stats = compute_node_stats(&maze.graph, &maze.field);
    let node_stats = NodeStatsDto {
        dead_ends: raw_node_stats.dead_ends,
        straight:  raw_node_stats.straight,
        turns:     raw_node_stats.turns,
        junctions: raw_node_stats.junctions.iter()
            .map(|&(degree, count)| JunctionBucket { degree, count })
            .collect(),
    };

    let raw_edge_stats = compute_spatial_edge_stats(&maze.graph, &maze.field);
    let edge_stats = SpatialEdgeStatsDto {
        bidirectional: raw_edge_stats.bidirectional,
        one_way:       raw_edge_stats.one_way,
        walls:         raw_edge_stats.walls,
    };

    let route_info = match (maze.meta.start, maze.meta.finish) {
        (Some(s), Some(f)) => {
            maze.analysis.route_info(&maze.graph, s, f).map(|r| RouteInfoDto {
                path_length:    r.path_length,
                junction_count: r.junction_count,
                one_way_count:  r.one_way_count,
                score:          maze.meta.route_score,
                path:           r.path.iter().filter_map(|&id| u32::try_from(id).ok()).collect(),
            })
        }
        _ => None,
    };

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
        route_info,
        graph_analytics: graph_analytics_dto,
        debug_steps: vec![],
    })
}
