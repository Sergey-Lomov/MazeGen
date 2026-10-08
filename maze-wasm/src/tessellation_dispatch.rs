use crate::generation_config::{GenerateConfig, TessellationType};
use crate::result::GenerateResult;
use crate::runner::run_generate;
use maze_core::{
    generation::resolve_generation_start,
    ids::IdGenerator,
    space::{
        CairoPoint, CairoTessellation, Field, HexPoint, HexTessellation, MultiLevelField,
        SquarePoint, SquareTessellation, Tessellation, TriPoint, TriTessellation,
    },
};
use wasm_bindgen::prelude::*;

/// Resolves the geometric fallback start point (GitHub issue #640) — a pin matching
/// `gen_source_xy` wins if present, otherwise falls back to `mode` (default centroid-nearest, or
/// seeded-random). Thin wrapper over `maze_core::generation::resolve_generation_start` that keeps
/// this crate's coordinate-match pin lookup, matching `maze-runner`'s equivalent wrapper.
fn resolve_start<P: Copy>(
    pts: &[P],
    gen_source_xy: Option<[i32; 2]>,
    mode: maze_core::generation::GenerationSourceMode,
    seed: u64,
    to_xy: impl Fn(P) -> (i32, i32),
) -> P {
    let pinned = gen_source_xy.and_then(|[px, py]| {
        pts.iter().copied().find(|&p| to_xy(p) == (px, py))
    });
    resolve_generation_start(pts, pinned, mode, seed, to_xy)
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
    let gen_source_mode =
        crate::generation_config::build_generation_source_mode(&config.generation_source_mode);
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
            let start = resolve_start(&level_points[0], gen_source_xy, gen_source_mode, seed, |p| {
                (p.x, p.y)
            });
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
            let start = resolve_start(&level_points[0], gen_source_xy, gen_source_mode, seed, |p| {
                (p.q, p.r)
            });
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
            let start = resolve_start(&level_points[0], gen_source_xy, gen_source_mode, seed, |p| {
                (p.col, p.row)
            });
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
        TessellationType::Cairo => {
            let level_points: Vec<Vec<CairoPoint>> = config
                .level_fields
                .iter()
                .map(|raw| raw.iter().map(|&[x, y]| CairoPoint { x, y }).collect())
                .collect();
            if level_points.iter().any(|pts| pts.is_empty()) {
                return Err(JsValue::from_str("level_fields entry must not be empty"));
            }
            let start = resolve_start(&level_points[0], gen_source_xy, gen_source_mode, seed, |p| {
                (p.x, p.y)
            });
            let field = build_multi_level_field::<CairoTessellation>(level_points, &mut ids)?;
            run_generate(
                seed,
                field,
                ids,
                start,
                config,
                |p: CairoPoint| (p.x, p.y),
                |x, y| CairoPoint { x, y },
            )
        }
    }
}
