use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind as EK, Graph as G};
use crate::random::MazeRng;
use crate::repair::draft::DraftMaze;
use crate::space::{MultiLevelField, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::sync::Arc;

/// 1x4 row: 0=start, 1=finish (edge 0->1), 2=candidate (singleton Unreachable, field-neighbor
/// of finish only, no graph edge to it). 3 is a geometric buffer so candidate has exactly one
/// field-neighbor outside itself (finish).
fn maze_with_isolated_candidate() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(4);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn convert_region_unreachable_to_trap_adds_inbound_from_scratch() {
    let (maze, nodes) = maze_with_isolated_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Trap,
        &PresetState::empty(),
        &mut rng,
    );

    assert!(
        result.is_some(),
        "must add an inbound edge and land on Trap"
    );
    assert!(
        draft.maze.graph.edge_between(nodes[1], candidate).is_some(),
        "inbound edge from finish must have been added"
    );
    let classes =
        draft
            .maze
            .analysis
            .region_classes(&draft.maze.graph, &draft.maze.field, &draft.maze.meta);
    let scc = draft.maze.analysis.scc(&draft.maze.graph);
    assert_eq!(
        classes.get(&scc.component_of(candidate).unwrap()).copied(),
        Some(RegionClass::Trap)
    );
}

/// 5x3 grid, row y=0 is a separate direct start->finish path that never touches row y=2 -- the
/// shortest route, so nothing in row y=2 can ever become Path no matter what gets bridged there.
/// Row y=1 stays entirely disconnected as a geometric buffer (see `maze_with_trap_candidate`'s
/// doc-comment for why -- avoids a candidate directly above/below a path node becoming an extra
/// bridging candidate). mid=(1,2) is reachable from start (directed edge start->mid) but has no
/// route to finish at all. candidate=(2,2) is an isolated Unreachable singleton. other=(3,2) has
/// a directed edge other->(3,0) (finish-reachable, not finish itself). candidate's only two
/// field-neighbors are mid (reachable-from-start-only) and other (finish-reachable-only) -- the
/// two sides never overlap, so there is exactly one valid candidate for each bridge direction,
/// deterministically regardless of shuffle.
fn maze_with_isolated_candidate_having_two_distinct_neighbors()
-> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(5, 3), &mut ids).unwrap();
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
    let start = n(0, 0);
    let finish = n(4, 0);
    let mid = n(1, 2);
    let candidate = n(2, 2);
    let other = n(3, 2);
    for x in 0..4 {
        g.add_edge(n(x, 0), n(x + 1, 0), EK::Basic);
    }
    g.add_edge(start, mid, EK::Basic);
    g.add_edge(other, n(3, 0), EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (maze, vec![start, mid, candidate, other, finish])
}

#[test]
fn convert_region_unreachable_to_alternative_adds_both_inbound_and_outbound() {
    let (maze, nodes) = maze_with_isolated_candidate_having_two_distinct_neighbors();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Alternative,
        &PresetState::empty(),
        &mut rng,
    );

    assert!(
        result.is_some(),
        "must add both inbound and outbound edges and land on Alternative"
    );
    let classes =
        draft
            .maze
            .analysis
            .region_classes(&draft.maze.graph, &draft.maze.field, &draft.maze.meta);
    let scc = draft.maze.analysis.scc(&draft.maze.graph);
    assert_eq!(
        classes.get(&scc.component_of(candidate).unwrap()).copied(),
        Some(RegionClass::Alternative)
    );
}

/// 5x3 grid, row y=0 is a separate direct start->finish path (0,0)->(1,0)->(2,0)->(3,0)->(4,0)
/// that never touches row y=2 -- this is the shortest route, so nothing in row y=2 can ever
/// become Path no matter what gets bridged there. Row y=1 stays entirely disconnected (no
/// edges at all) so it never becomes a field-neighbor bridge target either -- it's pure
/// geometric buffer between the path row and the candidate row, since square tessellation gives
/// every node 4-directional neighbors (including vertical), and a candidate directly above/below
/// a path node would otherwise be a 3rd bridging candidate. Row y=2: mid=(1,2) is reachable from
/// start (directed edge (0,0)->(1,2), i.e. start->mid) but has no route to finish at all.
/// candidate=(2,2) has an existing inbound edge mid->candidate (Trap: reachable from start,
/// can't reach finish). other=(3,2) has a directed edge other->(3,0) (into finish-reachable
/// territory, but not finish itself). candidate's only two field-neighbors are mid
/// (reachable-from-start-only) and other (finish-reachable-only) -- the two sides never
/// overlap, so there is exactly one valid candidate for each bridge direction, deterministically
/// regardless of shuffle.
fn maze_with_trap_candidate() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(5, 3), &mut ids).unwrap();
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
    let start = n(0, 0);
    let finish = n(4, 0);
    let mid = n(1, 2);
    let candidate = n(2, 2);
    let other = n(3, 2);
    for x in 0..4 {
        g.add_edge(n(x, 0), n(x + 1, 0), EK::Basic);
    }
    g.add_edge(start, mid, EK::Basic);
    g.add_edge(mid, candidate, EK::Basic);
    g.add_edge(other, n(3, 0), EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (maze, vec![start, mid, candidate, other, finish])
}

