use std::collections::{HashMap, HashSet};
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
/// in this same `apply` may have already removed it), must not be preset-protected, and must not
/// already be proposed for removal earlier in the same `apply` call — `already_cut` tracks that
/// last condition, since `maze` (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot
/// contract) is never actually mutated mid-call anymore; the strategy tracks its own pending
/// removals locally instead of observing them through a real graph mutation.
pub(super) fn candidate_edges<T: Tessellation>(
    cycle: &[EdgeId],
    maze: &Maze<T>,
    preset_state: &PresetState,
    already_cut: &HashSet<EdgeId>,
) -> Vec<EdgeId> {
    cycle.iter().copied()
        .filter(|id| maze.graph.edge(*id).is_some())
        .filter(|id| !already_cut.contains(id))
        .filter(|&id| {
            let edge = maze.graph.edge(id).expect("checked above");
            !preset_state.is_preset_edge(edge.from, edge.to)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::space::{SquareTessellation, square_rect, MultiLevelField};
    use crate::IdGenerator;

    fn make_maze_and_edges(n: usize) -> (Maze<SquareTessellation>, Vec<EdgeId>) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(n, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        let mut edge_ids = Vec::new();
        for i in 0..n - 1 {
            edge_ids.push(graph.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic));
        }
        (Maze::new(field, graph), edge_ids)
    }

    #[test]
    fn edge_to_cycles_map_groups_by_edge() {
        let all = vec![vec![1, 2, 3], vec![2, 3, 4]];
        let map = edge_to_cycles_map(&all);
        assert_eq!(map.get(&1), Some(&vec![0]));
        assert_eq!(map.get(&2), Some(&vec![0, 1]));
        assert_eq!(map.get(&3), Some(&vec![0, 1]));
        assert_eq!(map.get(&4), Some(&vec![1]));
    }

    #[test]
    fn edge_to_cycles_map_empty_input_is_empty() {
        let all: Vec<Vec<EdgeId>> = vec![];
        assert!(edge_to_cycles_map(&all).is_empty());
    }

    #[test]
    fn discard_cycles_with_edge_removes_all_owning_cycles() {
        let all = vec![vec![1, 2], vec![2, 3], vec![4]];
        let owners = edge_to_cycles_map(&all);
        let mut pending = vec![0, 1, 2];
        discard_cycles_with_edge(&mut pending, &owners, 2);
        assert_eq!(pending, vec![2], "cycles 0 and 1 both contain edge 2 -> both dropped");
    }

    #[test]
    fn discard_cycles_with_edge_unknown_edge_is_noop() {
        let all = vec![vec![1, 2]];
        let owners = edge_to_cycles_map(&all);
        let mut pending = vec![0];
        discard_cycles_with_edge(&mut pending, &owners, 999);
        assert_eq!(pending, vec![0]);
    }

    #[test]
    fn candidate_edges_filters_out_removed_edges() {
        let (mut maze, edges) = make_maze_and_edges(3);
        maze.graph.remove_edge(edges[0]);
        let candidates = candidate_edges(&edges, &maze, &PresetState::empty(), &HashSet::new());
        assert_eq!(candidates, vec![edges[1]]);
    }

    #[test]
    fn candidate_edges_filters_out_preset_protected_edges() {
        let (maze, edges) = make_maze_and_edges(3);
        let edge0 = maze.graph.edge(edges[0]).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((edge0.from, edge0.to));
        let candidates = candidate_edges(&edges, &maze, &preset_state, &HashSet::new());
        assert_eq!(candidates, vec![edges[1]]);
    }

    #[test]
    fn candidate_edges_returns_all_when_nothing_filtered() {
        let (maze, edges) = make_maze_and_edges(3);
        let candidates = candidate_edges(&edges, &maze, &PresetState::empty(), &HashSet::new());
        assert_eq!(candidates, edges);
    }

    #[test]
    fn candidate_edges_empty_cycle_returns_empty() {
        let (maze, _) = make_maze_and_edges(3);
        let candidates = candidate_edges(&[], &maze, &PresetState::empty(), &HashSet::new());
        assert!(candidates.is_empty());
    }

    #[test]
    fn candidate_edges_filters_out_already_cut_edges() {
        let (maze, edges) = make_maze_and_edges(3);
        let mut already_cut = HashSet::new();
        already_cut.insert(edges[0]);
        let candidates = candidate_edges(&edges, &maze, &PresetState::empty(), &already_cut);
        assert_eq!(candidates, vec![edges[1]]);
    }
}
