use crate::generation::{
    OneWayDirection, PatternVariant, SplitFaceRequirement, SplitPattern, pattern_variants,
};
use crate::graph::Graph;
use crate::ids::NodeId;
use crate::space::{MultiLevelField, Tessellation};

/// Reconstructs the topology (per-node, per-face requirement) an already-built split tile actually
/// has in `graph` — the inverse of applying a `SplitPattern`. `nodes` must be a point's full
/// `nodes_at` slice (slot-0 first, same order `SplitPattern.faces[0]` assumes). Only
/// `Passage`/`OneWay`/absent-edge (`Wall`) are distinguished here — `Unspecified` never appears in
/// a reconstructed tile (there is no way to tell an intentional "maybe" from a plain absent edge
/// after the fact), and `sibling_target` is resolved implicitly: a face whose neighbor is one of
/// `nodes` itself reads the same as any other neighbor-directed face, since `matches_any` (below)
/// only compares requirement shape per geometric direction, not node identity.
///
/// Returns one `Vec<SplitFaceRequirement>` per node in `nodes`, indexed by local face (position in
/// `Tessellation::faces_of(point)`; `Wall` where no edge exists in that direction — including a
/// face pointing off-field). `CellShape::canonical_of_local` reads it back into template terms.
pub(crate) fn reconstruct_tile_faces<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    nodes: &[NodeId],
) -> Vec<Vec<SplitFaceRequirement>> {
    let Some((level, point)) = nodes
        .first()
        .and_then(|&n| field.level_of(n).zip(field.cell_of(n)))
    else {
        return Vec::new();
    };
    let tessellation = field.tessellation();

    nodes
        .iter()
        .map(|&node| {
            tessellation
                .faces_of(point)
                .iter()
                .map(|&face| {
                    let Some(crossing) = field.neighbor_via(level, point, face) else {
                        return SplitFaceRequirement::Wall;
                    };
                    let candidates = field.nodes_at(level, crossing.cell);
                    if candidates.is_empty() {
                        return SplitFaceRequirement::Wall;
                    }
                    // Any candidate node of the neighboring point connected to `node` resolves this face
                    // — mirrors `enumerate_adaptations`' own "first node at the point" convention, but
                    // checked against every candidate since a repair-built tile may have redistributed an
                    // original edge onto a sibling rather than always the neighbor's own slot-0.
                    let fwd = candidates
                        .iter()
                        .any(|&c| graph.edge_between(node, c).is_some());
                    let bwd = candidates
                        .iter()
                        .any(|&c| graph.edge_between(c, node).is_some());
                    match (fwd, bwd) {
                        (true, true) => SplitFaceRequirement::Passage,
                        (true, false) => SplitFaceRequirement::OneWay(OneWayDirection::Forward),
                        (false, true) => SplitFaceRequirement::OneWay(OneWayDirection::Backward),
                        (false, false) => SplitFaceRequirement::Wall,
                    }
                })
                .collect()
        })
        .collect()
}

/// A pattern variant's per-node, per-local-face requirement — `Wall` filled in for a local face the
/// pattern doesn't declare at all (mirrors a reconstructed tile's own "no edge = Wall" default, so
/// the two are directly comparable). `sibling_target` faces compare as their own requirement
/// (`Passage`/`OneWay`), same simplification `reconstruct_tile_faces` makes.
fn pattern_faces_at(
    pattern: &SplitPattern,
    variant: &PatternVariant,
    face_count: usize,
) -> Vec<Vec<SplitFaceRequirement>> {
    let mut out = vec![vec![SplitFaceRequirement::Wall; face_count]; pattern.node_count];
    for (node_index, (node_faces, locals)) in
        pattern.faces.iter().zip(&variant.local_faces).enumerate()
    {
        for (face, &local) in node_faces.iter().zip(locals) {
            out[node_index][local] = face.requirement;
        }
    }
    out
}

