use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind as EK, Graph as G};
use crate::random::MazeRng;
use crate::repair::draft::DraftMaze;
use crate::space::{MultiLevelField, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::sync::Arc;

#[test]
fn filter_by_border_drops_a_candidate_with_zero_border_on_every_needed_side() {
    // {n3,n4,n5} borders nothing reachable on its own (per the fixture's doc-comment: no
    // member is a field-neighbor of start/finish) -- for `Unreachable -> Trap` (needs inbound
    // only), it must be dropped entirely, not merely deprioritized.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let n3 = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let n3_component = scc.component_of(n3).unwrap();
    let mut candidates = vec![n3_component];

    let reachable_from_start: HashSet<NodeId> =
        maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> =
        maze.graph.reachable_to(finish).into_iter().collect();
    filter_by_border(
        &maze,
        &mut candidates,
        RegionClass::Trap,
        &classes,
        &scc,
        &reachable_from_start,
        &reachable_to_finish,
        true,
        true,
    );

    assert!(
        !candidates.contains(&n3_component),
        "{{n3,n4,n5}} has zero inbound border -- must be filtered out"
    );
}

#[test]
fn filter_by_border_keeps_a_candidate_with_the_needed_border() {
    // region6 borders reachable_from_start (finish, via the start->finish edge) -- for
    // `Unreachable -> Trap` (needs inbound only), it must survive the filter.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let region6 = nodes[2];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let region6_component = scc.component_of(region6).unwrap();
    let mut candidates = vec![region6_component];

    let reachable_from_start: HashSet<NodeId> =
        maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> =
        maze.graph.reachable_to(finish).into_iter().collect();
    let border_count = filter_by_border(
        &maze,
        &mut candidates,
        RegionClass::Trap,
        &classes,
        &scc,
        &reachable_from_start,
        &reachable_to_finish,
        true,
        true,
    );

    assert!(
        candidates.contains(&region6_component),
        "region6 has an inbound border -- must survive the filter"
    );
    assert!(
        border_count.get(&region6_component).copied().unwrap_or(0) > 0,
        "surviving border-needing candidate must have a recorded border-count"
    );
}

#[test]
fn filter_by_border_keeps_alternative_candidate_with_only_one_of_the_two_needed_borders() {
    // For `Unreachable -> Alternative` (needs BOTH inbound and outbound), a candidate with
    // only ONE of the two must still survive the filter -- the missing side can be reached
    // later via absorbing a same-class neighbor, so requiring both up front would wrongly
    // reject it. region6 borders reachable_from_start (finish, inbound) but its only other
    // field-neighbor is n5 (part of {n3,n4,n5}, not finish-reachable) -- zero outbound border.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let region6 = nodes[2];
    let n5 = nodes[5];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let region6_component = scc.component_of(region6).unwrap();
    let mut candidates = vec![region6_component];

    let reachable_from_start: HashSet<NodeId> =
        maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> =
        maze.graph.reachable_to(finish).into_iter().collect();
    assert!(
        !reachable_to_finish.contains(&n5),
        "sanity: n5 (region6's only other neighbor) must not be finish-reachable"
    );

    filter_by_border(
        &maze,
        &mut candidates,
        RegionClass::Alternative,
        &classes,
        &scc,
        &reachable_from_start,
        &reachable_to_finish,
        true,
        true,
    );

    assert!(
        candidates.contains(&region6_component),
        "region6 has only an inbound border (no outbound) -- must still survive the OR-filter for Alternative"
    );
}

#[test]
fn filter_by_border_keeps_a_border_less_candidate_when_its_needed_side_has_geometry_disabled() {
    // {n3,n4,n5} has zero inbound border -- with plain geometric bridging (both flags `true`,
    // see `filter_by_border_drops_a_candidate_with_zero_border_on_every_needed_side`) it's
    // dropped. But a teleport-style bridging mechanism doesn't need a field-adjacent border to
    // place its inbound edge -- disabling `inbound_requires_geometry` must keep it instead.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let n3 = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let n3_component = scc.component_of(n3).unwrap();
    let mut candidates = vec![n3_component];

    let reachable_from_start: HashSet<NodeId> =
        maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> =
        maze.graph.reachable_to(finish).into_iter().collect();
    let border_count = filter_by_border(
        &maze,
        &mut candidates,
        RegionClass::Trap,
        &classes,
        &scc,
        &reachable_from_start,
        &reachable_to_finish,
        false,
        true,
    );

    assert!(
        candidates.contains(&n3_component),
        "inbound geometry disabled -- border-less {{n3,n4,n5}} must survive"
    );
    assert!(
        !border_count.contains_key(&n3_component),
        "a side with geometry disabled contributes no border-count"
    );
}

#[test]
fn filter_by_border_keeps_everything_when_both_geometry_flags_are_disabled() {
    // With both flags off, no border check happens at all for any candidate -- every candidate
    // whose class can transition to `target` is kept, matching a fully teleport-based bridging
    // mechanism where geometric placement is irrelevant on both sides.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let n3 = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let n3_component = scc.component_of(n3).unwrap();
    let mut candidates = vec![n3_component];

    let reachable_from_start: HashSet<NodeId> =
        maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> =
        maze.graph.reachable_to(finish).into_iter().collect();
    let border_count = filter_by_border(
        &maze,
        &mut candidates,
        RegionClass::Alternative,
        &classes,
        &scc,
        &reachable_from_start,
        &reachable_to_finish,
        false,
        false,
    );

    assert!(
        candidates.contains(&n3_component),
        "both geometry requirements disabled -- border-less {{n3,n4,n5}} must survive even for Alternative (needs both sides)"
    );
    assert!(
        border_count.is_empty(),
        "no side requires geometry -- no border-count should be recorded for anyone"
    );
}

/// 1x5 row: 0=start, 1=finish (edge 0->1), 2=candidate (singleton Unreachable, field-neighbor
/// of node 3 only, no graph edge to it), 3=trap_neighbor (singleton Trap: directed edge 1->3,
/// so it's reachable from start but can't reach finish -- a DIFFERENT class than `candidate`).
/// 4 is left disconnected/unused as a geometric buffer so `trap_neighbor` has exactly one
/// bordering component (`candidate`) to be absorbed by.
fn maze_with_candidate_and_different_class_neighbor() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(5);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[3], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn absorb_until_min_size_absorbs_a_neighbor_of_a_different_class_when_it_has_budget() {
    let (maze, nodes) = maze_with_candidate_and_different_class_neighbor();
    let candidate = nodes[2];
    let trap_neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    assert_eq!(
        classes.get(&scc.component_of(candidate).unwrap()).copied(),
        Some(RegionClass::Unreachable)
    );
    assert_eq!(
        classes
            .get(&scc.component_of(trap_neighbor).unwrap())
            .copied(),
        Some(RegionClass::Trap),
        "sanity: neighbor must be a DIFFERENT class than the candidate"
    );

    let candidate_idx = scc.component_of(candidate).unwrap();
    let mut members: HashSet<NodeId> = [candidate].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    absorb_until_min_size(
        &mut draft,
        &mut members,
        candidate_idx,
        2,
        &scc,
        &classes,
        &mut budget,
        &critical,
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    assert!(
        members.contains(&trap_neighbor),
        "trap_neighbor has its own budget -- must be absorbed despite being a different class"
    );
    assert_eq!(
        budget.get(&RegionClass::Trap),
        None,
        "trap_neighbor's budget (1) fully spent on its own 1-node size -- entry removed"
    );
    assert!(
        draft
            .maze
            .graph
            .edge_between(candidate, trap_neighbor)
            .is_some(),
        "a bidirectional bridge must have been added"
    );
    assert!(
        draft
            .maze
            .graph
            .edge_between(trap_neighbor, candidate)
            .is_some(),
        "a bidirectional bridge must have been added"
    );
}

#[test]
fn absorb_until_min_size_does_not_absorb_when_the_neighbor_has_no_budget() {
    let (maze, nodes) = maze_with_candidate_and_different_class_neighbor();
    let candidate = nodes[2];
    let trap_neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);

    let candidate_idx = scc.component_of(candidate).unwrap();
    let mut members: HashSet<NodeId> = [candidate].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget: HashMap<RegionClass, i32> = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    absorb_until_min_size(
        &mut draft,
        &mut members,
        candidate_idx,
        2,
        &scc,
        &classes,
        &mut budget,
        &critical,
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    assert!(
        !members.contains(&trap_neighbor),
        "no budget entry for Trap at all -- trap_neighbor must remain outside members"
    );
    assert_eq!(
        members.len(),
        1,
        "members must stay at just the candidate's own node"
    );
    assert!(
        draft
            .maze
            .graph
            .edge_between(candidate, trap_neighbor)
            .is_none(),
        "no edge should have been added"
    );
}

#[test]
fn absorb_until_min_size_skips_a_blocked_edge_and_succeeds_via_another_in_the_pool() {
    // 3x2 grid: candidate = (1,0), with TWO field-neighbors both inside the same 2-node Trap
    // component: (0,0) and (1,1). Block the (1,0)<->(0,0) edge specifically -- absorption
    // must still succeed via the (1,0)<->(1,1) edge instead of giving up on the whole
    // component, proving a single blocked edge is discarded from the pool, not its entire
    // bordering component.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 2), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = G::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let n = |x: i32, y: i32| {
        field
            .node_at(field_level, crate::space::SquarePoint { x, y })
            .unwrap()
    };
    let start = n(2, 0);
    let finish = n(2, 1);
    let candidate = n(1, 0); // Unreachable singleton, field-neighbors: start(2,0), trap_a(0,0), trap_b(1,1)
    let trap_a = n(0, 0);
    let trap_b = n(1, 1);
    g.add_edge(start, finish, EK::Basic);
    g.add_edge(finish, trap_b, EK::Basic); // trap_a, trap_b reachable from start via finish -> can't reach finish back -> Trap
    g.add_bidirectional_edge(trap_a, trap_b, EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);

    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    assert_eq!(
        classes.get(&scc.component_of(candidate).unwrap()).copied(),
        Some(RegionClass::Unreachable)
    );
    assert_eq!(
        classes.get(&scc.component_of(trap_a).unwrap()).copied(),
        Some(RegionClass::Trap),
        "sanity: {{trap_a,trap_b}} must be one Trap component"
    );
    assert_eq!(
        scc.component_of(trap_a),
        scc.component_of(trap_b),
        "sanity: both bridge targets must be the SAME component"
    );

    let mut preset_state = PresetState::empty();
    // Block only the candidate<->trap_a edge -- the candidate<->trap_b edge into the SAME
    // component must still be tried and succeed.
    preset_state.blocked.insert((candidate, trap_a));
    preset_state.blocked.insert((trap_a, candidate));

    let candidate_idx = scc.component_of(candidate).unwrap();
    let mut members: HashSet<NodeId> = [candidate].into_iter().collect();
    let critical: HashSet<NodeId> = [start, finish].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Trap, 2)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    absorb_until_min_size(
        &mut draft,
        &mut members,
        candidate_idx,
        2,
        &scc,
        &classes,
        &mut budget,
        &critical,
        &test_ctx(&HashSet::new(), &preset_state),
        &mut rng,
    );

    assert!(
        members.contains(&trap_a) && members.contains(&trap_b),
        "the component must still be absorbed via the non-blocked edge"
    );
    assert!(
        draft.maze.graph.edge_between(candidate, trap_a).is_none(),
        "the blocked edge must never have been added"
    );
    assert!(
        draft.maze.graph.edge_between(trap_a, candidate).is_none(),
        "the blocked edge must never have been added"
    );
    assert!(
        draft.maze.graph.edge_between(candidate, trap_b).is_some(),
        "the non-blocked edge must have been added instead"
    );
    assert!(
        draft.maze.graph.edge_between(trap_b, candidate).is_some(),
        "the non-blocked edge must have been added instead"
    );
}

