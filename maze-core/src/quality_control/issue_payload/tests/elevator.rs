use super::*;

fn elevator_graph() -> (Graph, ElevatorNodes) {
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    graph.add_edge(1, 2, EdgeKind::Elevator);
    graph.add_edge(2, 1, EdgeKind::Elevator);
    graph.add_edge(1, 3, EdgeKind::Elevator);
    graph.add_edge(3, 1, EdgeKind::Elevator);
    graph.add_edge(2, 3, EdgeKind::Elevator);
    graph.add_edge(3, 2, EdgeKind::Elevator);
    (graph, ElevatorNodes::new(vec![1, 2, 3]))
}

#[test]
fn invalid_elevator_issue_resolves_flagged_elevator_as_its_full_edge_fan() {
    let (graph, elevator) = elevator_graph();
    let scc = empty_scc();
    let issue = InvalidElevatorIssue::new_from_check("elevator_stop_count", vec![elevator]);

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidElevator { groups } = payload);
    assert_eq!(groups.len(), 1);
    let check_groups = &groups["elevator_stop_count"];
    assert_eq!(check_groups.len(), 1);
    let mut edges = check_groups[0].edges.clone();
    edges.sort();
    assert_eq!(edges, vec![[1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2]]);
}

#[test]
fn invalid_elevator_group_issue_resolves_each_flagged_elevator_as_its_own_edge_fan() {
    // Whole-maze scope group issue (GitHub issue #398) -- unlike the edge-based group kinds
    // (one-way/teleport/vertical-passage), an elevator group's `Vec<ElevatorNodes>` still
    // resolves to one payload entry per flagged elevator, mirroring `resolve_invalid_elevator_payload`.
    let (graph, elevator) = elevator_graph();
    let scc = empty_scc();
    let issue =
        InvalidElevatorGroupIssue::new_from_check("max_elevator_count", vec![(vec![elevator], 1)]);

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidElevator { groups } = payload);
    assert_eq!(groups.len(), 1);
    let check_groups = &groups["max_elevator_count"];
    assert_eq!(check_groups.len(), 1);
    let mut edges = check_groups[0].edges.clone();
    edges.sort();
    assert_eq!(edges, vec![[1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2]]);
}

#[test]
fn invalid_elevator_group_issue_preset_locked_when_every_edge_is_preset_protected() {
    let (graph, elevator) = elevator_graph();
    let scc = empty_scc();
    let issue = InvalidElevatorGroupIssue::new_from_check(
        "max_elevator_density",
        vec![(vec![elevator], 1)],
    );

    let preset_state = preset_with_edges(&[(1, 2), (2, 1), (1, 3), (3, 1), (2, 3), (3, 2)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidElevator { groups } = payload);
    assert!(groups["max_elevator_density"][0].preset_locked);
}

#[test]
fn invalid_elevator_stop_issue_resolves_each_flagged_stop_as_its_own_single_node_region() {
    let (graph, _elevator) = elevator_graph();
    let scc = empty_scc();
    let issue = InvalidElevatorStopIssue::new_from_check("max_elevator_stops", vec![1, 2]);

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidElevatorStop { nodes } = payload);
    assert_eq!(nodes.len(), 1);
    let check_regions = &nodes["max_elevator_stops"];
    let mut regions: Vec<Vec<u32>> = check_regions.iter().map(|r| r.region.clone()).collect();
    regions.sort();
    assert_eq!(
        regions,
        vec![vec![1], vec![2]],
        "each flagged stop must be its own single-node region, not one merged region"
    );
}

#[test]
fn invalid_elevator_stop_issue_preset_locked_when_stop_touches_a_preset_edge() {
    let (graph, _elevator) = elevator_graph();
    let scc = empty_scc();
    let issue = InvalidElevatorStopIssue::new_from_check("max_elevator_stops", vec![1]);

    let preset_state = preset_with_edges(&[(1, 2)]);
    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidElevatorStop { nodes } = payload);
    assert!(nodes["max_elevator_stops"][0].preset_locked);
}

#[test]
fn invalid_elevator_stop_group_issue_resolves_each_stop_in_the_group_as_its_own_region() {
    let (graph, _elevator) = elevator_graph();
    let scc = empty_scc();
    let issue = InvalidElevatorStopGroupIssue::new_from_check(
        "max_elevator_stops_per_floor",
        vec![(vec![1, 2, 3], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidElevatorStop { nodes } = payload);
    let check_regions = &nodes["max_elevator_stops_per_floor"];
    let mut regions: Vec<Vec<u32>> = check_regions.iter().map(|r| r.region.clone()).collect();
    regions.sort();
    assert_eq!(
        regions,
        vec![vec![1], vec![2], vec![3]],
        "every stop in the group must be emitted as its own single-node region"
    );
}

#[test]
fn invalid_elevator_stop_group_issue_preset_locked_when_stop_touches_a_preset_edge() {
    let (graph, _elevator) = elevator_graph();
    let scc = empty_scc();
    let issue =
        InvalidElevatorStopGroupIssue::new_from_check("max_elevator_stops", vec![(vec![1, 2], 1)]);

    let preset_state = preset_with_edges(&[(1, 2)]);
    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidElevatorStop { nodes } = payload);
    let check_regions = &nodes["max_elevator_stops"];
    let locked: HashMap<u32, bool> = check_regions
        .iter()
        .map(|r| (r.region[0], r.preset_locked))
        .collect();
    assert!(
        locked[&1],
        "stop 1 touches the preset edge (1,2), must be locked"
    );
    assert!(
        locked[&2],
        "stop 2 also touches the preset edge (1,2), must be locked"
    );
}

#[test]
fn invalid_dead_end_group_resolves_every_candidate_as_an_unlocked_single_node_region() {
    let (graph, scc) = empty_graph_and_scc();
    let issue =
        InvalidDeadEndGroupIssue::new_from_check("max_dead_end_count", vec![(vec![3, 1], 1)]);

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidDeadEnd { nodes } = payload);
    assert_eq!(
        nodes["max_dead_end_count"],
        vec![
            IssueRegionPayload {
                region: vec![3],
                preset_locked: false
            },
            IssueRegionPayload {
                region: vec![1],
                preset_locked: false
            },
        ]
    );
}
