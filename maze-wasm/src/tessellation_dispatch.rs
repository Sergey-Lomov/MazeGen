use crate::generation_config::{GenerateConfig, TessellationType};
use crate::result::GenerateResult;
use crate::runner::run_generate;
use maze_core::{
    ids::IdGenerator,
    space::{
        Field, HexPoint, HexTessellation, MultiLevelField, SquarePoint, SquareTessellation,
        Tessellation, TriPoint, TriTessellation,
    },
};
use wasm_bindgen::prelude::*;

pub fn pick_start<P: Copy>(points: &[P], to_xy: impl Fn(P) -> (i32, i32)) -> P {
    let n = points.len() as i32;
    let cx: i32 = points.iter().map(|&p| to_xy(p).0).sum::<i32>() / n;
    let cy: i32 = points.iter().map(|&p| to_xy(p).1).sum::<i32>() / n;
    *points
        .iter()
        .min_by_key(|&&p| {
            let (x, y) = to_xy(p);
            (x - cx) * (x - cx) + (y - cy) * (y - cy)
        })
        .unwrap()
}

fn resolve_start<P: Copy>(
    pts: &[P],
    gen_source_xy: Option<[i32; 2]>,
    to_xy: impl Fn(P) -> (i32, i32),
) -> P {
    if let Some([px, py]) = gen_source_xy
        && let Some(&p) = pts.iter().find(|&&p| to_xy(p) == (px, py))
    {
        return p;
    }
    pick_start(pts, to_xy)
}

/// Builds a `level_fields.len()`-level field, each level's own point set (GitHub issue #338 —
/// per-floor field shape). `level_fields` must have at least one entry (validated by the caller);
/// there is no separate level-count field on the wire, so the field count and `level_fields.len()`
/// can never disagree.
fn build_multi_level_field<T: Tessellation>(
    mut level_points: Vec<Vec<T::Point>>,
    ids: &mut IdGenerator,
) -> Result<MultiLevelField<T>, JsValue> {
    let first = level_points.remove(0);
    let mut mf = MultiLevelField::<T>::single_level(first, ids).map_err(JsValue::from_str)?;
    for points in level_points {
        let field = Field::<T>::new(points, ids).map_err(JsValue::from_str)?;
        mf.add_level(field);
    }
    Ok(mf)
}

pub fn dispatch_generate(seed: u64, config: &GenerateConfig) -> Result<GenerateResult, JsValue> {
    let mut ids = IdGenerator::new();
    let gen_source_xy = config.preset_gen_source.as_ref().map(|dto| dto.point);
    if config.level_fields.is_empty() {
        return Err(JsValue::from_str("level_fields must not be empty"));
    }
    match config.tessellation.tessellation_type {
        TessellationType::Square => {
            let level_points: Vec<Vec<SquarePoint>> = config
                .level_fields
                .iter()
                .map(|raw| raw.iter().map(|&[x, y]| SquarePoint { x, y }).collect())
                .collect();
            if level_points.iter().any(|pts| pts.is_empty()) {
                return Err(JsValue::from_str("level_fields entry must not be empty"));
            }
            let start = resolve_start(&level_points[0], gen_source_xy, |p| (p.x, p.y));
            let field = build_multi_level_field::<SquareTessellation>(level_points, &mut ids)?;
            run_generate(
                seed,
                field,
                ids,
                start,
                config,
                |p: SquarePoint| (p.x, p.y),
                |x, y| SquarePoint { x, y },
            )
        }
        TessellationType::Hex => {
            let level_points: Vec<Vec<HexPoint>> = config
                .level_fields
                .iter()
                .map(|raw| raw.iter().map(|&[q, r]| HexPoint { q, r }).collect())
                .collect();
            if level_points.iter().any(|pts| pts.is_empty()) {
                return Err(JsValue::from_str("level_fields entry must not be empty"));
            }
            let start = resolve_start(&level_points[0], gen_source_xy, |p| (p.q, p.r));
            let field = build_multi_level_field::<HexTessellation>(level_points, &mut ids)?;
            run_generate(
                seed,
                field,
                ids,
                start,
                config,
                |p: HexPoint| (p.q, p.r),
                |q, r| HexPoint { q, r },
            )
        }
        TessellationType::Tri => {
            let level_points: Vec<Vec<TriPoint>> = config
                .level_fields
                .iter()
                .map(|raw| {
                    raw.iter()
                        .map(|&[col, row]| TriPoint { col, row })
                        .collect()
                })
                .collect();
            if level_points.iter().any(|pts| pts.is_empty()) {
                return Err(JsValue::from_str("level_fields entry must not be empty"));
            }
            let start = resolve_start(&level_points[0], gen_source_xy, |p| (p.col, p.row));
            let field = build_multi_level_field::<TriTessellation>(level_points, &mut ids)?;
            run_generate(
                seed,
                field,
                ids,
                start,
                config,
                |p: TriPoint| (p.col, p.row),
                |col, row| TriPoint { col, row },
            )
        }
    }
}
