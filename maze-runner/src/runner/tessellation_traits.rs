//! What a tessellation is like, as far as a check's availability depends on it (GitHub issue
//! #1008): whether its cells vary in size and how many sides its largest cell has. The web client
//! matches these against a descriptor's `requires` (`TessellationRequirement`) to offer a check
//! only where it applies. Read from the tessellation's own sample cells (one per cell type), so it
//! does not depend on any user field.

use super::field_ops::FieldOpWireError;
use super::tessellation_factory::{CellCodec, TessellationVisitor, build_tessellation};
use crate::config::TessellationConfig;
use maze_core::space::Tessellation;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct TessellationTraits {
    /// Cells of one type differ in size and shape (`Tessellation::cells_vary_in_size`: Voronoi),
    /// so the tessellation has no fixed vocabulary of cell shapes.
    pub irregular: bool,
    /// Sides of the largest sample cell; `0` when the tessellation offers none (it is irregular).
    pub max_cell_sides: u32,
}

pub fn tessellation_traits(
    tessellation: &TessellationConfig,
) -> Result<TessellationTraits, FieldOpWireError> {
    build_tessellation(tessellation, Traits)
        .map_err(|message| FieldOpWireError::InvalidRequest { message })
}

struct Traits;

impl TessellationVisitor for Traits {
    type Output = TessellationTraits;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, _codec: CellCodec<T>) -> Self::Output {
        let max_cell_sides = tessellation
            .sample_cells()
            .into_iter()
            .map(|cell| tessellation.faces_of(cell).len() as u32)
            .max()
            .unwrap_or(0);
        TessellationTraits {
            irregular: tessellation.cells_vary_in_size(),
            max_cell_sides,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn traits(kind: &str, params: serde_json::Value) -> TessellationTraits {
        let config: TessellationConfig =
            serde_json::from_value(serde_json::json!({ "kind": kind, "params": params })).unwrap();
        tessellation_traits(&config).unwrap()
    }

    #[test]
    fn square_is_regular_with_four_sides() {
        let t = traits("square", serde_json::json!({}));
        assert!(!t.irregular);
        assert_eq!(t.max_cell_sides, 4);
    }

    #[test]
    fn hex_has_six_sides() {
        assert_eq!(traits("hex", serde_json::json!({})).max_cell_sides, 6);
    }

    #[test]
    fn truncated_trihexagonal_has_a_dodecagon() {
        assert_eq!(
            traits("truncated_trihexagonal", serde_json::json!({})).max_cell_sides,
            12
        );
    }

    #[test]
    fn square_octagon_has_eight_sides() {
        assert_eq!(
            traits("square_octagon", serde_json::json!({})).max_cell_sides,
            8
        );
    }

    #[test]
    fn voronoi_is_irregular() {
        let t = traits(
            "voronoi",
            serde_json::json!({ "jitter": 0.15, "seed": 3, "max_cells": 3000 }),
        );
        assert!(t.irregular);
        assert_eq!(t.max_cell_sides, 0);
    }
}
