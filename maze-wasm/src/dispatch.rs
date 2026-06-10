use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use maze_core::{
    ids::IdGenerator,
    graph::Graph,
    space::{
        Field, Tessellation,
        SquareTessellation, SquarePoint, square_rect,
        HexTessellation, HexPoint, hex_parallelogram, hex_hexagon,
        TriTessellation, TriPoint, tri_rect, tri_triangle, tri_hexagon,
    },
    generation::{generate_maze, generate_maze_steps},
    quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MISSING_ENDPOINTS, UNREACHABLE_FINISH},
    repair::{RepairEngine, RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy},
    compute_node_stats, compute_spatial_edge_stats, compute_route_info,
};
use crate::generation_config::{GenerateConfig, TessellationConfig, build_generation_config};
use crate::dto::{
    EdgeDto, MazeSnapshot, NavEdgeDto, NavNodeDto, NodeDto,
    GenerationStepDto, GenerationStepsSnapshot,
    NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto, JunctionBucket,
};

pub fn pick_start<P: Copy>(points: &[P], to_xy: impl Fn(P) -> (i32, i32)) -> P {
    let n = points.len() as i32;
    let cx: i32 = points.iter().map(|&p| to_xy(p).0).sum::<i32>() / n;
    let cy: i32 = points.iter().map(|&p| to_xy(p).1).sum::<i32>() / n;
    *points.iter().min_by_key(|&&p| {
        let (x, y) = to_xy(p);
        (x - cx) * (x - cx) + (y - cy) * (y - cy)
    }).unwrap()
}

