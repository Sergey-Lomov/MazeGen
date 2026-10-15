use crate::config::{TessellationConfig, TessellationKind};
use maze_core::space::{
    CairoPoint, CairoTessellation, HexPoint, HexTessellation, SquarePoint, SquareTessellation,
    Tessellation, TriPoint, TriTessellation,
};
use std::sync::Arc;

/// Wire encoding of a tessellation's points as `[i32; 2]` pairs. Defined per kind by the factory;
/// it round-trips only under the same tessellation config.
pub struct PointCodec<T: Tessellation> {
    pub from_xy: fn(i32, i32) -> T::Point,
    pub to_xy: fn(T::Point) -> (i32, i32),
}

impl<T: Tessellation> Clone for PointCodec<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T: Tessellation> Copy for PointCodec<T> {}

/// Consumer of a freshly built tessellation instance — the single place where a runtime
/// `TessellationKind` turns into a compile-time `T`. Every `maze-runner`/`maze-wasm` entry point
/// goes through `build_tessellation` with its own visitor.
pub trait TessellationVisitor {
    type Output;
    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: PointCodec<T>) -> Self::Output;
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
                PointCodec {
                    from_xy: |x, y| SquarePoint { x, y },
                    to_xy: |p| (p.x, p.y),
                },
            ))
        }
        TessellationKind::Hex => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(HexTessellation),
                PointCodec {
                    from_xy: |q, r| HexPoint { q, r },
                    to_xy: |p| (p.q, p.r),
                },
            ))
        }
        TessellationKind::Tri => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(TriTessellation),
                PointCodec {
                    from_xy: |col, row| TriPoint { col, row },
                    to_xy: |p| (p.col, p.row),
                },
            ))
        }
        TessellationKind::Cairo => {
            reject_params(config)?;
            Ok(visitor.visit(
                Arc::new(CairoTessellation),
                PointCodec {
                    from_xy: |x, y| CairoPoint { x, y },
                    to_xy: |p| (p.x, p.y),
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
    use super::{PointCodec, TessellationVisitor, build_tessellation};
    use crate::config::{TessellationConfig, TessellationKind};
    use maze_core::space::Tessellation;
    use std::sync::Arc;

    /// Reports the built instance's face count and the codec round-trip of one point.
    struct Probe;

    impl TessellationVisitor for Probe {
        type Output = (usize, (i32, i32));

        fn visit<T: Tessellation>(
            self,
            tessellation: Arc<T>,
            codec: PointCodec<T>,
        ) -> Self::Output {
            (
                tessellation.faces().len(),
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
        for (kind, faces) in [
            (TessellationKind::Square, 4),
            (TessellationKind::Hex, 6),
            (TessellationKind::Tri, 3),
            (TessellationKind::Cairo, 5),
        ] {
            assert_eq!(
                build_tessellation(&config(kind), Probe),
                Ok((faces, (3, -2)))
            );
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
