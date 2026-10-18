use crate::config::{TessellationConfig, TessellationKind};
use maze_core::space::{
    BrickPoint, BrickTessellation, CairoPoint, CairoTessellation, HexPoint, HexTessellation,
    RhombitrihexagonalPoint, RhombitrihexagonalTessellation, SnubHexagonalPoint,
    SnubHexagonalTessellation, SquareOctagonPoint, SquareOctagonTessellation, SquarePoint,
    SquareTessellation, Tessellation, TriPoint, TriTessellation, TrihexagonalPoint,
    TrihexagonalTessellation,
};
use std::sync::Arc;

/// Wire encoding of a tessellation's points as `[i32; 2]` pairs. Defined per kind by the factory;
/// it round-trips only under the same tessellation config.
pub struct CellCodec<T: Tessellation> {
    pub from_xy: fn(i32, i32) -> T::CellId,
    pub to_xy: fn(T::CellId) -> (i32, i32),
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
        assert_eq!(
            build_tessellation(&config(TessellationKind::SquareOctagon), Probe),
            Ok((
                vec!["regular:8".to_string(), "regular:4".to_string()],
                (3, -2)
            ))
        );
    }

    #[test]
    fn builds_trihexagonal_with_hexagon_and_triangle_shapes() {
        assert_eq!(
            build_tessellation(&config(TessellationKind::Trihexagonal), Probe),
            Ok((
                vec!["regular:6".to_string(), "regular:3".to_string()],
                (3, -2)
            ))
        );
    }

    #[test]
    fn builds_snub_hexagonal_with_hexagon_and_triangle_shapes() {
        assert_eq!(
            build_tessellation(&config(TessellationKind::SnubHexagonal), Probe),
            Ok((
                vec!["regular:6".to_string(), "regular:3".to_string()],
                (3, -2)
            ))
        );
    }

    #[test]
    fn builds_rhombitrihexagonal_with_hexagon_square_and_triangle_shapes() {
        assert_eq!(
            build_tessellation(&config(TessellationKind::Rhombitrihexagonal), Probe),
            Ok((
                vec![
                    "regular:6".to_string(),
                    "regular:4".to_string(),
                    "regular:3".to_string()
                ],
                (3, -2)
            ))
        );
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
