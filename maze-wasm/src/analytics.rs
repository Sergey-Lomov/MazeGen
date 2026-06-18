use std::collections::HashMap;
use maze_core::{
    space::Tessellation,
    quality_control::QualityControlEngine,
    compute_node_stats, compute_spatial_edge_stats, compute_route_info, compute_graph_analytics,
    Maze,
};
use crate::dto::{
    EdgeDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto,
    NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto, JunctionBucket,
    GraphAnalyticsDto,
};

/// Compute analytics snapshot from a fully-built maze.
/// `qc_engine`: run quality checks (no repair). Pass None to skip QC.
/// `warnings_override`: if Some, skip QC and use these warnings instead.
pub fn build_analytics_snapshot<T: Tessellation>(
    maze: &mut Maze<T>,
    qc_engine: Option<&QualityControlEngine<T>>,
    warnings_override: Option<Vec<String>>,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<MazeSnapshot, String> {
    let warnings = if let Some(w) = warnings_override {
        w
    } else if let Some(qc) = qc_engine {
        qc.run(maze).into_iter().map(|issue| issue.kind.to_string()).collect()
    } else {
        vec![]
    };

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

    let graph_analytics = compute_graph_analytics(maze.analysis.nav_graph(&maze.graph));

    let nav_nodes: Vec<NavNodeDto> = maze.analysis.nav_graph(&maze.graph).nodes.iter()
        .filter_map(|n| u32::try_from(n.node_id).ok().map(|id| NavNodeDto { node_id: id }))
        .collect();
    let nav_edges: Vec<NavEdgeDto> = maze.analysis.nav_graph(&maze.graph).edges()
        .filter_map(|e| {
            let from = u32::try_from(e.from).ok()?;
            let to   = u32::try_from(e.to).ok()?;
            let path = e.path.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
            Some(NavEdgeDto { from, to, path })
        })
        .collect();

    let cyclic_node_ids: Vec<u32> = {
        let nav = maze.analysis.nav_graph(&maze.graph);
        graph_analytics.cyclic_core_nav_nodes.iter()
            .filter_map(|&nav_id| nav.nodes.get(nav_id))
            .filter_map(|n| u32::try_from(n.node_id).ok())
            .collect()
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

    // node_component: full-graph SCC → each maze node gets its component id.
    // Bidirectional edges form SCCs = full connected components (same as WCC for undirected).
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
        cyclic_node_ids,
    };

    let route_info = if let (Some(start), Some(finish)) = (maze.meta.start, maze.meta.finish) {
        let pinned: std::collections::HashSet<maze_core::ids::NodeId> =
            [start, finish].into_iter().collect();
        let nav = maze.analysis.nav_graph_pinned(&maze.graph, &pinned);
        compute_route_info(nav, start, finish).map(|r| RouteInfoDto {
            path_length:    r.path_length,
            junction_count: r.junction_count,
            one_way_count:  r.one_way_count,
            score:          None,
            path:           r.path.iter().filter_map(|&id| u32::try_from(id).ok()).collect(),
        })
    } else {
        None
    };

    Ok(MazeSnapshot {
        nodes,
        edges,
        start:  meta_start,
        finish: meta_finish,
        warnings,
        nav_nodes,
        nav_edges,
        node_stats,
        edge_stats,
        route_info,
        graph_analytics: graph_analytics_dto,
        debug_steps: vec![],
    })
}
