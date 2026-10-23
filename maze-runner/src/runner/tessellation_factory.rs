use crate::config::{TessellationConfig, TessellationKind};
use maze_core::space::{
    BrickPoint, BrickTessellation, CairoPoint, CairoTessellation, CurvedQuadrilateralPoint,
    CurvedQuadrilateralTessellation, ElongatedTriangularPoint, ElongatedTriangularTessellation,
    HexPoint, HexTessellation, RadialLayout, RadialParams, RadialPoint, RadialTessellation,
    RhombitrihexagonalPoint, RhombitrihexagonalTessellation, SnubHexagonalPoint,
    SnubHexagonalTessellation, SnubSquarePoint, SnubSquareTessellation, SquareOctagonPoint,
    SquareOctagonTessellation, SquarePoint, SquareTessellation, Tessellation, TriPoint,
    TriTessellation, TrihexagonalPoint, TrihexagonalTessellation, TruncatedHexagonalPoint,
    TruncatedHexagonalTessellation, TruncatedTrihexagonalPoint, TruncatedTrihexagonalTessellation,
    VoronoiParams, VoronoiPoint, VoronoiTessellation,
};
use std::sync::Arc;

/// Wire encoding of a tessellation's points as `[i32; 2]` pairs. Defined per kind by the factory;
/// it round-trips only under the same tessellation config.
pub struct CellCodec<T: Tessellation> {
    pub from_xy: fn(i32, i32) -> T::CellId,
    pub to_xy: fn(T::CellId) -> (i32, i32),
}

impl<T: Tessellation> CellCodec<T> {
    /// Decodes caller-supplied wire points into cells, naming the first one that is not a cell of
    /// `tessellation`. Per-cell `Tessellation` queries treat an invalid cell as a precondition
    /// violation (panic in debug builds, a wrong answer in release), so every wire entry point
    /// that accepts raw points decodes them through this.
    pub fn decode_valid(
        &self,
        tessellation: &T,
        points: &[[i32; 2]],
    ) -> Result<Vec<T::CellId>, String> {
        points
            .iter()
            .map(|&[x, y]| {
                let cell = (self.from_xy)(x, y);
                if tessellation.is_valid_cell(cell) {
                    Ok(cell)
                } else {
                    Err(format!("invalid cell [{x}, {y}]"))
                }
            })
            .collect()
    }
}

impl<T: Tessellation> Clone for CellCodec<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T: Tessellation> Copy for CellCodec<T> {}

/// Consumer of a freshly built tessellation instance — the single place where a runtime
/// `TessellationKind` turns into a compile-time `T`. Every `maze-runner`/`maze-wasm` entry point
/// goes through `build_tessellation` with its own visitor.
pub trait TessellationVisitor {
    type Output;
    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output;
}

