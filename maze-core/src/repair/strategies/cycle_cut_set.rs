use crate::Maze;
use crate::generation::PresetState;
use crate::graph::EdgeKind;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use std::collections::{HashMap, HashSet};

/// Shared param id for how a cycle-breaking strategy treats `VerticalPassage` edges among its
/// cut candidates — see `Specs/repair.md`. Used by both `InvalidLoopRandomStrategy` and
/// `InvalidLoopScoredStrategy` (GitHub issue #392).
pub(super) const PARAM_VERTICAL_PASSAGE_PRIORITY: &str = "vertical_passage_priority";

pub(super) const VERTICAL_PASSAGE_PRIORITIZED: &str = "prioritized";
pub(super) const VERTICAL_PASSAGE_NEUTRAL: &str = "neutral";
pub(super) const VERTICAL_PASSAGE_PROTECTED: &str = "protected";

pub(super) static VERTICAL_PASSAGE_PRIORITY_OPTIONS: &[&str] = &[
    VERTICAL_PASSAGE_PRIORITIZED,
    VERTICAL_PASSAGE_NEUTRAL,
    VERTICAL_PASSAGE_PROTECTED,
];

/// Narrows `candidates` (already preset/already-cut filtered by `candidate_edges`) by
/// `vertical_passage_priority`: `prioritized` keeps only the `VerticalPassage` candidates when at
/// least one exists (falls back to the full pool otherwise); `protected` drops every
/// `VerticalPassage` candidate; `neutral`/unrecognized leaves the pool untouched. Applied before
/// the strategy's own pick (random or scored) so vertical priority composes with either.
pub(super) fn apply_vertical_passage_priority<T: Tessellation>(
    mut candidates: Vec<EdgeId>,
    maze: &Maze<T>,
    priority: &str,
) -> Vec<EdgeId> {
    match priority {
        VERTICAL_PASSAGE_PRIORITIZED => {
            let vertical: Vec<EdgeId> = candidates
                .iter()
                .copied()
                .filter(|&id| is_vertical_passage(maze, id))
                .collect();
            if vertical.is_empty() {
                candidates
            } else {
                vertical
            }
        }
        VERTICAL_PASSAGE_PROTECTED => {
            candidates.retain(|&id| !is_vertical_passage(maze, id));
            candidates
        }
        _ => candidates,
    }
}

fn is_vertical_passage<T: Tessellation>(maze: &Maze<T>, id: EdgeId) -> bool {
    maze.graph
        .edge(id)
        .is_some_and(|edge| edge.kind == EdgeKind::VerticalPassage)
}

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
    let Some(owned) = owners.get(&edge_id) else {
        return;
    };
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
    cycle
        .iter()
        .copied()
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
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};

    fn make_maze_and_edges(n: usize) -> (Maze<SquareTessellation>, Vec<EdgeId>) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(n, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
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
        assert_eq!(
            pending,
            vec![2],
            "cycles 0 and 1 both contain edge 2 -> both dropped"
        );
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

    fn make_maze_with_kinds(kinds: &[EdgeKind]) -> (Maze<SquareTessellation>, Vec<EdgeId>) {
        let n = kinds.len() + 1;
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(n, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let mut edge_ids = Vec::new();
        for (i, &kind) in kinds.iter().enumerate() {
            edge_ids.push(graph.add_edge(nodes[i], nodes[i + 1], kind));
        }
        (Maze::new(field, graph), edge_ids)
    }

    #[test]
    fn vertical_priority_prioritized_keeps_only_vertical_when_present() {
        let (maze, edges) =
            make_maze_with_kinds(&[EdgeKind::Basic, EdgeKind::VerticalPassage, EdgeKind::Basic]);
        let narrowed =
            apply_vertical_passage_priority(edges.clone(), &maze, VERTICAL_PASSAGE_PRIORITIZED);
        assert_eq!(narrowed, vec![edges[1]]);
    }

    #[test]
    fn vertical_priority_prioritized_falls_back_to_full_pool_when_no_vertical() {
        let (maze, edges) = make_maze_with_kinds(&[EdgeKind::Basic, EdgeKind::Teleport]);
        let narrowed =
            apply_vertical_passage_priority(edges.clone(), &maze, VERTICAL_PASSAGE_PRIORITIZED);
        assert_eq!(narrowed, edges);
    }

    #[test]
    fn vertical_priority_protected_drops_vertical_candidates() {
        let (maze, edges) =
            make_maze_with_kinds(&[EdgeKind::Basic, EdgeKind::VerticalPassage, EdgeKind::Basic]);
        let narrowed =
            apply_vertical_passage_priority(edges.clone(), &maze, VERTICAL_PASSAGE_PROTECTED);
        assert_eq!(narrowed, vec![edges[0], edges[2]]);
    }

    #[test]
    fn vertical_priority_protected_can_empty_the_pool() {
        let (maze, edges) = make_maze_with_kinds(&[EdgeKind::VerticalPassage]);
        let narrowed = apply_vertical_passage_priority(edges, &maze, VERTICAL_PASSAGE_PROTECTED);
        assert!(narrowed.is_empty());
    }

    #[test]
    fn vertical_priority_neutral_leaves_pool_untouched() {
        let (maze, edges) = make_maze_with_kinds(&[EdgeKind::Basic, EdgeKind::VerticalPassage]);
        let narrowed =
            apply_vertical_passage_priority(edges.clone(), &maze, VERTICAL_PASSAGE_NEUTRAL);
        assert_eq!(narrowed, edges);
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
