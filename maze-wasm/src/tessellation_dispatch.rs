use crate::generation_config::GenerateConfig;
use crate::result::GenerateResult;
use crate::runner::run_generate;
use maze_core::{
    generation::resolve_generation_start,
    ids::IdGenerator,
    space::{Field, MultiLevelField, Tessellation},
};
use maze_runner::runner::tessellation_factory::{
    CellCodec, TessellationVisitor, build_tessellation,
};
use maze_runner::topology_wire::install_topologies;
use std::sync::Arc;
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
    let pinned =
        gen_source_xy.and_then(|[px, py]| pts.iter().copied().find(|&p| to_xy(p) == (px, py)));
    resolve_generation_start(pts, pinned, mode, seed, to_xy)
}

/// Builds a `level_points.len()`-level field on `tessellation`, each level's own point set
/// (GitHub issue #338 — per-floor field shape). `level_points` must have at least one entry
/// (validated by the caller); there is no separate level-count field on the wire, so the field
/// count and `level_fields.len()` can never disagree.
fn build_multi_level_field<T: Tessellation>(
    tessellation: &Arc<T>,
    mut level_points: Vec<Vec<T::CellId>>,
    ids: &mut IdGenerator,
) -> Result<MultiLevelField<T>, JsValue> {
    let first = level_points.remove(0);
    let mut mf = MultiLevelField::single_level(Arc::clone(tessellation), first, ids)
        .map_err(JsValue::from_str)?;
    for points in level_points {
        let field = Field::new(Arc::clone(tessellation), points, ids).map_err(JsValue::from_str)?;
        mf.add_level(field);
    }
    Ok(mf)
}

pub fn dispatch_generate(seed: u64, config: &GenerateConfig) -> Result<GenerateResult, JsValue> {
    if config.level_fields.is_empty() {
        return Err(JsValue::from_str("level_fields must not be empty"));
    }
    build_tessellation(&config.tessellation, GenerateVisitor { seed, config })
        .map_err(|e| JsValue::from_str(&e))?
}

/// Runs generation on the tessellation instance built from `config.tessellation`.
struct GenerateVisitor<'a> {
    seed: u64,
    config: &'a GenerateConfig,
}

impl TessellationVisitor for GenerateVisitor<'_> {
    type Output = Result<GenerateResult, JsValue>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let GenerateVisitor { seed, config } = self;
        let level_points: Vec<Vec<T::CellId>> = config
            .level_fields
            .iter()
            .map(|raw| raw.iter().map(|&[x, y]| (codec.from_xy)(x, y)).collect())
            .collect();
        if level_points.iter().any(|pts| pts.is_empty()) {
            return Err(JsValue::from_str("level_fields entry must not be empty"));
        }
        let gen_source_xy = config.preset_gen_source.as_ref().map(|dto| dto.point);
        let gen_source_mode =
            crate::generation_config::build_generation_source_mode(&config.generation_source_mode);
        let start = resolve_start(
            &level_points[0],
            gen_source_xy,
            gen_source_mode,
            seed,
            codec.to_xy,
        );
        let mut ids = IdGenerator::new();
        let mut field = build_multi_level_field(&tessellation, level_points, &mut ids)?;
        install_topologies(
            &mut field,
            &config.topology,
            tessellation.as_ref(),
            |x, y| Some((codec.from_xy)(x, y)),
            &config.tessellation,
        )
        .map_err(|e| JsValue::from_str(&e))?;
        run_generate(seed, field, ids, start, config, codec.to_xy, codec.from_xy)
    }
}