/// Builds the tessellation instance described by `config` and hands it to `visitor`. The same
/// config always yields an equivalent instance. Invalid params are rejected with a reason.
pub fn build_tessellation<V: TessellationVisitor>(
    config: &TessellationConfig,
    visitor: V,
) -> Result<V::Output, String> {
    match config.kind {
        TessellationKind::Square => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(SquareTessellation),
                CellCodec {
                    from_xy: |x, y| SquarePoint { x, y },
                    to_xy: |p| (p.x, p.y),
                },
            ))
        }
        TessellationKind::Hex => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(HexTessellation),
                CellCodec {
                    from_xy: |q, r| HexPoint { q, r },
                    to_xy: |p| (p.q, p.r),
                },
            ))
        }
        TessellationKind::Tri => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(TriTessellation),
                CellCodec {
                    from_xy: |col, row| TriPoint { col, row },
                    to_xy: |p| (p.col, p.row),
                },
            ))
        }
        TessellationKind::Cairo => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(CairoTessellation),
                CellCodec {
                    from_xy: |x, y| CairoPoint { x, y },
                    to_xy: |p| (p.x, p.y),
                },
            ))
        }
        TessellationKind::Brick => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(BrickTessellation),
                CellCodec {
                    from_xy: |x, y| BrickPoint { x, y },
                    to_xy: |p| (p.x, p.y),
                },
            ))
        }
        TessellationKind::SquareOctagon => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(SquareOctagonTessellation),
                CellCodec {
                    from_xy: |x, y| SquareOctagonPoint { x, y },
                    to_xy: |p| (p.x, p.y),
                },
            ))
        }
        TessellationKind::SnubHexagonal => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(SnubHexagonalTessellation),
                CellCodec {
                    from_xy: SnubHexagonalPoint::from_xy,
                    to_xy: SnubHexagonalPoint::to_xy,
                },
            ))
        }
        TessellationKind::SnubSquare => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(SnubSquareTessellation),
                CellCodec {
                    from_xy: SnubSquarePoint::from_xy,
                    to_xy: SnubSquarePoint::to_xy,
                },
            ))
        }
        TessellationKind::Rhombitrihexagonal => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(RhombitrihexagonalTessellation),
                CellCodec {
                    from_xy: RhombitrihexagonalPoint::from_xy,
                    to_xy: RhombitrihexagonalPoint::to_xy,
                },
            ))
        }
        TessellationKind::TruncatedHexagonal => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(TruncatedHexagonalTessellation),
                CellCodec {
                    from_xy: TruncatedHexagonalPoint::from_xy,
                    to_xy: TruncatedHexagonalPoint::to_xy,
                },
            ))
        }
        TessellationKind::TruncatedTrihexagonal => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(TruncatedTrihexagonalTessellation),
                CellCodec {
                    from_xy: TruncatedTrihexagonalPoint::from_xy,
                    to_xy: TruncatedTrihexagonalPoint::to_xy,
                },
            ))
        }
        TessellationKind::ElongatedTriangular => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(ElongatedTriangularTessellation),
                CellCodec {
                    from_xy: ElongatedTriangularPoint::from_xy,
                    to_xy: ElongatedTriangularPoint::to_xy,
                },
            ))
        }
        TessellationKind::CurvedQuadrilateral => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(CurvedQuadrilateralTessellation),
                CellCodec {
                    from_xy: |x, y| CurvedQuadrilateralPoint { x, y },
                    to_xy: |p| (p.x, p.y),
                },
            ))
        }
        TessellationKind::Radial => {
            let tessellation = RadialTessellation::new(radial_params(config)?)?;
            Ok(visitor.visit(
                Arc::new(tessellation),
                CellCodec {
                    from_xy: |ring, index| RadialPoint { ring, index },
                    to_xy: |p| (p.ring, p.index),
                },
            ))
        }
        TessellationKind::Voronoi => {
            let tessellation = cached_voronoi(voronoi_params(config)?)?;
            Ok(visitor.visit(
                tessellation,
                CellCodec {
                    from_xy: |q, r| VoronoiPoint { q, r },
                    to_xy: |p| (p.q, p.r),
                },
            ))
        }
        TessellationKind::Trihexagonal => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(TrihexagonalTessellation),
                CellCodec {
                    from_xy: TrihexagonalPoint::from_xy,
                    to_xy: TrihexagonalPoint::to_xy,
                },
            ))
        }
    }
}

/// The size, layout and cell limit of a radial tessellation: the required integer
/// `first_ring_cells`, string `ring_layout` and integer `max_cells`; any other param is rejected.
fn radial_params(config: &TessellationConfig) -> Result<RadialParams, String> {
    const SIZE: &str = "first_ring_cells";
    const LAYOUT: &str = "ring_layout";
    const LIMIT: &str = "max_cells";
    if let Some(key) = config
        .params
        .keys()
        .find(|key| ![SIZE, LAYOUT, LIMIT].contains(&key.as_str()))
    {
        return Err(format!(
            "tessellation {:?} does not accept param \"{key}\"",
            config.kind
        ));
    }
    let integer = |name: &str| -> Result<u32, String> {
        config
            .params
            .get(name)
            .ok_or_else(|| format!("tessellation {:?} requires param \"{name}\"", config.kind))?
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| format!("param \"{name}\" must be a non-negative integer"))
    };
    let first_ring_cells = integer(SIZE)?;
    let max_cells = integer(LIMIT)?;
    let layout = config
        .params
        .get(LAYOUT)
        .ok_or_else(|| format!("tessellation {:?} requires param \"{LAYOUT}\"", config.kind))?
        .as_str()
        .and_then(RadialLayout::from_name)
        .ok_or_else(|| {
            let names: Vec<_> = RadialLayout::ALL.iter().map(|l| l.name()).collect();
            format!("param \"{LAYOUT}\" must be one of {names:?}")
        })?;
    Ok(RadialParams {
        first_ring_cells,
        layout,
        max_cells,
    })
}

thread_local! {
    /// The last built Voronoi tessellation. Callers rebuild the instance from the config on every
    /// call, and building one is far costlier than the other kinds (thousands of clipped regions),
    /// so the instance of the most recent params is kept. The result is identical either way.
    static LAST_VORONOI: std::cell::RefCell<Option<(VoronoiParams, Arc<VoronoiTessellation>)>> =
        const { std::cell::RefCell::new(None) };
}

fn cached_voronoi(params: VoronoiParams) -> Result<Arc<VoronoiTessellation>, String> {
    if let Some(hit) = LAST_VORONOI.with(|last| {
        last.borrow()
            .as_ref()
            .filter(|(cached, _)| *cached == params)
            .map(|(_, tessellation)| Arc::clone(tessellation))
    }) {
        return Ok(hit);
    }
    let tessellation = Arc::new(VoronoiTessellation::new(params)?);
    LAST_VORONOI.with(|last| *last.borrow_mut() = Some((params, Arc::clone(&tessellation))));
    Ok(tessellation)
}

