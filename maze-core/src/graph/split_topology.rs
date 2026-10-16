use crate::generation::SplitFaceRequirement;
use crate::graph::Graph;
use crate::quality_control::split_pattern_match::reconstruct_tile_faces;
use crate::space::{MultiLevelField, Tessellation};
use std::collections::HashMap;

/// A split tile's shape, independent of which physical node happens to be listed first
/// (`nodes_at` order is creation order, not geometry) and independent of the tile's orientation on
/// the field (any element of the cell's allowed transform group). Two split tiles produce the same
/// `SplitTopology` exactly when they have the same shape template and are the same pattern applied
/// through a different allowed transform, or with its nodes created in a different order — both
/// irrelevant to "what pattern is this."
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SplitTopology {
    /// Key of the cell's `ShapeDescriptor`; the face positions below are its canonical indices.
    pub shape: String,
    /// One node's per-canonical-face requirement list each (`Wall` for a face the node has no
    /// edge on, same convention as `reconstruct_tile_faces`). Sorted, so two tiles whose nodes
    /// were built/discovered in different order still compare equal — node identity never
    /// matters, only the multiset of node shapes.
    pub nodes: Vec<Vec<SplitFaceRequirement>>,
}

/// Reduces a split tile's actual topology (`reconstruct_tile_faces`, local faces) to a canonical
/// `SplitTopology`: reads it into template terms under every transform of the cell's allowed group
/// (local face `l` becomes canonical face `canonical_of_transformed_local(g, l)` — the inverse of
/// applying a pattern through `g`), sorts each candidate's node list (order-independence — see
/// `SplitTopology`'s doc comment), and keeps the lexicographically smallest one. This fixes one
/// arbitrary representative among every equivalent orientation, so two tiles that are the same
/// pattern always canonicalize to the same value and can be grouped/compared with plain equality.
///
/// Returns `None` for a non-split tile (`nodes.len() < 2`) or a cell without a shape template.
pub fn canonical_split_topology<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    nodes: &[crate::ids::NodeId],
) -> Option<SplitTopology> {
    if nodes.len() < 2 {
        return None;
    }
    let point = field.cell_of(nodes[0])?;
    let shape = field.tessellation().shape_of(point)?;
    let face_count = shape.descriptor().face_count();

    let actual = reconstruct_tile_faces(graph, field, nodes);
    if actual.len() != nodes.len() {
        return None;
    }

    let best = shape
        .allowed_transforms()
        .iter()
        .map(|&transform| {
            let mut candidate: Vec<Vec<SplitFaceRequirement>> = actual
                .iter()
                .map(|node_faces| {
                    let mut canonical = vec![SplitFaceRequirement::Wall; face_count];
                    for (local, &requirement) in node_faces.iter().enumerate() {
                        canonical[shape.canonical_of_transformed_local(transform, local)] =
                            requirement;
                    }
                    canonical
                })
                .collect();
            candidate.sort();
            candidate
        })
        .min()?;
    Some(SplitTopology {
        shape: shape.descriptor().key().to_string(),
        nodes: best,
    })
}

/// Maze-wide split totals: `(split_tile_count, split_node_count, groups)`.
///
/// - `split_tile_count` — number of field points with `nodes_at(point).len() >= 2`.
/// - `split_node_count` — sum, over every split point, of its full node count (including the
///   point's original node, not just the extra ones).
/// - `groups` — every split tile's canonical topology (`canonical_split_topology`), grouped by
///   equality, mapped to how many tiles share it. A tile whose topology can't be canonicalized
///   (a cell without a shape template) is still counted in the two totals above but has no group entry.
///
/// Iterates via `MultiLevelField::split_cells()` (GitHub issue #614), which already dedups a
/// split point down to one entry (see its own doc comment).
pub fn split_totals<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
) -> (usize, usize, HashMap<SplitTopology, usize>) {
    split_totals_scoped(graph, field, None)
}

