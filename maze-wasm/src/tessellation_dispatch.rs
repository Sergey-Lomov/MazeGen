use wasm_bindgen::prelude::*;
use maze_core::{
    ids::IdGenerator,
    space::{
        Field,
        SquareTessellation, SquarePoint,
        HexTessellation, HexPoint,
        TriTessellation, TriPoint,
    },
};
use crate::generation_config::{GenerateConfig, TessellationType};
use crate::runner::run_generate;

pub fn pick_start<P: Copy>(points: &[P], to_xy: impl Fn(P) -> (i32, i32)) -> P {
    let n = points.len() as i32;
    let cx: i32 = points.iter().map(|&p| to_xy(p).0).sum::<i32>() / n;
    let cy: i32 = points.iter().map(|&p| to_xy(p).1).sum::<i32>() / n;
    *points.iter().min_by_key(|&&p| {
        let (x, y) = to_xy(p);
        (x - cx) * (x - cx) + (y - cy) * (y - cy)
    }).unwrap()
}

fn resolve_start<P: Copy>(pts: &[P], preset_xy: Option<[i32; 2]>, to_xy: impl Fn(P) -> (i32, i32)) -> P {
    if let Some([px, py]) = preset_xy {
        if let Some(&p) = pts.iter().find(|&&p| to_xy(p) == (px, py)) {
            return p;
        }
    }
    pick_start(pts, to_xy)
}

pub fn dispatch_generate(seed: u64, config: &GenerateConfig) -> Result<JsValue, JsValue> {
    let mut ids = IdGenerator::new();
    match config.tessellation.tessellation_type {
        TessellationType::Square => {
            let pts: Vec<SquarePoint> = config.tessellation.points.iter()
                .map(|&[x, y]| SquarePoint { x, y }).collect();
            if pts.is_empty() { return Err(JsValue::from_str("tessellation points must not be empty")); }
            let start = resolve_start(&pts, config.preset_start, |p| (p.x, p.y));
            let field = Field::<SquareTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, start, config, |p: SquarePoint| (p.x, p.y))
        }
        TessellationType::Hex => {
            let pts: Vec<HexPoint> = config.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            if pts.is_empty() { return Err(JsValue::from_str("tessellation points must not be empty")); }
            let start = resolve_start(&pts, config.preset_start, |p| (p.q, p.r));
            let field = Field::<HexTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, start, config, |p: HexPoint| (p.q, p.r))
        }
        TessellationType::Tri => {
            let pts: Vec<TriPoint> = config.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            if pts.is_empty() { return Err(JsValue::from_str("tessellation points must not be empty")); }
            let start = resolve_start(&pts, config.preset_start, |p| (p.col, p.row));
            let field = Field::<TriTessellation>::new(pts, &mut ids)
                .map_err(|e| JsValue::from_str(e))?;
            run_generate(seed, field, start, config, |p: TriPoint| (p.col, p.row))
        }
    }
}