/// The jitter, seed and cell limit of a Voronoi tessellation: the required number `jitter`,
/// integer `seed` and integer `max_cells`; any other param is rejected.
fn voronoi_params(config: &TessellationConfig) -> Result<VoronoiParams, String> {
    const JITTER: &str = "jitter";
    const SEED: &str = "seed";
    const LIMIT: &str = "max_cells";
    if let Some(key) = config
        .params
        .keys()
        .find(|key| ![JITTER, SEED, LIMIT].contains(&key.as_str()))
    {
        return Err(format!(
            "tessellation {:?} does not accept param \"{key}\"",
            config.kind
        ));
    }
    let required = |name: &str| {
        config
            .params
            .get(name)
            .ok_or_else(|| format!("tessellation {:?} requires param \"{name}\"", config.kind))
    };
    let integer = |name: &str| -> Result<u32, String> {
        required(name)?
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| format!("param \"{name}\" must be a non-negative integer"))
    };
    let jitter = required(JITTER)?
        .as_f64()
        .ok_or_else(|| format!("param \"{JITTER}\" must be a number"))?;
    Ok(VoronoiParams {
        jitter,
        seed: integer(SEED)?,
        max_cells: integer(LIMIT)?,
    })
}

/// The built-in tessellations take no params.
fn reject_params(config: &TessellationConfig) -> Result<(), String> {
    match config.params.keys().next() {
        None => Ok(()),
        Some(key) => Err(format!(
            "tessellation {:?} does not accept param \"{key}\"",
            config.kind
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{CellCodec, TessellationVisitor, build_tessellation};
    use crate::config::{TessellationConfig, TessellationKind};
    use maze_core::space::Tessellation;
    use std::sync::Arc;

    /// Reports the built instance's shape template keys and the codec round-trip of one point.
    struct Probe;

    impl TessellationVisitor for Probe {
        type Output = (Vec<String>, (i32, i32));

        fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
            (
                tessellation
                    .shape_descriptors()
                    .iter()
                    .map(|descriptor| descriptor.key().to_string())
                    .collect(),
                (codec.to_xy)((codec.from_xy)(3, -2)),
            )
        }
    }

    fn config(kind: TessellationKind) -> TessellationConfig {
        TessellationConfig {
            kind,
            params: serde_json::Map::new(),
        }
    }

    #[test]
    fn builds_every_kind_with_round_tripping_codec() {
        for (kind, shape) in [
            (TessellationKind::Square, "regular:4"),
            (TessellationKind::Hex, "regular:6"),
            (TessellationKind::Tri, "regular:3"),
            (TessellationKind::Cairo, "cairo_pentagon"),
            (TessellationKind::Brick, "brick:brick"),
        ] {
            assert_eq!(
                build_tessellation(&config(kind), Probe),
                Ok((vec![shape.to_string()], (3, -2)))
            );
        }
    }

    /// Shape keys of a tessellation made only of regular polygons with the given side counts.
    fn regular_keys(sides: &[u32]) -> Vec<String> {
        sides.iter().map(|n| format!("regular:{n}")).collect()
    }

    #[test]
    fn builds_multi_shape_tessellations_with_their_regular_polygon_shapes() {
        for (kind, sides) in [
            (TessellationKind::SquareOctagon, &[8, 4][..]),
            (TessellationKind::Trihexagonal, &[6, 3]),
            (TessellationKind::SnubHexagonal, &[6, 3]),
            (TessellationKind::SnubSquare, &[4, 3]),
            (TessellationKind::Rhombitrihexagonal, &[6, 4, 3]),
            (TessellationKind::TruncatedHexagonal, &[12, 3]),
            (TessellationKind::TruncatedTrihexagonal, &[12, 4, 6]),
        ] {
            assert_eq!(
                build_tessellation(&config(kind), Probe),
                Ok((regular_keys(sides), (3, -2))),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn builds_elongated_triangular_with_square_and_triangle_shapes() {
        assert_eq!(
            build_tessellation(&config(TessellationKind::ElongatedTriangular), Probe),
            Ok((
                vec!["regular:4".to_string(), "regular:3".to_string()],
                (3, -2)
            ))
        );
    }

    #[test]
    fn builds_curved_quadrilateral_with_one_four_sided_shape() {
        assert_eq!(
            build_tessellation(&config(TessellationKind::CurvedQuadrilateral), Probe),
            Ok((
                vec!["curved_quadrilateral:curved_quadrilateral".to_string()],
                (3, -2)
            ))
        );
    }

    fn radial_config(params: serde_json::Value) -> TessellationConfig {
        TessellationConfig {
            kind: TessellationKind::Radial,
            params: params.as_object().unwrap().clone(),
        }
    }

    #[test]
    fn builds_radial_from_its_size_param() {
        let cfg = radial_config(
            serde_json::json!({ "first_ring_cells": 9, "max_cells": 3000, "ring_layout": "classic" }),
        );
        let (shapes, round_trip) = build_tessellation(&cfg, Probe).unwrap();
        assert_eq!(shapes[0], "regular:9");
        assert!(
            shapes[1..]
                .iter()
                .all(|key| key.starts_with("radial:ring_"))
        );
        assert_eq!(round_trip, (3, -2));
    }

    #[test]
    fn rejects_invalid_radial_params_with_a_reason() {
        for (cfg, needle) in [
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 5, "max_cells": 3000, "ring_layout": "classic" }),
                ),
                "first_ring_cells",
            ),
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 25, "max_cells": 3000, "ring_layout": "classic" }),
                ),
                "first_ring_cells",
            ),
            (radial_config(serde_json::json!({})), "requires param"),
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 9, "ring_layout": "classic", "max_cells": 50 }),
                ),
                "max_cells",
            ),
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 9, "ring_layout": "classic", "max_cells": 20000 }),
                ),
                "max_cells",
            ),
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 9, "ring_layout": "classic" }),
                ),
                "max_cells",
            ),
            (
                radial_config(serde_json::json!({ "first_ring_cells": 9, "max_cells": 3000 })),
                "ring_layout",
            ),
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 9, "max_cells": 3000, "ring_layout": "spiral" }),
                ),
                "ring_layout",
            ),
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 7.5, "max_cells": 3000, "ring_layout": "classic" }),
                ),
                "first_ring_cells",
            ),
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 9, "max_cells": 3000, "ring_layout": "smooth", "extra": 1 }),
                ),
                "extra",
            ),
            (
                radial_config(
                    serde_json::json!({ "first_ring_cells": 9, "max_cells": 3000, "ring_layout": "smooth", "growth_factor": 2 }),
                ),
                "growth_factor",
            ),
        ] {
            let err = build_tessellation(&cfg, Probe).unwrap_err();
            assert!(err.contains(needle), "{needle}: {err}");
        }
    }

    fn voronoi_config(params: serde_json::Value) -> TessellationConfig {
        TessellationConfig {
            kind: TessellationKind::Voronoi,
            params: params.as_object().unwrap().clone(),
        }
    }

    #[test]
    fn builds_voronoi_without_shape_templates() {
        let cfg =
            voronoi_config(serde_json::json!({ "jitter": 0.15, "seed": 3, "max_cells": 3000 }));
        assert_eq!(build_tessellation(&cfg, Probe), Ok((vec![], (3, -2))));
    }

    #[test]
    fn rejects_invalid_voronoi_params_with_a_reason() {
        for (params, needle) in [
            (serde_json::json!({}), "requires param"),
            (
                serde_json::json!({ "jitter": 0.5, "seed": 1, "max_cells": 3000 }),
                "jitter",
            ),
            (
                serde_json::json!({ "jitter": -0.1, "seed": 1, "max_cells": 3000 }),
                "jitter",
            ),
            (
                serde_json::json!({ "jitter": "x", "seed": 1, "max_cells": 3000 }),
                "jitter",
            ),
            (
                serde_json::json!({ "jitter": 0.1, "max_cells": 3000 }),
                "seed",
            ),
            (
                serde_json::json!({ "jitter": 0.1, "seed": -1, "max_cells": 3000 }),
                "seed",
            ),
            (
                serde_json::json!({ "jitter": 0.1, "seed": 1.5, "max_cells": 3000 }),
                "seed",
            ),
            (serde_json::json!({ "jitter": 0.1, "seed": 1 }), "max_cells"),
            (
                serde_json::json!({ "jitter": 0.1, "seed": 1, "max_cells": 50 }),
                "max_cells",
            ),
            (
                serde_json::json!({ "jitter": 0.1, "seed": 1, "max_cells": 3000, "extra": 1 }),
                "extra",
            ),
        ] {
            let err = build_tessellation(&voronoi_config(params), Probe).unwrap_err();
            assert!(err.contains(needle), "{needle}: {err}");
        }
    }

    #[test]
    fn rejects_unknown_params() {
        let mut cfg = config(TessellationKind::Hex);
        cfg.params
            .insert("rings".to_string(), serde_json::Value::from(3));
        let err = build_tessellation(&cfg, Probe).unwrap_err();
        assert!(err.contains("rings"), "{err}");
    }

    #[test]
    fn parses_kind_and_params_wire_form() {
        let cfg: TessellationConfig =
            serde_json::from_str(r#"{ "kind": "tri", "params": {} }"#).unwrap();
        assert_eq!(cfg, config(TessellationKind::Tri));
    }
}
