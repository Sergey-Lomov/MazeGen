use crate::generation_config::GenerateConfig;
use crate::result::GenerateResult;
use crate::runner::run_generate;
use maze_core::{
    ids::IdGenerator,
    space::{Field, MultiLevelField, Tessellation},
};
use maze_runner::runner::resolve_start;
use maze_runner::runner::tessellation_factory::{
    CellCodec, TessellationVisitor, build_tessellation,
};
use maze_runner::topology_wire::install_topologies;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

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
