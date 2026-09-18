use crate::Maze;
use crate::ids::EdgeId;
use crate::quality_control::InvalidSplitNodeConnectionGroupIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

pub const SPLIT_NODE_CONNECTION_PER_FACE_MAX_DEFAULT: u32 = 1;

/// Flags excess connections from a split tile's nodes going out through the same tile face
/// direction — see GitHub issue #251, part of epic #246. Distinct from
/// `SplitNodeConnectionPerNeighborCheck`: that check caps connections converging on one specific
/// outside neighbor; this one caps connections sharing one face *direction*, regardless of how
/// many distinct outside neighbors receive them (e.g. two edges leaving through the tile's "north"
/// face toward two different neighbor tiles still both count against the same face's cap).
///
/// **Outside only, outgoing only** — same rules as `SplitNodeConnectionPerNeighborCheck`: a
/// sibling edge to another node of the same split tile is never counted (`Field::point_of(edge.to)`
/// must differ from the split tile's own point), and only edges *from* a split node *to* the
/// neighbor count. `EdgeKind` doesn't matter.
///
/// **Face direction** is `T::face_between(split_point, neighbor_point)`, converted to a stable
/// index via `T::face_index` so it can key a `HashMap` — resolved once per edge from the two
/// points involved, independent of which of the split's nodes the edge actually starts at.
pub struct SplitNodeConnectionPerFaceCheck {
    pub instance_id: String,
    pub max: u32,
}

impl<T: Tessellation> Check<T, InvalidSplitNodeConnectionGroupIssue>
    for SplitNodeConnectionPerFaceCheck
{
    fn check_type_id(&self) -> &'static str {
        "split_node_connection_per_face"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitNodeConnectionGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let mut seen_points = std::collections::HashSet::new();
        let split_points: Vec<(crate::space::LevelId, T::Point)> = maze
            .field
            .all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .filter(|&(level, point)| maze.field.nodes_at(level, point).len() >= 2)
            .collect();
        if split_points.is_empty() {
            return;
        }

        let mut groups: Vec<(Vec<EdgeId>, u32)> = Vec::new();

        for &(level, point) in &split_points {
            let nodes = maze.field.nodes_at(level, point);
            // Bucket every outgoing edge to an outside neighbor by its face-direction index --
            // edges toward different neighbors sharing the same face direction land in the same
            // bucket.
            let mut by_face: HashMap<usize, Vec<EdgeId>> = HashMap::new();
            for edge in maze.graph.edges() {
                if !nodes.contains(&edge.from) {
                    continue;
                }
                let Some(neighbor_point) = maze.field.point_of(edge.to) else {
                    continue;
                };
                if neighbor_point == point {
                    continue; // sibling edge to another node of the same split -- not "outside".
                }
                let Some(face) = T::face_between(point, neighbor_point) else {
                    continue;
                };
                let Some(face_index) = T::face_index(face) else {
                    continue;
                };
                by_face.entry(face_index).or_default().push(edge.id);
            }

            for (_, mut edges) in by_face {
                if edges.len() as u32 > self.max {
                    edges.sort_unstable();
                    let to_remove = edges.len() as u32 - self.max;
                    groups.push((edges, to_remove));
                }
            }
        }

        if groups.is_empty() {
            return;
        }
        let issue = InvalidSplitNodeConnectionGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "max", self.max.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "split_node_connection_per_face_tests.rs"]
mod tests;
