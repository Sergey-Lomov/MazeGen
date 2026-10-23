use super::resolve_start;
use super::tessellation_factory::{CellCodec, TessellationVisitor, build_tessellation};
use crate::config::{GenerateConfig, build_generation_config, build_generation_source_mode};
use maze_core::{
    generation::GenerationConfig,
    ids::IdGenerator,
    space::{Field, MultiLevelField, Tessellation},
};
use std::sync::Arc;

/// Everything a pipeline stage needs before generation starts, resolved from a
/// `GenerateConfig` for one concrete tessellation: the multi-level field, the id generator that
/// minted it, the geometric start point, and the wire-coordinate conversions both ways.
pub struct Prepared<T: Tessellation> {
    pub seed: u64,
    pub field: MultiLevelField<T>,
    pub ids: IdGenerator,
    pub start: T::CellId,
    pub gen_config: GenerationConfig,
    pub cell_from_xy: fn(i32, i32) -> T::CellId,
    pub cell_to_xy: fn(T::CellId) -> (i32, i32),
}

/// Consumer of a `Prepared` field. Every runner entry point (full run, canonical baselines,
/// benchmarks) shares one tessellation dispatch: `dispatch` builds the instance through
/// `build_tessellation` and hands the prepared field to this visitor.
pub trait PreparedVisitor {
    type Output;
    fn visit<T: Tessellation>(self, prepared: Prepared<T>) -> Result<Self::Output, String>;
}

/// Builds the field described by `config.level_fields` on `config`'s tessellation instance and
/// hands it to `visitor`.
pub fn dispatch<V: PreparedVisitor>(
    seed: u64,
    config: &GenerateConfig,
    visitor: V,
) -> Result<V::Output, String> {
    build_tessellation(
        &config.tessellation,
        PrepareThen {
            seed,
            config,
            visitor,
        },
    )?
}

/// Adapts a `PreparedVisitor` to the tessellation factory: prepares the field on the built
/// instance, then forwards it.
struct PrepareThen<'a, V> {
    seed: u64,
    config: &'a GenerateConfig,
    visitor: V,
}

impl<V: PreparedVisitor> TessellationVisitor for PrepareThen<'_, V> {
    type Output = Result<V::Output, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        self.visitor
            .visit(prepare(self.seed, self.config, tessellation, codec)?)
    }
}

fn prepare<T: Tessellation>(
    seed: u64,
    config: &GenerateConfig,
    tessellation: Arc<T>,
    codec: CellCodec<T>,
) -> Result<Prepared<T>, String> {
    let CellCodec {
        from_xy: cell_from_xy,
        to_xy: cell_to_xy,
    } = codec;
    let to_pts = |raw: &[[i32; 2]]| -> Vec<T::CellId> {
        raw.iter().map(|&[x, y]| cell_from_xy(x, y)).collect()
    };
    let Some((first, rest)) = config.level_fields.split_first() else {
        return Err("level_fields must not be empty".to_string());
    };
    let first_pts = to_pts(first);
    if first_pts.is_empty() {
        return Err("level_fields[0] must not be empty".to_string());
    }

    let gen_source_xy = config.preset_gen_source.as_ref().map(|dto| dto.point);
    let gen_source_mode = build_generation_source_mode(&config.generation_source_mode);
    let start = resolve_start(&first_pts, gen_source_xy, gen_source_mode, seed, cell_to_xy);

    let mut ids = IdGenerator::new();
    let mut field = MultiLevelField::single_level(Arc::clone(&tessellation), first_pts, &mut ids)
        .map_err(|e| e.to_string())?;
    for raw in rest {
        let pts = to_pts(raw);
        if pts.is_empty() {
            return Err("level_fields entry must not be empty".to_string());
        }
        let level =
            Field::new(Arc::clone(&tessellation), pts, &mut ids).map_err(|e| e.to_string())?;
        field.add_level(level);
    }

    Ok(Prepared {
        seed,
        field,
        ids,
        start,
        gen_config: build_generation_config(config),
        cell_from_xy,
        cell_to_xy,
    })
}
