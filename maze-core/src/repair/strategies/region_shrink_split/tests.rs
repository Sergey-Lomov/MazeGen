use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind as EK, Graph};
use crate::random::MazeRng;
use crate::repair::strategies::test_utils::apply_and_commit_default;
use crate::space::{MultiLevelField, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::collections::HashMap as StdHashMap;
use std::sync::Arc;

fn build_field(w: usize, h: usize) -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(w, h), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let nodes: Vec<_> = field
        .field_of(field_level)
        .unwrap()
        .all_cells()
        .map(|p| field.node_at(field_level, p).unwrap())
        .collect();
    (Maze::new(field, g), nodes)
}

fn issue_for(invalid: Vec<usize>) -> RegionNeedsShrinkIssue {
    RegionNeedsShrinkIssue::new_from_check("test", invalid, StdHashMap::new())
}

/// 1x6 row, wired into a single bidirectional chain 0-1-2-3-4-5 -> one SCC region of size 6.
fn maze_chain_region(len: usize) -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (mut maze, nodes) = build_field(len, 1);
    for w in nodes.windows(2) {
        maze.graph.add_bidirectional_edge(w[0], w[1], EK::Basic);
    }
    (maze, nodes)
}

#[test]
fn apply_fixed_immediately_when_invalid_is_empty() {
    let (mut maze, _) = maze_chain_region(4);
    let issue = issue_for(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit_default(
        &RegionShrinkSplitStrategy {
            protect_route: true,
        },
        &issue,
        &mut maze,
        &mut rng,
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), edges_before);
}

#[test]
fn apply_splits_chain_region_into_two_sccs() {
    let (mut maze, nodes) = maze_chain_region(6);
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    assert_eq!(maze.analysis.scc(&maze.graph).components.len(), 1);

    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit_default(
        &RegionShrinkSplitStrategy {
            protect_route: true,
        },
        &issue,
        &mut maze,
        &mut rng,
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let scc_after = maze.analysis.scc(&maze.graph);
    assert!(
        scc_after.components.len() >= 2,
        "chain region must split into at least two SCCs"
    );
}

#[test]
fn apply_never_cuts_a_preset_edge() {
    let (mut maze, nodes) = maze_chain_region(4); // 0-1-2-3
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(5);

    let mut preset_edges = std::collections::HashSet::new();
    preset_edges.insert((nodes[1], nodes[2]));
    preset_edges.insert((nodes[2], nodes[1]));
    let preset_state = PresetState {
        preset_edges,
        ..PresetState::empty()
    };

    apply_and_commit_default(
        &RegionShrinkSplitStrategy {
            protect_route: true,
        },
        &issue,
        &mut maze,
        &mut rng,
        &preset_state,
    );

    // Whatever happened, the preset passage between nodes[1] and nodes[2] must survive intact.
    assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_some());
    assert!(maze.graph.edge_between(nodes[2], nodes[1]).is_some());
}

#[test]
fn apply_failed_when_whole_region_is_one_unremovable_group() {
    let (mut maze, nodes) = maze_chain_region(3); // 0-1-2
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(9);

    // Every edge in the region is preset-protected -> the whole region is one group -> no split possible.
    let mut preset_edges = std::collections::HashSet::new();
    for w in nodes.windows(2) {
        preset_edges.insert((w[0], w[1]));
        preset_edges.insert((w[1], w[0]));
    }
    let preset_state = PresetState {
        preset_edges,
        ..PresetState::empty()
    };

    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit_default(
        &RegionShrinkSplitStrategy {
            protect_route: true,
        },
        &issue,
        &mut maze,
        &mut rng,
        &preset_state,
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(
        maze.graph.edges().count(),
        edges_before,
        "a Failed strategy must not mutate the graph"
    );
}

#[test]
fn apply_failed_when_whole_route_is_protected_and_covers_the_whole_region() {
    let (mut maze, nodes) = maze_chain_region(4); // 0-1-2-3, no branches: the only route is the whole chain
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[3]);
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(11);

    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit_default(
        &RegionShrinkSplitStrategy {
            protect_route: true,
        },
        &issue,
        &mut maze,
        &mut rng,
        &PresetState::empty(),
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "every edge sits on the only start-finish route -> one unremovable group"
    );
    assert_eq!(maze.graph.edges().count(), edges_before);
}

