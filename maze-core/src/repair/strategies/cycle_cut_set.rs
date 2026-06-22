use std::collections::HashMap;
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::generation::PresetState;

/// Maps each edge to the indices (into `all`) of every cycle that contains it. Used to find,
/// in O(1), which other pending cycles become moot once a given edge is cut — keeps a cut from
/// being "wasted" on a cycle that's already broken, and is meant to stay the general mechanism
/// for dropping cycles from the pending set regardless of why a cycle stops needing a cut.
pub(super) fn edge_to_cycles_map(all: &[Vec<EdgeId>]) -> HashMap<EdgeId, Vec<usize>> {
    let mut map: HashMap<EdgeId, Vec<usize>> = HashMap::new();
    for (idx, cycle) in all.iter().enumerate() {
        for &eid in cycle {
            map.entry(eid).or_default().push(idx);
        }
    }
    map
}

/// Drops every cycle index that contains `edge_id` from `pending` — once that edge is cut, none
/// of those cycles are still intact, so none of them need their own cut anymore.
pub(super) fn discard_cycles_with_edge(
    pending: &mut Vec<usize>,
    owners: &HashMap<EdgeId, Vec<usize>>,
    edge_id: EdgeId,
) {
    let Some(owned) = owners.get(&edge_id) else { return };
    pending.retain(|idx| !owned.contains(idx));
}

/// Candidate edges for cutting within one cycle: must still exist in the graph (an earlier cut
/// in this same `apply` may have already removed it) and must not be preset-protected.
pub(super) fn candidate_edges<T: Tessellation>(
    cycle: &[EdgeId],
    maze: &Maze<T>,
    preset_state: &PresetState,
) -> Vec<EdgeId> {
    cycle.iter().copied()
        .filter(|&id| maze.graph.edge(id).is_some())
        .filter(|&id| {
            let edge = maze.graph.edge(id).expect("checked above");
            !preset_state.preset_edges.contains(&(edge.from, edge.to))
        })
        .collect()
}
