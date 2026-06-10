use wasm_bindgen::prelude::*;
use maze_core::{
    ids::IdGenerator,
    space::{
        Field,
        SquareTessellation, SquarePoint, square_rect,
        HexTessellation, HexPoint, hex_parallelogram, hex_hexagon,
        TriTessellation, TriPoint, tri_rect, tri_triangle, tri_hexagon,
    },
};
use crate::generation_config::{GenerateConfig, TessellationConfig};
use crate::runner::{run_generate, run_generate_steps};

pub fn pick_start<P: Copy>(points: &[P], to_xy: impl Fn(P) -> (i32, i32)) -> P {
    let n = points.len() as i32;
    let cx: i32 = points.iter().map(|&p| to_xy(p).0).sum::<i32>() / n;
    let cy: i32 = points.iter().map(|&p| to_xy(p).1).sum::<i32>() / n;
    *points.iter().min_by_key(|&&p| {
        let (x, y) = to_xy(p);
        (x - cx) * (x - cx) + (y - cy) * (y - cy)
    }).unwrap()
}

macro_rules! dispatch_tessellation {
    ($runner:ident, $seed:expr, $config:expr, $ids:expr) => {
        match &$config.tessellation {
            TessellationConfig::Square { width, height } => {
                if *width == 0 || *height == 0 {
                    return Err(JsValue::from_str("width and height must be > 0"));
                }
                let field = Field::<SquareTessellation>::new(
                    square_rect(*width as usize, *height as usize), &mut $ids,
                ).map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, SquarePoint { x: 0, y: 0 }, $config, |p: SquarePoint| (p.x, p.y))
            }
            TessellationConfig::HexParallelogram { cols, rows, .. } => {
                if *cols == 0 || *rows == 0 {
                    return Err(JsValue::from_str("cols and rows must be > 0"));
                }
                let field = Field::<HexTessellation>::new(
                    hex_parallelogram(*cols as usize, *rows as usize), &mut $ids,
                ).map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, HexPoint { q: 0, r: 0 }, $config, |p: HexPoint| (p.q, p.r))
            }
            TessellationConfig::HexHexagon { radius, .. } => {
                if *radius == 0 {
                    return Err(JsValue::from_str("radius must be > 0"));
                }
                let field = Field::<HexTessellation>::new(
                    hex_hexagon(*radius as usize), &mut $ids,
                ).map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, HexPoint { q: 0, r: 0 }, $config, |p: HexPoint| (p.q, p.r))
            }
            TessellationConfig::TriangleRect { cols, rows, .. } => {
                if *cols == 0 || *rows == 0 {
                    return Err(JsValue::from_str("cols and rows must be > 0"));
                }
                let field = Field::<TriTessellation>::new(
                    tri_rect(*cols as usize, *rows as usize), &mut $ids,
                ).map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, TriPoint { col: 0, row: 0 }, $config, |p: TriPoint| (p.col, p.row))
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
                    tri_triangle(*side as usize), &mut $ids,
                ).map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, TriPoint { col: apex_col, row: 0 }, $config, |p: TriPoint| (p.col, p.row))
            }
            TessellationConfig::TriangleHexagon { radius, .. } => {
                if *radius == 0 {
                    return Err(JsValue::from_str("radius must be > 0"));
                }
                // Start at first (pointing-down) triangle in top row: col = odd_base = indent(0).
                let r = *radius as i32;
                let odd_base = if r % 2 == 0 { r - 1 } else { r };
                let field = Field::<TriTessellation>::new(
                    tri_hexagon(*radius as usize), &mut $ids,
                ).map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, TriPoint { col: odd_base, row: 0 }, $config, |p: TriPoint| (p.col, p.row))
            }
            TessellationConfig::SquareCustom { points } => {
                let pts: Vec<SquarePoint> = points.iter().map(|&[x, y]| SquarePoint { x, y }).collect();
                let start = pick_start(&pts, |p| (p.x, p.y));
                let field = Field::<SquareTessellation>::new(pts, &mut $ids)
                    .map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, start, $config, |p: SquarePoint| (p.x, p.y))
            }
            TessellationConfig::HexCustom { points } => {
                let pts: Vec<HexPoint> = points.iter().map(|&[q, r]| HexPoint { q, r }).collect();
                let start = pick_start(&pts, |p| (p.q, p.r));
                let field = Field::<HexTessellation>::new(pts, &mut $ids)
                    .map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, start, $config, |p: HexPoint| (p.q, p.r))
            }
            TessellationConfig::TriCustom { points } => {
                let pts: Vec<TriPoint> = points.iter().map(|&[col, row]| TriPoint { col, row }).collect();
                let start = pick_start(&pts, |p| (p.col, p.row));
                let field = Field::<TriTessellation>::new(pts, &mut $ids)
                    .map_err(|e| JsValue::from_str(e))?;
                $runner($seed, field, start, $config, |p: TriPoint| (p.col, p.row))
            }
        }
    };
}

pub fn dispatch_generate(seed: u64, config: &GenerateConfig) -> Result<JsValue, JsValue> {
    let mut ids = IdGenerator::new();
    dispatch_tessellation!(run_generate, seed, config, ids)
}

pub fn dispatch_generate_steps(seed: u64, config: &GenerateConfig) -> Result<JsValue, JsValue> {
    let mut ids = IdGenerator::new();
    dispatch_tessellation!(run_generate_steps, seed, config, ids)
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