/// Same as `split_totals`, restricted to `level`'s own floor when `Some` — only split points
/// whose level matches are counted (GitHub issue #364).
pub fn split_totals_scoped<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    level: Option<crate::space::LevelId>,
) -> (usize, usize, HashMap<SplitTopology, usize>) {
    let mut tile_count = 0usize;
    let mut node_count = 0usize;
    let mut groups: HashMap<SplitTopology, usize> = HashMap::new();

    for (point_level, point) in field.split_cells() {
        if level.is_some_and(|l| l != point_level) {
            continue;
        }
        let nodes = field.nodes_at(point_level, point);
        tile_count += 1;
        node_count += nodes.len();
        if let Some(topology) = canonical_split_topology(graph, field, nodes) {
            *groups.entry(topology).or_insert(0) += 1;
        }
    }

    (tile_count, node_count, groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use std::sync::Arc;

    /// 3x1 field, middle point split into 2 nodes, each connected to one horizontal neighbor.
    fn maze_with_middle_split() -> (
        Graph,
        MultiLevelField<SquareTessellation>,
        Vec<crate::ids::NodeId>,
    ) {
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
    fn non_split_tile_has_no_canonical_topology() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let node = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        assert!(canonical_split_topology(&g, &field, &[node]).is_none());
    }

    #[test]
    fn same_shape_built_with_swapped_node_order_canonicalizes_identically() {
        let (g, field, nodes) = maze_with_middle_split();
        let canonical = canonical_split_topology(&g, &field, &nodes).unwrap();

        // Same tile, node list reversed — must canonicalize to the same value (order-independence).
        let reversed: Vec<_> = nodes.iter().rev().copied().collect();
        let canonical_reversed = canonical_split_topology(&g, &field, &reversed).unwrap();
        assert_eq!(canonical, canonical_reversed);
    }

    #[test]
    fn rotated_equivalent_tile_canonicalizes_identically() {
        // Same middle-split shape, but built on the vertical axis instead of horizontal — a 90
        // degree rotation of the first fixture's shape.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(1, 3), &mut ids).unwrap();
        let level = field.single_level_id();
        let mid = SquarePoint { x: 0, y: 1 };
        let extra = field.add_node_at(level, mid, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let south = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let north = field.node_at(level, SquarePoint { x: 0, y: 2 }).unwrap();
        let slot0 = field.nodes_at(level, mid)[0];
        g.add_bidirectional_edge(slot0, south, crate::graph::EdgeKind::Basic);
        g.add_bidirectional_edge(extra, north, crate::graph::EdgeKind::Basic);
        let nodes = field.nodes_at(level, mid).to_vec();

        let (g0, field0, nodes0) = maze_with_middle_split();
        let horizontal = canonical_split_topology(&g0, &field0, &nodes0).unwrap();
        let vertical = canonical_split_topology(&g, &field, &nodes).unwrap();
        assert_eq!(
            horizontal, vertical,
            "a 90-degree-rotated equivalent tile must canonicalize identically"
        );
    }

    #[test]
    fn split_totals_counts_tiles_and_nodes_and_groups_by_topology() {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(5, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        // Two equivalent 2-node split tiles (same shape, different points) plus one 3-node tile.
        field.add_node_at(level, SquarePoint { x: 1, y: 0 }, &mut ids);
        field.add_node_at(level, SquarePoint { x: 3, y: 0 }, &mut ids);
        field.add_node_at(level, SquarePoint { x: 4, y: 0 }, &mut ids);
        field.add_node_at(level, SquarePoint { x: 4, y: 0 }, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }

        let (tile_count, node_count, groups) = split_totals(&g, &field);
        assert_eq!(tile_count, 3, "three field points have 2+ nodes");
        assert_eq!(
            node_count,
            2 + 2 + 3,
            "sum of full node_count (including original) per split point"
        );
        // No edges built at all here — both 2-node tiles are topologically identical (every face
        // Wall), so they must land in the same group; the 3-node tile is a different node_count
        // and lands in a separate group.
        assert_eq!(
            groups.len(),
            2,
            "the two all-wall 2-node tiles group together, distinct from the 3-node tile"
        );
        let two_node_group_count = groups
            .iter()
            .find(|(topology, _)| topology.nodes.len() == 2)
            .map(|(_, count)| *count)
            .unwrap();
        assert_eq!(two_node_group_count, 2);
    }

    #[test]
    fn split_totals_scoped_counts_only_the_given_floor() {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level0 = field.single_level_id();
        field.add_node_at(level0, SquarePoint { x: 1, y: 0 }, &mut ids);
        let level1 =
            field.add_level(Field::new(Arc::default(), square_rect(3, 1), &mut ids).unwrap());
        field.add_node_at(level1, SquarePoint { x: 1, y: 0 }, &mut ids);
        field.add_node_at(level1, SquarePoint { x: 2, y: 0 }, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }

        let (tile_count0, ..) = split_totals_scoped(&g, &field, Some(level0));
        assert_eq!(tile_count0, 1, "level0 has one split point");
        let (tile_count1, ..) = split_totals_scoped(&g, &field, Some(level1));
        assert_eq!(tile_count1, 2, "level1 has two split points");
        let (tile_count_all, ..) = split_totals_scoped(&g, &field, None);
        assert_eq!(tile_count_all, 3, "maze-wide (None) covers both floors");
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }

        let (tile_count, node_count, groups) = split_totals(&g, &field);
        assert_eq!(tile_count, 0);
        assert_eq!(node_count, 0);
        assert!(groups.is_empty());
    }
}