pub fn build_qc_and_repair<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>), JsValue> {
    let mut checks: Vec<Box<dyn maze_core::quality_control::Check<T>>> = Vec::new();
    for id in &config.checks {
        match id.as_str() {
            MISSING_ENDPOINTS => checks.push(Box::new(MissingEndpointsCheck)),
            UNREACHABLE_FINISH => checks.push(Box::new(UnreachableFinishCheck)),
            other => return Err(JsValue::from_str(&format!("unknown check: {other}"))),
        }
    }
    let qc_engine = QualityControlEngine::new(checks);

    let mut strategies: HashMap<_, Box<dyn RepairStrategy<T>>> = HashMap::new();
    let mut param_overrides: HashMap<&'static str, HashMap<String, String>> = HashMap::new();

    for (issue_kind, strategy_cfg) in &config.strategies {
        let kind: &'static str = match issue_kind.as_str() {
            MISSING_ENDPOINTS => MISSING_ENDPOINTS,
            UNREACHABLE_FINISH => UNREACHABLE_FINISH,
            other => return Err(JsValue::from_str(&format!("unknown issue kind: {other}"))),
        };
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

    let route_score = maze.meta.route_score;
    let route_info = match (maze.meta.start, maze.meta.finish) {
        (Some(s), Some(f)) => {
            let mut pinned = std::collections::HashSet::new();
            pinned.insert(s);
            pinned.insert(f);
            let nav = maze.analysis.nav_graph_pinned(&maze.graph, &pinned);
            compute_route_info(nav, s, f).map(|mut r| {
                r.score = route_score;
                RouteInfoDto {
                    path_length:    r.path_length,
                    junction_count: r.junction_count,
                    one_way_count:  r.one_way_count,
                    score:          r.score,
                    path:           r.path.iter().filter_map(|&id| u32::try_from(id).ok()).collect(),
                }
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

pub fn dispatch_generate(seed: u64, config: &GenerateConfig) -> Result<JsValue, JsValue> {
    let mut ids = IdGenerator::new();
    match &config.tessellation {
        TessellationConfig::Square { width, height } => {
            if *width == 0 || *height == 0 {
                return Err(JsValue::from_str("width and height must be > 0"));
            }
            let field = Field::<SquareTessellation>::new(
                square_rect(*width as usize, *height as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, SquarePoint { x: 0, y: 0 }, config, |p: SquarePoint| (p.x, p.y))
        }
        TessellationConfig::HexParallelogram { cols, rows, .. } => {
            if *cols == 0 || *rows == 0 {
                return Err(JsValue::from_str("cols and rows must be > 0"));
            }
            let field = Field::<HexTessellation>::new(
                hex_parallelogram(*cols as usize, *rows as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, HexPoint { q: 0, r: 0 }, config, |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::HexHexagon { radius, .. } => {
            if *radius == 0 {
                return Err(JsValue::from_str("radius must be > 0"));
            }
            let field = Field::<HexTessellation>::new(
                hex_hexagon(*radius as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, HexPoint { q: 0, r: 0 }, config, |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::TriangleRect { cols, rows, .. } => {
            if *cols == 0 || *rows == 0 {
                return Err(JsValue::from_str("cols and rows must be > 0"));
            }
            let field = Field::<TriTessellation>::new(
                tri_rect(*cols as usize, *rows as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, TriPoint { col: 0, row: 0 }, config, |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::TriangleTriangle { side, .. } => {
            if *side == 0 {
                return Err(JsValue::from_str("side must be > 0"));
            }
            // Apex is at (N-1 + N%2, 0): parity shift ensures apex is pointing-down
            // so it has a Base neighbour in row 1 (required for connectivity).
            let n = *side as i32;
            let apex_col = n - 1 + n % 2;
            let field = Field::<TriTessellation>::new(
                tri_triangle(*side as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, TriPoint { col: apex_col, row: 0 }, config, |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::TriangleHexagon { radius, .. } => {
            if *radius == 0 {
                return Err(JsValue::from_str("radius must be > 0"));
            }
            // Start at first (pointing-down) triangle in top row: col = odd_base = indent(0).
            let r = *radius as i32;
            let odd_base = if r % 2 == 0 { r - 1 } else { r };
            let field = Field::<TriTessellation>::new(
                tri_hexagon(*radius as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, TriPoint { col: odd_base, row: 0 }, config, |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::SquareCustom { points } => {
            let pts: Vec<SquarePoint> = points.iter().map(|&[x, y]| SquarePoint { x, y }).collect();
            let start = pick_start(&pts, |p| (p.x, p.y));
            let field = Field::<SquareTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, start, config, |p: SquarePoint| (p.x, p.y))
        }
        TessellationConfig::HexCustom { points } => {
            let pts: Vec<HexPoint> = points.iter().map(|&[q, r]| HexPoint { q, r }).collect();
            let start = pick_start(&pts, |p| (p.q, p.r));
            let field = Field::<HexTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, start, config, |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::TriCustom { points } => {
            let pts: Vec<TriPoint> = points.iter().map(|&[col, row]| TriPoint { col, row }).collect();
            let start = pick_start(&pts, |p| (p.col, p.row));
            let field = Field::<TriTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, start, config, |p: TriPoint| (p.col, p.row))
        }
    }
}

pub fn dispatch_generate_steps(seed: u64, config: &GenerateConfig) -> Result<JsValue, JsValue> {
    let mut ids = IdGenerator::new();
    match &config.tessellation {
        TessellationConfig::Square { width, height } => {
            if *width == 0 || *height == 0 {
                return Err(JsValue::from_str("width and height must be > 0"));
            }
            let field = Field::<SquareTessellation>::new(
                square_rect(*width as usize, *height as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, SquarePoint { x: 0, y: 0 }, config, |p: SquarePoint| (p.x, p.y))
        }
        TessellationConfig::HexParallelogram { cols, rows, .. } => {
            if *cols == 0 || *rows == 0 {
                return Err(JsValue::from_str("cols and rows must be > 0"));
            }
            let field = Field::<HexTessellation>::new(
                hex_parallelogram(*cols as usize, *rows as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, HexPoint { q: 0, r: 0 }, config, |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::HexHexagon { radius, .. } => {
            if *radius == 0 {
                return Err(JsValue::from_str("radius must be > 0"));
            }
            let field = Field::<HexTessellation>::new(
                hex_hexagon(*radius as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, HexPoint { q: 0, r: 0 }, config, |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::TriangleRect { cols, rows, .. } => {
            if *cols == 0 || *rows == 0 {
                return Err(JsValue::from_str("cols and rows must be > 0"));
            }
            let field = Field::<TriTessellation>::new(
                tri_rect(*cols as usize, *rows as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, TriPoint { col: 0, row: 0 }, config, |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::TriangleTriangle { side, .. } => {
            if *side == 0 {
                return Err(JsValue::from_str("side must be > 0"));
            }
            let n = *side as i32;
            let apex_col = n - 1 + n % 2;
            let field = Field::<TriTessellation>::new(
                tri_triangle(*side as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, TriPoint { col: apex_col, row: 0 }, config, |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::TriangleHexagon { radius, .. } => {
            if *radius == 0 {
                return Err(JsValue::from_str("radius must be > 0"));
            }
            let r = *radius as i32;
            let odd_base = if r % 2 == 0 { r - 1 } else { r };
            let field = Field::<TriTessellation>::new(
                tri_hexagon(*radius as usize), &mut ids,
            ).map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, TriPoint { col: odd_base, row: 0 }, config, |p: TriPoint| (p.col, p.row))
        }
        TessellationConfig::SquareCustom { points } => {
            let pts: Vec<SquarePoint> = points.iter().map(|&[x, y]| SquarePoint { x, y }).collect();
            let start = pick_start(&pts, |p| (p.x, p.y));
            let field = Field::<SquareTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, start, config, |p: SquarePoint| (p.x, p.y))
        }
        TessellationConfig::HexCustom { points } => {
            let pts: Vec<HexPoint> = points.iter().map(|&[q, r]| HexPoint { q, r }).collect();
            let start = pick_start(&pts, |p| (p.q, p.r));
            let field = Field::<HexTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, start, config, |p: HexPoint| (p.q, p.r))
        }
        TessellationConfig::TriCustom { points } => {
            let pts: Vec<TriPoint> = points.iter().map(|&[col, row]| TriPoint { col, row }).collect();
            let start = pick_start(&pts, |p| (p.col, p.row));
            let field = Field::<TriTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate_steps(seed, field, start, config, |p: TriPoint| (p.col, p.row))
        }
    }
}

pub fn dispatch_expand_field_points(config: &TessellationConfig) -> Vec<[i32; 2]> {
    match config {
        TessellationConfig::Square { width, height } =>
            square_rect(*width as usize, *height as usize).into_iter().map(|p| [p.x, p.y]).collect(),
        TessellationConfig::HexParallelogram { cols, rows, .. } =>
            hex_parallelogram(*cols as usize, *rows as usize).into_iter().map(|p| [p.q, p.r]).collect(),
        TessellationConfig::HexHexagon { radius, .. } =>
            hex_hexagon(*radius as usize).into_iter().map(|p| [p.q, p.r]).collect(),
        TessellationConfig::TriangleRect { cols, rows, .. } =>
            tri_rect(*cols as usize, *rows as usize).into_iter().map(|p| [p.col, p.row]).collect(),
        TessellationConfig::TriangleTriangle { side, .. } =>
            tri_triangle(*side as usize).into_iter().map(|p| [p.col, p.row]).collect(),
        TessellationConfig::TriangleHexagon { radius, .. } =>
            tri_hexagon(*radius as usize).into_iter().map(|p| [p.col, p.row]).collect(),
        TessellationConfig::SquareCustom { points } => points.clone(),
        TessellationConfig::HexCustom    { points } => points.clone(),
        TessellationConfig::TriCustom    { points } => points.clone(),
    }
}