#[test]
fn convert_region_trap_to_alternative_adds_outbound_only() {
    let (maze, nodes) = maze_with_trap_candidate();
    let mid = nodes[1];
    let candidate = nodes[2];
    let other = nodes[3];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let scc = maze.analysis.scc(&maze.graph);
    let classes_before = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    assert_eq!(
        classes_before
            .get(&scc.component_of(candidate).unwrap())
            .copied(),
        Some(RegionClass::Trap),
        "sanity: candidate must start as Trap"
    );
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Alternative,
        &PresetState::empty(),
        &mut rng,
    );

    assert!(
        result.is_some(),
        "must add an outbound edge and land on Alternative"
    );
    assert!(
        draft.maze.graph.edge_between(candidate, other).is_some(),
        "outbound edge into finish-reachable territory must have been added"
    );
    // Original inbound edge (mid->candidate) must remain untouched -- Trap->Alternative never touches inbound.
    assert!(
        draft.maze.graph.edge_between(mid, candidate).is_some(),
        "pre-existing inbound edge must be preserved"
    );
}

#[test]
fn convert_region_trap_to_unreachable_cuts_inbound() {
    let (maze, nodes) = maze_with_trap_candidate();
    let mid = nodes[1];
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Unreachable,
        &PresetState::empty(),
        &mut rng,
    );

    assert!(
        result.is_some(),
        "must cut the inbound edge and land on Unreachable"
    );
    assert!(
        draft.maze.graph.edge_between(mid, candidate).is_none(),
        "inbound edge must have been removed"
    );
}

/// 1x4 row: 0=start, 1=finish. Directed edges 0->2 (inbound from start) and 2->1 (outbound to
/// finish) make candidate=2 reachable from start AND able to reach finish -- Alternative.
fn maze_with_alternative_candidate() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(4);
    let n = |i: usize| nodes[i];
    // start(0) -> finish(1) not directly connected; route must go through candidate(2) itself
    // being reachable and able to reach finish, without candidate being ON the shortest path --
    // use an alternate direct start->finish edge so candidate stays off the critical path.
    g.add_edge(n(0), n(1), EK::Basic);
    g.add_edge(n(0), n(2), EK::Basic);
    g.add_edge(n(2), n(1), EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(n(0));
    maze.meta.finish = Some(n(1));
    (maze, nodes)
}

#[test]
fn convert_region_alternative_to_trap_cuts_outbound() {
    let (maze, nodes) = maze_with_alternative_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let scc = maze.analysis.scc(&maze.graph);
    let classes_before = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    assert_eq!(
        classes_before
            .get(&scc.component_of(candidate).unwrap())
            .copied(),
        Some(RegionClass::Alternative),
        "sanity: candidate must start as Alternative"
    );
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Trap,
        &PresetState::empty(),
        &mut rng,
    );

    assert!(
        result.is_some(),
        "must cut the outbound edge and land on Trap"
    );
    assert!(
        draft.maze.graph.edge_between(candidate, nodes[1]).is_none(),
        "outbound edge to finish must have been removed"
    );
    assert!(
        draft.maze.graph.edge_between(nodes[0], candidate).is_some(),
        "inbound edge must be preserved -- Alternative->Trap never touches inbound"
    );
}

#[test]
fn convert_region_alternative_to_unreachable_cuts_inbound() {
    let (maze, nodes) = maze_with_alternative_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Unreachable,
        &PresetState::empty(),
        &mut rng,
    );

    assert!(
        result.is_some(),
        "must cut the inbound edge and land on Unreachable"
    );
    assert!(
        draft.maze.graph.edge_between(nodes[0], candidate).is_none(),
        "inbound edge must have been removed"
    );
}

