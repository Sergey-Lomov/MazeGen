use wasm_bindgen::prelude::*;
use maze_core::{
    ids::IdGenerator,
    space::{
        Field, MultiLevelField, Tessellation,
        SquareTessellation, SquarePoint,
        HexTessellation, HexPoint,
        TriTessellation, TriPoint,
    },
};
use crate::generation_config::{GenerateConfig, TessellationType};
use crate::result::GenerateResult;
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

fn resolve_start<P: Copy>(pts: &[P], gen_source_xy: Option<[i32; 2]>, to_xy: impl Fn(P) -> (i32, i32)) -> P {
    if let Some([px, py]) = gen_source_xy {
        if let Some(&p) = pts.iter().find(|&&p| to_xy(p) == (px, py)) {
            return p;
        }
    }
    pick_start(pts, to_xy)
}

/// Builds a `level_count`-level field, every level sharing the same `points` (per-level field
/// editing doesn't exist yet — see the #333 epic). `level_count` is clamped to at least 1 so a
/// malformed/omitted config still produces a valid single-level field, matching the pre-#337
/// behavior.
fn build_multi_level_field<T: Tessellation>(
    points: Vec<T::Point>,
    level_count: usize,
    ids: &mut IdGenerator,
) -> Result<MultiLevelField<T>, JsValue> {
    let level_count = level_count.max(1);
    let mut mf = MultiLevelField::<T>::single_level(points.clone(), ids)
        .map_err(|e| JsValue::from_str(e))?;
    for _ in 1..level_count {
        let field = Field::<T>::new(points.clone(), ids).map_err(|e| JsValue::from_str(e))?;
        mf.add_level(field);
    }
    Ok(mf)
}

pub fn dispatch_generate(seed: u64, config: &GenerateConfig) -> Result<GenerateResult, JsValue> {
    let mut ids = IdGenerator::new();
    let gen_source_xy = config.preset_gen_source.as_ref().map(|dto| dto.point);
    match config.tessellation.tessellation_type {
        TessellationType::Square => {
            let pts: Vec<SquarePoint> = config.tessellation.points.iter()
                .map(|&[x, y]| SquarePoint { x, y }).collect();
            if pts.is_empty() { return Err(JsValue::from_str("tessellation points must not be empty")); }
            let start = resolve_start(&pts, gen_source_xy, |p| (p.x, p.y));
            let field = build_multi_level_field::<SquareTessellation>(pts, config.level_count, &mut ids)?;
            run_generate(seed, field, ids, start, config, |p: SquarePoint| (p.x, p.y), |x, y| SquarePoint { x, y })
        }
        TessellationType::Hex => {
            let pts: Vec<HexPoint> = config.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            if pts.is_empty() { return Err(JsValue::from_str("tessellation points must not be empty")); }
            let start = resolve_start(&pts, gen_source_xy, |p| (p.q, p.r));
            let field = build_multi_level_field::<HexTessellation>(pts, config.level_count, &mut ids)?;
            run_generate(seed, field, ids, start, config, |p: HexPoint| (p.q, p.r), |q, r| HexPoint { q, r })
        }
        TessellationType::Tri => {
            let pts: Vec<TriPoint> = config.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            if pts.is_empty() { return Err(JsValue::from_str("tessellation points must not be empty")); }
            let start = resolve_start(&pts, gen_source_xy, |p| (p.col, p.row));
            let field = build_multi_level_field::<TriTessellation>(pts, config.level_count, &mut ids)?;
            run_generate(seed, field, ids, start, config, |p: TriPoint| (p.col, p.row), |col, row| TriPoint { col, row })
        }
    }
}

