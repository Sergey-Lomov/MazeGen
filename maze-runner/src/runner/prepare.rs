use super::resolve_start;
use crate::config::{
    GenerateConfig, TessellationType, build_generation_config, build_generation_source_mode,
};
use maze_core::{
    generation::GenerationConfig,
    ids::IdGenerator,
    space::{
        CairoPoint, CairoTessellation, Field, HexPoint, HexTessellation, MultiLevelField,
        SquarePoint, SquareTessellation, Tessellation, TriPoint, TriTessellation,
    },
};

/// Everything a pipeline stage needs before generation starts, resolved from a
/// `GenerateConfig` for one concrete tessellation: the multi-level field, the id generator that
/// minted it, the geometric start point, and the wire-coordinate conversions both ways.
pub struct Prepared<T: Tessellation> {
    pub seed: u64,
    pub field: MultiLevelField<T>,
    pub ids: IdGenerator,
    pub start: T::Point,
    pub gen_config: GenerationConfig,
    pub point_from_xy: fn(i32, i32) -> T::Point,
    pub point_to_xy: fn(T::Point) -> (i32, i32),
}

/// Consumer of a `Prepared` field — the single place where the runtime `TessellationType` turns
/// into a compile-time `T`, so every runner entry point (full run, canonical baselines,
/// benchmarks) shares one dispatch.
pub trait TessellationVisitor {
    type Output;
    fn visit<T: Tessellation + 'static>(
        self,
        prepared: Prepared<T>,
    ) -> Result<Self::Output, String>;
}

/// Builds the field described by `config.level_fields` for `config`'s tessellation and hands it
/// to `visitor`.
pub fn dispatch<V: TessellationVisitor>(
    seed: u64,
    config: &GenerateConfig,
    visitor: V,
) -> Result<V::Output, String> {
    match config.tessellation.tessellation_type {
        TessellationType::Square => visitor.visit(prepare::<SquareTessellation>(
            seed,
            config,
            |x, y| SquarePoint { x, y },
            |p| (p.x, p.y),
        )?),
        TessellationType::Hex => visitor.visit(prepare::<HexTessellation>(
            seed,
            config,
            |q, r| HexPoint { q, r },
            |p| (p.q, p.r),
        )?),
        TessellationType::Tri => visitor.visit(prepare::<TriTessellation>(
            seed,
            config,
            |col, row| TriPoint { col, row },
            |p| (p.col, p.row),
        )?),
        TessellationType::Cairo => visitor.visit(prepare::<CairoTessellation>(
            seed,
            config,
            |x, y| CairoPoint { x, y },
            |p| (p.x, p.y),
        )?),
    }
}

fn prepare<T: Tessellation>(
    seed: u64,
    config: &GenerateConfig,
    point_from_xy: fn(i32, i32) -> T::Point,
    point_to_xy: fn(T::Point) -> (i32, i32),
) -> Result<Prepared<T>, String> {
    let to_pts = |raw: &[[i32; 2]]| -> Vec<T::Point> {
        raw.iter().map(|&[x, y]| point_from_xy(x, y)).collect()
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
    let start = resolve_start(
        &first_pts,
        gen_source_xy,
        gen_source_mode,
        seed,
        point_to_xy,
    );

    let mut ids = IdGenerator::new();
    let mut field =
        MultiLevelField::<T>::single_level(first_pts, &mut ids).map_err(|e| e.to_string())?;
    for raw in rest {
        let pts = to_pts(raw);
        if pts.is_empty() {
            return Err("level_fields entry must not be empty".to_string());
        }
        let level = Field::<T>::new(pts, &mut ids).map_err(|e| e.to_string())?;
        field.add_level(level);
    }

    Ok(Prepared {
        seed,
        field,
        ids,
        start,
        gen_config: build_generation_config(config),
        point_from_xy,
        point_to_xy,
    })
}
