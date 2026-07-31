use std::collections::HashMap;
use crate::graph::Graph;
use crate::space::{Field, Tessellation, transform_face_index};
use crate::generation::SplitFaceRequirement;
use crate::quality_control::split_pattern_match::reconstruct_tile_faces;

/// A split tile's shape, independent of which physical node happens to be listed first
/// (`nodes_at` order is creation order, not geometry) and independent of the tile's rotation/
/// mirror orientation on the field. Two split tiles produce the same `SplitTopology` exactly when
/// they are the same pattern applied at a different orientation, or with its nodes created in a
/// different order — both irrelevant to "what pattern is this."
///
/// Each inner `Vec<SplitFaceRequirement>` is one node's per-face-position requirement list
/// (`Wall` for a position the node has no edge on, same convention as `reconstruct_tile_faces`).
/// The outer `Vec` is sorted so two tiles whose nodes were built/discovered in different order
/// still compare equal — node identity never matters, only the multiset of node shapes.
pub type SplitTopology = Vec<Vec<SplitFaceRequirement>>;

/// Reduces a split tile's actual topology (`reconstruct_tile_faces`) to a canonical
/// `SplitTopology`: tries every rotation/mirror combination the tessellation supports, applying
/// it to every node's face-requirement list, sorts each candidate's node list (order-independence
/// — see `SplitTopology`'s doc comment), and keeps the lexicographically smallest one. This
/// fixes one arbitrary representative among every geometrically-equivalent orientation, so two
/// tiles that are the same pattern (just rotated/mirrored/created in a different node order)
/// always canonicalize to the same value and can be grouped/compared with plain equality.
///
/// Returns `None` for a non-split tile (`nodes.len() < 2`) or a degenerate tessellation
/// (`T::faces()` empty).
pub fn canonical_split_topology<T: Tessellation>(
    graph: &Graph,
    field: &Field<T>,
    nodes: &[crate::ids::NodeId],
) -> Option<SplitTopology> {
    if nodes.len() < 2 {
        return None;
    }
    let degree = T::faces().len();
    if degree == 0 {
        return None;
    }

    let actual = reconstruct_tile_faces(graph, field, nodes);
    if actual.len() != nodes.len() {
        return None;
    }

    let mirror_choices = std::iter::once(None).chain((0..T::mirror_symmetries().len()).map(Some));

    let mut best: Option<SplitTopology> = None;
    for rotation in 0..T::rotation_symmetries().len() {
        for mirror in mirror_choices.clone() {
            let mut candidate: SplitTopology = Vec::with_capacity(actual.len());
            for node_faces in &actual {
                let mut transformed = vec![SplitFaceRequirement::Wall; degree];
                for (face_index, &requirement) in node_faces.iter().enumerate() {
                    let Some(resolved) = transform_face_index::<T>(face_index, rotation, mirror) else {
                        continue;
                    };
                    transformed[resolved] = requirement;
                }
                candidate.push(transformed);
            }
            candidate.sort();
            if best.as_ref().is_none_or(|b| candidate < *b) {
                best = Some(candidate);
            }
        }
    }
    best
}

/// Maze-wide split totals: `(split_tile_count, split_node_count, groups)`.
///
/// - `split_tile_count` — number of field points with `nodes_at(point).len() >= 2`.
/// - `split_node_count` — sum, over every split point, of its full node count (including the
///   point's original node, not just the extra ones).
/// - `groups` — every split tile's canonical topology (`canonical_split_topology`), grouped by
///   equality, mapped to how many tiles share it. A tile whose topology can't be canonicalized
///   (degenerate tessellation) is still counted in the two totals above but has no group entry.
///
/// Iterates via `Field::all_points`, deduped per point (a split point appears once per its own
/// node count in `all_points`'s NodeId-domain iteration — see its doc comment) — same dedup
/// shape as `build_analytics_snapshot`'s node listing (GitHub issue #223).
pub fn split_totals<T: Tessellation>(
    graph: &Graph,
    field: &Field<T>,
) -> (usize, usize, HashMap<SplitTopology, usize>) {
    let mut tile_count = 0usize;
    let mut node_count = 0usize;
    let mut groups: HashMap<SplitTopology, usize> = HashMap::new();

    let mut seen_points: std::collections::HashSet<T::Point> = std::collections::HashSet::new();
    for point in field.all_points() {
        if !seen_points.insert(point) {
            continue;
        }
        let nodes = field.nodes_at(point);
        if nodes.len() < 2 {
            continue;
        }
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
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, SquarePoint, square_rect};

    /// 3x1 field, middle point split into 2 nodes, each connected to one horizontal neighbor.
    fn maze_with_middle_split() -> (Graph, Field<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mid = SquarePoint { x: 1, y: 0 };
        let extra = field.add_node_at(mid, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let west = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let east = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
        let slot0 = field.nodes_at(mid)[0];
        g.add_bidirectional_edge(slot0, west, crate::graph::EdgeKind::Basic);
        g.add_bidirectional_edge(extra, east, crate::graph::EdgeKind::Basic);
        let nodes = field.nodes_at(mid).to_vec();
        (g, field, nodes)
    }

    #[test]
    fn non_split_tile_has_no_canonical_topology() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let node = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
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
        let mut field: Field<SquareTessellation> = Field::new(square_rect(1, 3), &mut ids).unwrap();
        let mid = SquarePoint { x: 0, y: 1 };
        let extra = field.add_node_at(mid, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let south = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let north = field.node_at(SquarePoint { x: 0, y: 2 }).unwrap();
        let slot0 = field.nodes_at(mid)[0];
        g.add_bidirectional_edge(slot0, south, crate::graph::EdgeKind::Basic);
        g.add_bidirectional_edge(extra, north, crate::graph::EdgeKind::Basic);
        let nodes = field.nodes_at(mid).to_vec();

        let (g0, field0, nodes0) = maze_with_middle_split();
        let horizontal = canonical_split_topology(&g0, &field0, &nodes0).unwrap();
        let vertical = canonical_split_topology(&g, &field, &nodes).unwrap();
        assert_eq!(horizontal, vertical, "a 90-degree-rotated equivalent tile must canonicalize identically");
    }

    #[test]
    fn split_totals_counts_tiles_and_nodes_and_groups_by_topology() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
        // Two equivalent 2-node split tiles (same shape, different points) plus one 3-node tile.
        field.add_node_at(SquarePoint { x: 1, y: 0 }, &mut ids);
        field.add_node_at(SquarePoint { x: 3, y: 0 }, &mut ids);
        field.add_node_at(SquarePoint { x: 4, y: 0 }, &mut ids);
        field.add_node_at(SquarePoint { x: 4, y: 0 }, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);

        let (tile_count, node_count, groups) = split_totals(&g, &field);
        assert_eq!(tile_count, 3, "three field points have 2+ nodes");
        assert_eq!(node_count, 2 + 2 + 3, "sum of full node_count (including original) per split point");
        // No edges built at all here — both 2-node tiles are topologically identical (every face
        // Wall), so they must land in the same group; the 3-node tile is a different node_count
        // and lands in a separate group.
        assert_eq!(groups.len(), 2, "the two all-wall 2-node tiles group together, distinct from the 3-node tile");
        let two_node_group_count = groups.iter()
            .find(|(topology, _)| topology.len() == 2)
            .map(|(_, count)| *count)
            .unwrap();
        assert_eq!(two_node_group_count, 2);
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);

        let (tile_count, node_count, groups) = split_totals(&g, &field);
        assert_eq!(tile_count, 0);
        assert_eq!(node_count, 0);
        assert!(groups.is_empty());
    }
}
