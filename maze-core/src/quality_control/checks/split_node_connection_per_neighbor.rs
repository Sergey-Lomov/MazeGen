use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::quality_control::InvalidSplitNodeConnectionGroupIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

pub const SPLIT_NODE_CONNECTION_PER_NEIGHBOR_MAX_DEFAULT: u32 = 1;

/// Flags excess connections from a split tile's nodes converging on the same single outside
/// neighbor node — see GitHub issue #251, part of epic #246. Distinct from
/// `SplitNodeConnectionCountCheck`: that check flags a single node's own total connection count;
/// this one flags a *relationship* across several nodes of the same split (more than `max`
/// connections, from different nodes of the split, all going out to the same outside neighbor),
/// none of which is individually invalid — mirrors `OneWayGroupSuperHubCheck`'s per-vertex excess
/// shape, but the "vertex" being watched is the outside neighbor, not either split node.
///
/// **Outside only**: a connection to another node of the *same* split (a sibling edge) is never
/// counted — this check is about a tile over-connecting to the external world, not internal
/// split-node wiring. A neighbor's own point (`Field::point_of`) must differ from the split
/// tile's point for the connection to count.
///
/// **Outgoing only**: counts edges *from* a split node *to* the neighbor (`edge.from` at the
/// split point, `edge.to` at the neighbor's point) — mirrors the issue's own wording ("connections
/// ... go out to the same single outside neighbor node"). A connection's `EdgeKind` doesn't
/// matter — `Basic` and `Teleport` both count.
pub struct SplitNodeConnectionPerNeighborCheck {
    pub instance_id: String,
    pub max: u32,
}

impl<T: Tessellation> Check<T, InvalidSplitNodeConnectionGroupIssue>
    for SplitNodeConnectionPerNeighborCheck
{
    fn check_type_id(&self) -> &'static str {
        "split_node_connection_per_neighbor"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitNodeConnectionGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let split_points: Vec<(crate::space::LevelId, T::Point)> =
            maze.field.split_points().collect();
        if split_points.is_empty() {
            return;
        }

        let mut groups: Vec<(Vec<EdgeId>, u32)> = Vec::new();

        for &(level, point) in &split_points {
            let nodes = maze.field.nodes_at(level, point);
            // Bucket every outgoing edge to an outside neighbor by that neighbor's NodeId --
            // several edges from different split nodes converging on the same neighbor land in
            // the same bucket.
            let mut by_neighbor: HashMap<NodeId, Vec<EdgeId>> = HashMap::new();
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
                by_neighbor.entry(edge.to).or_default().push(edge.id);
            }

            for (_, mut edges) in by_neighbor {
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
#[path = "split_node_connection_per_neighbor_tests.rs"]
mod tests;