#[test]
fn apply_splits_route_when_protect_route_is_disabled() {
    let (mut maze, nodes) = maze_chain_region(4); // 0-1-2-3
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[3]);
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(13);

    let result = apply_and_commit_default(
        &RegionShrinkSplitStrategy {
            protect_route: false,
        },
        &issue,
        &mut maze,
        &mut rng,
        &PresetState::empty(),
    );
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "with route protection disabled the chain can still be split"
    );

    let scc_after = maze.analysis.scc(&maze.graph);
    assert!(scc_after.components.len() >= 2);
}

/// Star topology: one 2-node hub group (0-1, merged as unremovable) at the center, with 4
/// singleton groups (10, 20, 30, 40) each connected to the hub by exactly one edge — the hub is
/// the only path between any two spokes.
fn star_graph_with_hub_group() -> (Graph, HashMap<NodeId, Vec<NodeId>>, HashMap<NodeId, NodeId>) {
    let mut g = Graph::new();
    for &n in &[0u64, 1, 10, 20, 30, 40] {
        g.add_node(n);
    }
    g.add_bidirectional_edge(0, 1, EK::Basic); // hub internal edge (unremovable in the group map)
    for &spoke in &[10u64, 20, 30, 40] {
        g.add_bidirectional_edge(0, spoke, EK::Basic);
    }

    let mut groups: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    groups.insert(0, vec![0, 1]); // hub group, keyed by its lowest member
    for &spoke in &[10u64, 20, 30, 40] {
        groups.insert(spoke, vec![spoke]);
    }
    let group_key_of: HashMap<NodeId, NodeId> = groups
        .iter()
        .flat_map(|(&key, members)| members.iter().map(move |&n| (n, key)))
        .collect();
    (g, groups, group_key_of)
}

#[test]
fn grow_balanced_sides_splits_star_topology_through_the_hub() {
    let (g, groups, group_key_of) = star_graph_with_hub_group();
    let region: Vec<NodeId> = vec![0, 1, 10, 20, 30, 40];

    // Seeds are two opposite spokes; the hub group must end up entirely on one side (never split)
    // and every node must be assigned exactly once.
    let side_a = grow_balanced_sides(&g, &region, &groups, &group_key_of, 10, 30);
    let side_a_set: HashSet<NodeId> = side_a.iter().copied().collect();

    assert_eq!(
        side_a.len() + (region.len() - side_a.len()),
        region.len(),
        "every region node assigned to exactly one side"
    );
    // Hub group (0, 1) never gets split across sides.
    assert_eq!(
        side_a_set.contains(&0),
        side_a_set.contains(&1),
        "hub group must stay together"
    );
    // Seed groups end up on opposite sides.
    assert_ne!(side_a_set.contains(&10), side_a_set.contains(&30));
}

/// Lopsided topology: side "a"'s seed (100) is a dead-end leaf with exactly one neighbor (the
/// hub) and no group of its own left to claim after that single step, while side "b"'s seed (10)
/// sits at the head of a 4-group chain (10-20-30-40) with plenty left to claim. Side "a" is
/// smaller and thus preferred (`size_a <= size_b`) every round until its own frontier empties —
/// forcing the `!claimed` fallback to award a group to side "b" *while `take_a` was true*
/// (`grow_balanced_sides`' `claim_one(&mut queue_b, ...)` cross-claim branch), not just the
/// mirror-image case the hub-star fixture above already covers.
fn lopsided_graph_with_dead_end_seed()
-> (Graph, HashMap<NodeId, Vec<NodeId>>, HashMap<NodeId, NodeId>) {
    let mut g = Graph::new();
    // 999 exists in the graph but is deliberately left out of every group/region below, so
    // `group_neighbors`' `!region_set.contains(&neighbor) { continue; }` guard has a real
    // out-of-region neighbor to skip (see the hub's extra edge to it below).
    for &n in &[0u64, 10, 20, 30, 40, 100, 999] {
        g.add_node(n);
    }
    g.add_bidirectional_edge(0, 100, EK::Basic); // hub <-> dead-end leaf (side "a"'s seed)
    g.add_bidirectional_edge(0, 10, EK::Basic); // hub <-> head of side "b"'s chain
    g.add_bidirectional_edge(10, 20, EK::Basic);
    g.add_bidirectional_edge(20, 30, EK::Basic);
    g.add_bidirectional_edge(30, 40, EK::Basic);
    g.add_bidirectional_edge(0, 999, EK::Basic); // hub <-> node outside the region entirely

    let mut groups: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for &n in &[0u64, 10, 20, 30, 40, 100] {
        groups.insert(n, vec![n]); // every node its own singleton group
    }
    let group_key_of: HashMap<NodeId, NodeId> = groups
        .iter()
        .flat_map(|(&key, members)| members.iter().map(move |&n| (n, key)))
        .collect();
    (g, groups, group_key_of)
}

