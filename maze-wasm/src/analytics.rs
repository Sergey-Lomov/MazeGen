use maze_core::{
    space::Tessellation,
    quality_control::QualityControlEngine,
    compute_node_stats, compute_spatial_edge_stats, compute_route_info,
    Maze,
};
use crate::dto::{
    EdgeDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto,
    NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto, JunctionBucket,
};

/// Compute analytics snapshot from a fully-built maze (GraphInput).
/// Independent of the generation pipeline — accepts any Maze<T> with a populated graph.
/// `qc_engine`: used to run quality checks (no repair). Pass None to skip QC (e.g. when
/// caller already has authoritative warnings from a repair cycle).
pub fn build_analytics_snapshot<T: Tessellation>(
    maze: &mut Maze<T>,
    qc_engine: Option<&QualityControlEngine<T>>,
    warnings_override: Option<Vec<String>>,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<MazeSnapshot, String> {
    let warnings: Vec<String> = if let Some(w) = warnings_override {
        w
    } else if let Some(engine) = qc_engine {
        engine.run(maze).into_iter().map(|i| i.kind.to_string()).collect()
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

    let nav = maze.analysis.nav_graph(&maze.graph);

    let nav_nodes: Vec<NavNodeDto> = nav.nodes.iter()
        .filter_map(|n| u32::try_from(n.node_id).ok().map(|node_id| NavNodeDto { node_id }))
        .collect();

    let nav_edges: Vec<NavEdgeDto> = nav.edges()
        .filter_map(|e| {
            let from = u32::try_from(e.from).ok()?;
            let to   = u32::try_from(e.to).ok()?;
            let path: Option<Vec<u32>> = e.path.iter()
                .map(|&nid| u32::try_from(nid).ok())
                .collect();
            Some(NavEdgeDto { from, to, path: path? })
        })
        .collect();

    let scc = maze.analysis.scc(&maze.graph);
    let components: Vec<Vec<u32>> = scc.components.iter()
        .map(|comp| comp.iter().filter_map(|&id| u32::try_from(id).ok()).collect())
        .collect();

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
            let mut pinned = std::collections::HashSet::new();
            pinned.insert(s);
            pinned.insert(f);
            let nav = maze.analysis.nav_graph_pinned(&maze.graph, &pinned);
            compute_route_info(nav, s, f).map(|r| RouteInfoDto {
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
        warnings,
        nav_nodes,
        nav_edges,
        components,
        node_stats,
        edge_stats,
        route_info,
        debug_steps: vec![],
    })
}
