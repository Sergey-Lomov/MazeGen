use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use maze_core::{
    graph::Graph,
    space::{Field, Tessellation},
    generation::{generate_maze, generate_maze_steps},
    quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MinLoopsCountCheck, MIN_LOOPS_DEFAULT, IssueKind},
    repair::{RepairEngine, RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy},
    compute_node_stats, compute_spatial_edge_stats, compute_route_info,
};
use crate::generation_config::{GenerateConfig, build_generation_config};
use crate::dto::{
    EdgeDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto,
    GenerationStepDto, GenerationStepsSnapshot,
    NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto, JunctionBucket,
};

pub fn build_qc_and_repair<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>), JsValue> {
    let mut checks: Vec<Box<dyn maze_core::quality_control::Check<T>>> = Vec::new();
    for id in &config.checks {
        match id.as_str() {
            "missing_endpoints" => checks.push(Box::new(MissingEndpointsCheck)),
            "unreachable_finish" => checks.push(Box::new(UnreachableFinishCheck)),
            "min_loops_count" => {
                let min_loops = config.check_params
                    .get("min_loops_count")
                    .and_then(|p| p.get("min_loops"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.max(1) as u32)
                    .unwrap_or(MIN_LOOPS_DEFAULT);
                checks.push(Box::new(MinLoopsCountCheck { min_loops }));
            }
            other => return Err(JsValue::from_str(&format!("unknown check: {other}"))),
        }
    }
    let qc_engine = QualityControlEngine::new(checks);

    let mut strategies: HashMap<_, Box<dyn RepairStrategy<T>>> = HashMap::new();
    let mut param_overrides: HashMap<IssueKind, HashMap<String, String>> = HashMap::new();

    for (issue_kind_str, strategy_cfg) in &config.strategies {
        let kind = IssueKind::from_str(issue_kind_str.as_str())
            .ok_or_else(|| JsValue::from_str(&format!("unknown issue kind: {issue_kind_str}")))?;
        let strategy: Box<dyn RepairStrategy<T>> = match strategy_cfg.id.as_str() {
            "random_endpoints"   => Box::new(RandomEndpointsStrategy),
            "farthest_endpoints" => Box::new(FarthestEndpointsStrategy),
            "scored_endpoints"   => Box::new(ScoredEndpointsStrategy),
            other => return Err(JsValue::from_str(&format!("unknown strategy: {other}"))),
        };
        strategies.insert(kind, strategy);
        if !strategy_cfg.params.is_empty() {
            param_overrides.insert(kind, strategy_cfg.params.clone());
        }
    }
    let repair_engine = RepairEngine::new(strategies, param_overrides);

    Ok((qc_engine, repair_engine))
}

pub fn run_generate<T: Tessellation>(
    seed: u64,
    field: Field<T>,
    start: T::Point,
    config: &GenerateConfig,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<JsValue, JsValue> {
    use maze_core::generation::pipeline::build_maze;

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let start_id = field
        .node_at(start)
        .ok_or_else(|| JsValue::from_str("start node not found"))?;

    let gen_config = build_generation_config(config);
    generate_maze(&mut graph, &field, seed, start_id, gen_config);

    let (qc_engine, repair_engine) = build_qc_and_repair::<T>(config)?;

    let (mut maze, issues) = build_maze(field, graph, seed, qc_engine, repair_engine);
    let warnings: Vec<String> = issues.iter().map(|i| i.kind.to_string()).collect();

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
        .map(|e| -> Result<EdgeDto, JsValue> {
            Ok(EdgeDto {
                from: u32::try_from(e.from).map_err(|_| JsValue::from_str("edge endpoint overflow"))?,
                to:   u32::try_from(e.to).map_err(|_| JsValue::from_str("edge endpoint overflow"))?,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;

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

    let snapshot = MazeSnapshot {
        nodes, edges,
        start: meta_start, finish: meta_finish,
        warnings, nav_nodes, nav_edges, components,
        node_stats, edge_stats, route_info,
    };
    serde_wasm_bindgen::to_value(&snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
}

pub fn run_generate_steps<T: Tessellation>(
    seed: u64,
    field: Field<T>,
    start: T::Point,
    config: &GenerateConfig,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<JsValue, JsValue> {
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let nodes: Vec<NodeDto> = graph.nodes()
        .filter_map(|n| {
            let id = u32::try_from(n.id).ok()?;
            field.point_of(n.id).map(|p| {
                let (x, y) = point_to_xy(p);
                NodeDto { id, x, y }
            })
        })
        .collect();

    let start_id = field
        .node_at(start)
        .ok_or_else(|| JsValue::from_str("start node not found"))?;

    let gen_config = build_generation_config(config);
    let raw_steps = generate_maze_steps(&mut graph, &field, seed, start_id, gen_config);

    let steps: Vec<GenerationStepDto> = raw_steps.into_iter().map(|s| {
        let edges = s.edges.into_iter().filter_map(|e| {
            Some(EdgeDto {
                from: u32::try_from(e.from).ok()?,
                to:   u32::try_from(e.to).ok()?,
            })
        }).collect();
        GenerationStepDto { edges }
    }).collect();

    let snapshot = GenerationStepsSnapshot { nodes, steps };
    serde_wasm_bindgen::to_value(&snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
}
