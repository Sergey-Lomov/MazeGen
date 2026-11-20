//! The node-shape vocabulary of a tessellation (GitHub issue #1008): per cell type, the shape keys
//! the limits editor offers, from the real cell geometry (`possible_node_shapes`) of a sample field
//! around the tessellation origin, so it does not depend on any user field. The tile each type is
//! drawn on is the tessellation's own sample cell (`Tessellation::sample_cells`).

use super::field_ops::FieldOpWireError;
use super::tessellation_factory::{CellCodec, TessellationVisitor, build_tessellation};
use crate::config::TessellationConfig;
use maze_core::graph::node_shape::{cell_type_of, possible_node_shapes};
use maze_core::ids::IdGenerator;
use maze_core::space::{MultiLevelField, Point, Tessellation};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Half-extent (world units) of the sample box: wide enough for every cell type of the supported
/// tessellations to have a fully surrounded cell.
const SAMPLE_HALF_EXTENT: f64 = 8.0;
/// Most candidate cells the sample box may hold.
const SAMPLE_CANDIDATE_LIMIT: usize = 4096;

/// The shapes of one cell type. `example_cell` is the tessellation's sample cell of that type, as
/// wire coordinates — the tile the limits editor draws the shapes on.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CellTypeShapes {
    /// Shape template key (`ShapeDescriptor::key`), e.g. `regular:4`.
    pub cell_type: String,
    pub example_cell: [i32; 2],
    /// Angular rank of every face of the example cell, indexed like its faces: what a junction
    /// shape key's face numbers refer to (`Field::face_ranks`).
    pub face_ranks: Vec<usize>,
    /// `NodeShape::key()` of every shape, in the shapes' own order.
    pub shapes: Vec<String>,
}

/// Every cell type of the tessellation with its shapes, ordered by cell type. Empty when the
/// tessellation has no sample cells (an irregular one): the editor then offers no shapes.
pub fn tessellation_node_shapes(
    tessellation: &TessellationConfig,
) -> Result<Vec<CellTypeShapes>, FieldOpWireError> {
    build_tessellation(tessellation, NodeShapes)
        .map_err(|message| FieldOpWireError::InvalidRequest { message })
}

struct NodeShapes;

impl TessellationVisitor for NodeShapes {
    type Output = Vec<CellTypeShapes>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let Some(candidates) = tessellation.candidate_cells(
            Point::new(-SAMPLE_HALF_EXTENT, -SAMPLE_HALF_EXTENT),
            Point::new(SAMPLE_HALF_EXTENT, SAMPLE_HALF_EXTENT),
            SAMPLE_CANDIDATE_LIMIT,
        ) else {
            return Vec::new();
        };
        let cells: Vec<T::CellId> = candidates
            .into_iter()
            .filter(|&cell| tessellation.is_valid_cell(cell))
            .collect();
        let mut ids = IdGenerator::new();
        let Ok(field) = MultiLevelField::single_level(tessellation.clone(), cells, &mut ids) else {
            return Vec::new();
        };
        let level_field = field
            .field_of(field.single_level_id())
            .expect("a single-level field has its level");

        // The tessellation's own sample cell of each type (none for an irregular one).
        let mut examples: BTreeMap<String, ((i32, i32), Vec<usize>)> = BTreeMap::new();
        for cell in tessellation.sample_cells() {
            if !level_field.contains(cell) {
                continue;
            }
            examples
                .entry(cell_type_of(&*tessellation, cell))
                .or_insert_with(|| ((codec.to_xy)(cell), level_field.face_ranks(cell)));
        }

        let mut shapes: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for typed in possible_node_shapes(&field) {
            shapes
                .entry(typed.cell_type)
                .or_default()
                .push(typed.shape.key());
        }
        shapes
            .into_iter()
            .filter_map(|(cell_type, shapes)| {
                let ((x, y), face_ranks) = examples.get(&cell_type)?.clone();
                Some(CellTypeShapes {
                    cell_type,
                    example_cell: [x, y],
                    face_ranks,
                    shapes,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocabulary(tessellation: &str) -> Vec<CellTypeShapes> {
        let config: TessellationConfig =
            serde_json::from_str(&format!("{{\"kind\":\"{tessellation}\",\"params\":{{}}}}"))
                .unwrap();
        tessellation_node_shapes(&config).unwrap()
    }

    fn shapes_of(tessellation: &str) -> Vec<String> {
        let cell_types = vocabulary(tessellation);
        assert_eq!(cell_types.len(), 1, "{tessellation} has one cell type");
        cell_types[0].shapes.clone()
    }

    #[test]
    fn square_offers_straight_and_one_turn() {
        let shapes = shapes_of("square");
        assert!(shapes.contains(&"straight".to_string()));
        assert!(shapes.contains(&"turn_90".to_string()));
        assert_eq!(shapes.iter().filter(|s| s.starts_with("turn_")).count(), 1);
        assert!(shapes.contains(&"junction_4_0-1-2-3".to_string()));
    }

    #[test]
    fn hex_offers_sharp_and_soft_turns() {
        let shapes = shapes_of("hex");
        assert!(shapes.contains(&"turn_60".to_string()));
        assert!(shapes.contains(&"turn_120".to_string()));
        assert!(shapes.contains(&"junction_6_0-2-4".to_string()));
        let three_way = shapes
            .iter()
            .filter(|s| s.matches('-').count() == 2)
            .count();
        assert_eq!(three_way, 4, "four three-way arrangements up to rotation");
    }

    #[test]
    fn square_octagon_offers_both_cell_types() {
        let cell_types = vocabulary("square_octagon");
        let keys: Vec<&str> = cell_types.iter().map(|c| c.cell_type.as_str()).collect();
        assert_eq!(keys, vec!["regular:4", "regular:8"]);
        let octagon = &cell_types[1];
        assert!(octagon.shapes.contains(&"turn_135".to_string()));
        assert!(
            octagon
                .shapes
                .contains(&"junction_8_0-1-2-3-4-5-6-7".to_string())
        );
        assert!(cell_types[0].shapes.contains(&"turn_90".to_string()));
        assert_eq!(cell_types[0].face_ranks.len(), 4);
        assert_eq!(octagon.face_ranks.len(), 8);
    }
}
