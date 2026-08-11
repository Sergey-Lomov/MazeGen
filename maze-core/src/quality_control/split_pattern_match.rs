use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{MultiLevelField, Tessellation};
use crate::generation::{SplitPattern, SplitFaceRequirement, OneWayDirection};

/// Reconstructs the topology (per-node, per-face requirement) an already-built split tile actually
/// has in `graph` — the inverse of applying a `SplitPattern`. `nodes` must be a point's full
/// `nodes_at` slice (slot-0 first, same order `SplitPattern.faces[0]` assumes). Only
/// `Passage`/`OneWay`/absent-edge (`Wall`) are distinguished here — `Unspecified` never appears in
/// a reconstructed tile (there is no way to tell an intentional "maybe" from a plain absent edge
/// after the fact), and `sibling_target` is resolved implicitly: a face whose neighbor is one of
/// `nodes` itself reads the same as any other neighbor-directed face, since `matches_any` (below)
/// only compares requirement shape per geometric direction, not node identity.
///
/// Returns one `Vec<SplitFaceRequirement>` per node in `nodes`, indexed by `Tessellation::faces()`
/// position (`Wall` where no edge exists in that direction — including a face pointing off-field).
pub(crate) fn reconstruct_tile_faces<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    nodes: &[NodeId],
) -> Vec<Vec<SplitFaceRequirement>> {
    let Some((level, point)) = nodes.first().and_then(|&n| field.level_of(n).zip(field.point_of(n))) else { return Vec::new(); };
    let degree = T::faces().len();

    nodes.iter().map(|&node| {
        (0..degree).map(|face_index| {
            let Some(face) = T::face_at(face_index) else { return SplitFaceRequirement::Wall; };
            let neighbor_point = T::step(point, face);
            let candidates = field.nodes_at(level, neighbor_point);
            if candidates.is_empty() {
                return SplitFaceRequirement::Wall;
            }
            // Any candidate node of the neighboring point connected to `node` resolves this face
            // — mirrors `enumerate_adaptations`' own "first node at the point" convention, but
            // checked against every candidate since a repair-built tile may have redistributed an
            // original edge onto a sibling rather than always the neighbor's own slot-0.
            let fwd = candidates.iter().any(|&c| graph.edge_between(node, c).is_some());
            let bwd = candidates.iter().any(|&c| graph.edge_between(c, node).is_some());
            match (fwd, bwd) {
                (true, true) => SplitFaceRequirement::Passage,
                (true, false) => SplitFaceRequirement::OneWay(OneWayDirection::Forward),
                (false, true) => SplitFaceRequirement::OneWay(OneWayDirection::Backward),
                (false, false) => SplitFaceRequirement::Wall,
            }
        }).collect()
    }).collect()
}

/// A pattern's own per-node, per-face-position requirement — `Wall` filled in for a face position
/// the pattern doesn't declare at all (mirrors a reconstructed tile's own "no edge = Wall" default,
/// so the two are directly comparable). `sibling_target` faces compare as their own requirement
/// (`Passage`/`OneWay`), same simplification `reconstruct_tile_faces` makes.
///
/// `rotation`/`mirror` index into `T::rotation_symmetries()`/`T::mirror_symmetries()` (via
/// `space::transform_face_index`, GitHub issue #275) — never raw arithmetic on the face index,
/// since `Self::faces()` order isn't angular for every tessellation.
fn pattern_faces_at<T: Tessellation>(pattern: &SplitPattern, degree: usize, rotation: usize, mirror: Option<usize>) -> Option<Vec<Vec<SplitFaceRequirement>>> {
    let mut out: Vec<Vec<SplitFaceRequirement>> = vec![vec![SplitFaceRequirement::Wall; degree]; pattern.node_count];
    for (node_index, node_faces) in pattern.faces.iter().enumerate() {
        for face in node_faces {
            let resolved = crate::space::transform_face_index::<T>(face.face_index, rotation, mirror)?;
            if resolved >= degree {
                return None;
            }
            out[node_index][resolved] = face.requirement;
        }
    }
    Some(out)
}