/// Whether the split tile at `nodes` (a point's full `nodes_at`, slot-0 first) structurally matches
/// any pattern in `patterns` — topology only (per-node, per-local-face `Passage`/`OneWay`/`Wall`).
/// Only patterns declared for the cell's shape template are tried, each through every variant of
/// the cell's allowed transform group (`pattern_variants`, the same rule generation uses), so a
/// tile built from any allowed application of a listed pattern counts as a match. An empty
/// `patterns` list means "every split tile counts" — callers check that case themselves before
/// calling this (this function always requires an actual structural match).
pub fn split_tile_matches_any<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    nodes: &[NodeId],
    patterns: &[SplitPattern],
) -> bool {
    if nodes.len() < 2 {
        return false;
    }
    let Some(point) = field.cell_of(nodes[0]) else {
        return false;
    };
    let Some(shape) = field.tessellation().shape_of(point) else {
        return false;
    };
    let actual = reconstruct_tile_faces(graph, field, nodes);
    if actual.len() != nodes.len() {
        return false;
    }
    let face_count = shape.descriptor().face_count();

    patterns.iter().any(|pattern| {
        pattern.node_count == nodes.len()
            && pattern_variants(pattern, &shape)
                .iter()
                .any(|variant| pattern_faces_at(pattern, variant, face_count) == actual)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generation::SplitPatternFace;
    use crate::space::test_support::GappedSquareTessellation;
    use crate::space::{SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use std::sync::Arc;

    fn two_node_pattern(east_req: SplitFaceRequirement) -> SplitPattern {
        // `regular:4` canonical order is counter-clockwise from East: node 0 gets canonical face
        // 0, node 1 the opposite face 2, both required, mirroring a simple through-split.
        SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 2,
            faces: vec![
                vec![SplitPatternFace {
                    face_index: 0,
                    requirement: east_req,
                    sibling_target: None,
                }],
                vec![SplitPatternFace {
                    face_index: 2,
                    requirement: east_req,
                    sibling_target: None,
                }],
            ],
            weight: 1.0,
        }
    }

    /// 3x1 field, middle point split into 2 nodes, each connected to one horizontal neighbor —
    /// mirrors a `Passage`-only two-node pattern applied at the middle point.
    fn maze_with_middle_split() -> (Graph, MultiLevelField<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mid = SquarePoint { x: 1, y: 0 };
        let extra = field.add_node_at(level, mid, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let west = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let east = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        let slot0 = field.nodes_at(level, mid)[0];
        g.add_bidirectional_edge(slot0, west, crate::graph::EdgeKind::Basic);
        g.add_bidirectional_edge(extra, east, crate::graph::EdgeKind::Basic);
        let nodes = field.nodes_at(level, mid).to_vec();
        (g, field, nodes)
    }

    #[test]
    fn matches_pattern_after_reconstructing_passage_topology() {
        let (g, field, nodes) = maze_with_middle_split();
        let patterns = vec![two_node_pattern(SplitFaceRequirement::Passage)];
        assert!(split_tile_matches_any(&g, &field, &nodes, &patterns));
    }

    #[test]
    fn does_not_match_pattern_with_different_requirement() {
        let (g, field, nodes) = maze_with_middle_split();
        let patterns = vec![two_node_pattern(SplitFaceRequirement::OneWay(
            OneWayDirection::Forward,
        ))];
        assert!(!split_tile_matches_any(&g, &field, &nodes, &patterns));
    }

    #[test]
    fn does_not_match_when_node_count_differs() {
        let (g, field, nodes) = maze_with_middle_split();
        let mut three_node = two_node_pattern(SplitFaceRequirement::Passage);
        three_node.node_count = 3;
        three_node.faces.push(vec![]);
        assert!(!split_tile_matches_any(&g, &field, &nodes, &[three_node]));
    }

    #[test]
    fn single_node_point_never_matches() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let level = field.single_level_id();
        let node = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        let patterns = vec![two_node_pattern(SplitFaceRequirement::Passage)];
        assert!(!split_tile_matches_any(&g, &field, &[node], &patterns));
    }

    #[test]
    fn reconstructs_a_missing_step_as_a_wall() {
        let origin = SquarePoint { x: 0, y: 0 };
        let east = SquarePoint { x: 1, y: 0 };
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<GappedSquareTessellation> =
            MultiLevelField::single_level(Arc::default(), [origin, east], &mut ids).unwrap();
        let level = field.single_level_id();
        let origin_node = field.node_at(level, origin).unwrap();
        let graph = Graph::new();

        let actual = reconstruct_tile_faces(&graph, &field, &[origin_node]);

        assert_eq!(actual.len(), 1);
        assert_eq!(
            actual[0][GappedSquareTessellation
                .faces_of(origin)
                .iter()
                .position(|&face| face == crate::space::SquareFace::E)
                .unwrap()],
            SplitFaceRequirement::Wall
        );
    }

    #[test]
    fn does_not_match_a_pattern_for_another_shape() {
        let (g, field, nodes) = maze_with_middle_split();
        let mut pattern = two_node_pattern(SplitFaceRequirement::Passage);
        pattern.shape = "regular:6".to_string();
        assert!(!split_tile_matches_any(&g, &field, &nodes, &[pattern]));
    }

    /// A triangle's group includes its reflections: a two-node tile matches the same pattern
    /// whichever of its two connected sides node 0 owns — one of the two needs a reflection.
    #[test]
    fn tri_tile_matches_through_rotations_and_reflections() {
        use crate::space::{TriPoint, TriTessellation, tri_rect};

        let pattern = SplitPattern {
            shape: "regular:3".to_string(),
            node_count: 2,
            faces: vec![
                vec![SplitPatternFace {
                    face_index: 0,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                }],
                vec![SplitPatternFace {
                    face_index: 1,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                }],
            ],
            weight: 1.0,
        };
        for swapped in [false, true] {
            let mut ids = IdGenerator::new();
            let mut field: MultiLevelField<TriTessellation> =
                MultiLevelField::single_level(Arc::default(), tri_rect(3, 1), &mut ids).unwrap();
            let level = field.single_level_id();
            let mid = TriPoint { col: 1, row: 0 };
            let extra = field.add_node_at(level, mid, &mut ids);
            let mut g = Graph::new();
            for node in field.all_node_ids() {
                g.add_node(node);
            }
            let left_neighbor = field.node_at(level, TriPoint { col: 0, row: 0 }).unwrap();
            let right_neighbor = field.node_at(level, TriPoint { col: 2, row: 0 }).unwrap();
            let slot0 = field.nodes_at(level, mid)[0];
            let (a, b) = if swapped {
                (right_neighbor, left_neighbor)
            } else {
                (left_neighbor, right_neighbor)
            };
            g.add_bidirectional_edge(slot0, a, crate::graph::EdgeKind::Basic);
            g.add_bidirectional_edge(extra, b, crate::graph::EdgeKind::Basic);
            let nodes = field.nodes_at(level, mid).to_vec();
            assert!(
                split_tile_matches_any(&g, &field, &nodes, std::slice::from_ref(&pattern)),
                "swapped={swapped}"
            );
        }
    }
}