/// 1x5 row: 0=start, 1=finish (edge 0->1), 2=candidate (singleton Unreachable, no inbound, but
/// ALREADY has a pre-existing outbound edge 2->1 into finish -- unreachable from start despite
/// already being able to reach finish, since nothing can get IN). Regression fixture: a naive
/// single inbound-bridge would make it reachable both ways -> Alternative, not Trap; the audit
/// step must cut this pre-existing outbound edge first since target=Trap doesn't need outbound.
fn maze_with_unreachable_candidate_holding_hidden_outbound()
-> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(5);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[2], nodes[1], EK::Basic); // pre-existing outbound edge to finish-reachable
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn convert_region_audits_away_a_hidden_outbound_edge_before_landing_on_trap() {
    let (maze, nodes) = maze_with_unreachable_candidate_holding_hidden_outbound();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let scc = maze.analysis.scc(&maze.graph);
    let classes_before = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    assert_eq!(
        classes_before
            .get(&scc.component_of(candidate).unwrap())
            .copied(),
        Some(RegionClass::Unreachable),
        "sanity: candidate must start Unreachable despite already reaching finish"
    );
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Trap,
        &PresetState::empty(),
        &mut rng,
    );

    assert!(
        result.is_some(),
        "audit must cut the hidden outbound edge before the inbound bridge, landing on Trap"
    );
    assert!(
        draft.maze.graph.edge_between(candidate, nodes[1]).is_none(),
        "hidden outbound edge must have been audited away"
    );
    assert!(
        draft.maze.graph.edge_between(nodes[1], candidate).is_some(),
        "inbound edge must have been added"
    );
    let classes_after =
        draft
            .maze
            .analysis
            .region_classes(&draft.maze.graph, &draft.maze.field, &draft.maze.meta);
    let scc_after = draft.maze.analysis.scc(&draft.maze.graph);
    assert_eq!(
        classes_after
            .get(&scc_after.component_of(candidate).unwrap())
            .copied(),
        Some(RegionClass::Trap)
    );
}

#[test]
fn convert_region_fails_when_audit_removal_is_preset_blocked() {
    let (maze, nodes) = maze_with_trap_candidate();
    let mid = nodes[1];
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((mid, candidate));
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Unreachable,
        &preset_state,
        &mut rng,
    );

    assert!(
        result.is_none(),
        "audit removal blocked by preset -- whole candidate must fail"
    );
    assert!(
        draft.maze.graph.edge_between(mid, candidate).is_some(),
        "preset-protected edge must remain untouched"
    );
}

#[test]
fn convert_region_fails_when_every_add_candidate_is_preset_blocked() {
    let (maze, nodes) = maze_with_isolated_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((nodes[1], candidate));
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Trap,
        &preset_state,
        &mut rng,
    );

    assert!(
        result.is_none(),
        "sole inbound candidate blocked -- conversion must fail"
    );
    assert!(
        draft.maze.graph.edge_between(nodes[1], candidate).is_none(),
        "no edge should have leaked in"
    );
}

#[test]
fn convert_region_no_op_when_already_the_target_class() {
    let (maze, nodes) = maze_with_isolated_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(
        &mut draft,
        &members,
        RegionClass::Unreachable,
        &PresetState::empty(),
        &mut rng,
    );

    assert_eq!(
        result,
        Some(members),
        "already Unreachable -- no-op commit must succeed without any mutation"
    );
    assert!(
        draft.maze.graph.edge_between(nodes[1], candidate).is_none(),
        "no edge should have been added for a no-op"
    );
}

#[test]
fn membership_matches_true_when_members_resolve_to_target_class() {
    let (maze, nodes) = maze_with_isolated_candidate();
    let members: HashSet<NodeId> = [nodes[2]].into_iter().collect();

    assert!(membership_matches(
        &maze,
        &members,
        RegionClass::Unreachable
    ));
    assert!(!membership_matches(&maze, &members, RegionClass::Trap));
}

#[test]
fn membership_matches_false_when_members_span_multiple_classes() {
    // start(0)/finish(1) are both Path; candidate(2) is Unreachable -- combining them into one
    // `members` set spans two different classes, so membership_matches must reject any target.
    let (maze, nodes) = maze_with_isolated_candidate();
    let members: HashSet<NodeId> = [nodes[0], nodes[2]].into_iter().collect();

    assert!(!membership_matches(&maze, &members, RegionClass::Path));
    assert!(!membership_matches(
        &maze,
        &members,
        RegionClass::Unreachable
    ));
}