#[test]
fn prioritize_candidates_puts_a_large_enough_candidate_ahead_of_a_smaller_one_with_more_border() {
    // region6 (1 node) and {n3,n4,n5} (3 nodes) -- give the SMALLER one (region6) a bigger
    // border_count than the larger one, to isolate the size-tier check: even with a worse
    // border-count, the already-large-enough {n3,n4,n5} must still sort ahead of region6.
    let (maze, nodes) = maze_with_two_isolated_unreachable_components();
    let scc = maze.analysis.scc(&maze.graph);
    let n3_component = scc.component_of(nodes[3]).unwrap(); // {n3,n4,n5}, size 3
    let region6_component = scc.component_of(nodes[6]).unwrap(); // size 1
    assert_eq!(scc.components[n3_component].len(), 3);
    assert_eq!(scc.components[region6_component].len(), 1);

    let mut candidates = vec![region6_component, n3_component];
    let border_count = HashMap::from([(region6_component, 5usize), (n3_component, 1usize)]);
    let mut rng = MazeRng::seed_from_u64(1);

    prioritize_candidates(&mut candidates, &scc, &border_count, 2, &mut rng);

    assert_eq!(
        candidates[0], n3_component,
        "size >= min_region_size must outrank a smaller candidate regardless of border_count"
    );
}

#[test]
fn prioritize_candidates_orders_by_border_count_within_the_same_size_tier() {
    // Two same-size-tier candidates (both below min_region_size) -- border_count alone decides
    // the order.
    let (maze, nodes) = maze_with_two_isolated_unreachable_components();
    let scc = maze.analysis.scc(&maze.graph);
    let n3_component = scc.component_of(nodes[3]).unwrap(); // size 3
    let region6_component = scc.component_of(nodes[6]).unwrap(); // size 1

    let mut candidates = vec![region6_component, n3_component];
    // min_region_size=10 -- both candidates fall in the same "too small" tier.
    let border_count = HashMap::from([(region6_component, 1usize), (n3_component, 5usize)]);
    let mut rng = MazeRng::seed_from_u64(1);

    prioritize_candidates(&mut candidates, &scc, &border_count, 10, &mut rng);

    assert_eq!(
        candidates[0], n3_component,
        "within the same size tier, higher border_count must sort first"
    );
}