#[test]
fn grow_balanced_sides_cross_claims_for_side_a_when_its_own_frontier_is_exhausted() {
    let (g, groups, group_key_of) = lopsided_graph_with_dead_end_seed();
    let region: Vec<NodeId> = vec![0, 10, 20, 30, 40, 100]; // 999 deliberately excluded

    // seed_a = 100 (dead end), seed_b = 10 (head of a 4-node chain).
    let side_a = grow_balanced_sides(&g, &region, &groups, &group_key_of, 100, 10);
    let side_a_set: HashSet<NodeId> = side_a.iter().copied().collect();

    assert_eq!(
        side_a_set.len(),
        side_a.len(),
        "no duplicate node in side a"
    );
    assert_eq!(
        side_a.len() + (region.len() - side_a.len()),
        region.len(),
        "every node assigned exactly once"
    );
    // Side "a" can only ever grow by claiming the hub (0) from its dead end -- everything past the
    // hub belongs to side "b", proving the hub itself was the one cross-claimed group side "a" got
    // via the `!claimed` fallback, not a group it could have reached through its own frontier alone.
    assert!(side_a_set.contains(&100));
    assert!(
        side_a_set.contains(&0),
        "side a's only reachable extension (the hub) must be claimed by it, not stranded"
    );
    assert!(
        !side_a_set.contains(&40),
        "the far end of side b's chain must never end up on side a"
    );
    assert!(
        !side_a_set.contains(&999),
        "a node outside the region must never be pulled into either side"
    );
}

#[test]
fn split_region_ignores_edges_leaving_the_region_when_collecting_the_cut_set() {
    let (mut maze, nodes) = maze_chain_region(6); // 0-1-2-3-4-5, one SCC region
    // A one-way edge out of the region into a node outside it -- doesn't join the outsider's own
    // singleton SCC into this region, but does give every node on the chain a real "neighbor
    // outside the region" to skip while building the cut set (`split_region`'s own
    // `!region_set.contains` guard, not `grow_balanced_sides`' identical guard already covered
    // elsewhere).
    let outsider = nodes.iter().max().unwrap() + 1;
    maze.graph.add_node(outsider);
    for &n in &nodes {
        maze.graph.add_edge(n, outsider, EK::Basic);
    }

    let region: Vec<NodeId> = nodes.clone();
    let cut = split_region(&maze, &region, &PresetState::empty(), true).unwrap();
    for &(from, to) in &cut {
        assert_ne!(
            from, outsider,
            "the cut set must never mention a node outside the region"
        );
        assert_ne!(
            to, outsider,
            "the cut set must never mention a node outside the region"
        );
    }
}

#[test]
fn split_region_never_returns_a_boundary_edge_when_groups_collapse() {
    let (maze, nodes) = maze_chain_region(3);
    let region: Vec<NodeId> = nodes.clone();
    let mut preset_edges = std::collections::HashSet::new();
    for w in nodes.windows(2) {
        preset_edges.insert((w[0], w[1]));
        preset_edges.insert((w[1], w[0]));
    }
    let preset_state = PresetState {
        preset_edges,
        ..PresetState::empty()
    };
    assert!(split_region(&maze, &region, &preset_state, true).is_none());
}
