use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::ids::{EdgeId, NodeId};
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::InvalidOneWayGroupIssue;

pub const ONE_WAY_GROUP_SUPER_HUB_MAX_CONNECTIONS_DEFAULT: u32 = 3;

/// Flags a vertex whose count of incident one-way passage edges (`EdgeKind::Basic`, single
/// direction — the opposite direction between the same node pair does not exist, same "genuine
/// one-way" filter every other one-way check uses) exceeds a configured maximum — see GitHub
/// issue #200, part of the one-way management epic (#92). Distinct problem from
/// `OneWayGroupGeometricProximityCheck`/`OneWayGroupGraphProximityCheck` (issue #199): this is
/// about the *total count* of one-ways at a vertex, not the distance between any two of them.
///
/// Both outgoing (`edge.from == vertex`) and incoming (`edge.to == vertex`) one-ways count toward
/// the same vertex total — a vertex is equally a "hub" whether the busy connections point away
/// from it or into it, so the count is not split or filtered by direction.
///
/// One group per over-threshold vertex, containing every one-way edge incident to it (not just
/// the excess) paired with the vertex's excess count as `to_remove` (GitHub issue #202) — see
/// `InvalidOneWayGroupIssue`'s/`OneWayGroup`'s doc comments: the group carries every candidate
/// edge, `to_remove` says how many of them actually need fixing, and the strategy decides which
/// ones. `OneWayGroupSelectStrategy` (registered against `INVALID_ONE_WAY_GROUP`) already handles
/// groups of any size and already applies its own `protect_route` exclusion when picking a
/// candidate — this check carries no `protect_route` of its own, unlike the per-edge/per-pair
/// one-way checks.
pub struct OneWayGroupSuperHubCheck {
    pub instance_id: String,
    pub max_connections: u32,
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for OneWayGroupSuperHubCheck {
    fn check_type_id(&self) -> &'static str { "one_way_group_super_hub" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidOneWayGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut by_vertex: HashMap<NodeId, Vec<EdgeId>> = HashMap::new();
        for edge in maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
        {
            by_vertex.entry(edge.from).or_default().push(edge.id);
            by_vertex.entry(edge.to).or_default().push(edge.id);
        }

        let groups: Vec<(Vec<EdgeId>, u32)> = by_vertex.into_values()
            .filter(|edges| edges.len() as u32 > self.max_connections)
            .map(|edges| {
                let to_remove = edges.len() as u32 - self.max_connections;
                (edges, to_remove)
            })
            .collect();

        if groups.is_empty() {
            return;
        }
        let issue = InvalidOneWayGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "max_connections", self.max_connections.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "one_way_group_super_hub_tests.rs"]
mod tests;