/// Whether the split tile at `nodes` (a point's full `nodes_at`, slot-0 first) structurally matches
/// any pattern in `patterns` — topology only (per-node, per-geometric-direction
/// `Passage`/`OneWay`/`Wall`), tried against every `rotation`/`mirror` combination the same way
/// `enumerate_adaptations` tries them at generation time, so a tile built from a rotated/mirrored
/// application of a listed pattern still counts as a match. An empty `patterns` list means "every
/// split tile counts" — callers check that case themselves before calling this (this function
/// always requires an actual structural match).
pub fn split_tile_matches_any<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    nodes: &[NodeId],
    patterns: &[SplitPattern],
) -> bool {
    if nodes.len() < 2 {
        return false;
    }
    let degree = T::faces().len();
    if degree == 0 {
        return false;
    }
    let actual = reconstruct_tile_faces(graph, field, nodes);
    if actual.len() != nodes.len() {
        return false;
    }

    let mirror_choices = std::iter::once(None).chain((0..T::mirror_symmetries().len()).map(Some));

    patterns.iter().any(|pattern| {
        if pattern.node_count != nodes.len() {
            return false;
        }
        (0..T::rotation_symmetries().len()).any(|rotation| {
            mirror_choices.clone().any(|mirror| {
                let Some(expected) = pattern_faces_at::<T>(pattern, degree, rotation, mirror) else { return false; };
                expected == actual
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, SquarePoint, square_rect};
    use crate::generation::SplitPatternFace;

    fn two_node_pattern(east_req: SplitFaceRequirement) -> SplitPattern {
        // SquareFace order: [N, S, E, W] (see square.rs) — node 0 gets an East face (index 2),
        // node 1 gets a West face (index 3, opposite side), both required, mirroring a simple
        // through-split.
        SplitPattern {
            node_count: 2,
            faces: vec![
                vec![SplitPatternFace { face_index: 2, requirement: east_req, sibling_target: None }],
                vec![SplitPatternFace { face_index: 3, requirement: east_req, sibling_target: None }],
            ],
            weight: 1.0,
        }
    }

    /// 3x1 field, middle point split into 2 nodes, each connected to one horizontal neighbor —
    /// mirrors a `Passage`-only two-node pattern applied at the middle point.
    fn maze_with_middle_split() -> (Graph, MultiLevelField<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mid = SquarePoint { x: 1, y: 0 };
        let extra = field.add_node_at(level, mid, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
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
        let patterns = vec![two_node_pattern(SplitFaceRequirement::OneWay(OneWayDirection::Forward))];
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
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let level = field.single_level_id();
        let node = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        let patterns = vec![two_node_pattern(SplitFaceRequirement::Passage)];
        assert!(!split_tile_matches_any(&g, &field, &[node], &patterns));
    }

    /// `TriTessellation` has `mirror_symmetries()` empty (GitHub issue #275) — this pins down
    /// that `split_tile_matches_any`'s rotation/mirror loop still finds a match through
    /// rotation alone when there is no mirror to try at all, i.e. the `mirror_choices` iterator
    /// built from an empty `mirror_symmetries()` (just `[None]`) doesn't silently skip every
    /// candidate.
    #[test]
    fn tri_tessellation_matches_via_rotation_alone_with_no_mirror_symmetries() {
        use crate::space::{TriTessellation, TriPoint, tri_rect};

        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<TriTessellation> = MultiLevelField::single_level(tri_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mid = TriPoint { col: 1, row: 0 };
        let extra = field.add_node_at(level, mid, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let left_neighbor = field.node_at(level, TriPoint { col: 0, row: 0 }).unwrap();
        let right_neighbor = field.node_at(level, TriPoint { col: 2, row: 0 }).unwrap();
        let slot0 = field.nodes_at(level, mid)[0];
        g.add_bidirectional_edge(slot0, left_neighbor, crate::graph::EdgeKind::Basic);
        g.add_bidirectional_edge(extra, right_neighbor, crate::graph::EdgeKind::Basic);
        let nodes = field.nodes_at(level, mid).to_vec();

        // Left face = index 0, Right face = index 1 (TriFace::[Left, Right, Base] order).
        let pattern = SplitPattern {
            node_count: 2,
            faces: vec![
                vec![SplitPatternFace { face_index: 0, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
                vec![SplitPatternFace { face_index: 1, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
            ],
            weight: 1.0,
        };
        assert!(split_tile_matches_any(&g, &field, &nodes, &[pattern]));
    }
}
