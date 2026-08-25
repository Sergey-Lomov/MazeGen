    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::IdGenerator;

    /// Two independent `w`x`h` floors, no cross-floor edges wired — callers add those themselves.
    fn make_two_level_field_and_graph(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph, LevelId, LevelId) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let level0 = field.single_level_id();
        let level1 = field.add_level(Field::new(square_rect(w, h), &mut ids).unwrap());
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph, level0, level1)
    }

    fn make_field_and_graph(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph)
    }

    fn node_at(field: &MultiLevelField<SquareTessellation>, x: i32, y: i32) -> NodeId {
        let level = field.single_level_id();
        field.node_at(level, SquarePoint { x, y }).unwrap()
    }

    fn node_at_level(field: &MultiLevelField<SquareTessellation>, level: LevelId, x: i32, y: i32) -> NodeId {
        field.node_at(level, SquarePoint { x, y }).unwrap()
    }

    #[test]
    fn compute_node_stats_empty_graph_no_edges_all_dead_ends() {
        let (field, graph) = make_field_and_graph(3, 1);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.dead_ends, 3);
        assert_eq!(stats.straight, 0);
        assert_eq!(stats.turns, 0);
        assert!(stats.junctions.is_empty());
        assert_eq!(stats.teleport_entries, 0);
    }

    #[test]
    fn compute_node_stats_teleport_entries_one_way() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.teleport_entries, 1, "only b is a teleport destination");
    }

    #[test]
    fn compute_node_stats_teleport_entries_two_way_counts_both_ends() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        graph.add_edge(b, a, EdgeKind::Teleport);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.teleport_entries, 2, "both a and b are destinations of a two-way teleport");
    }

    #[test]
    fn compute_node_stats_teleport_entries_dedups_multiple_incoming_to_same_node() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        let c = node_at(&field, 3, 0);
        graph.add_edge(a, c, EdgeKind::Teleport);
        graph.add_edge(b, c, EdgeKind::Teleport);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.teleport_entries, 1, "c counted once despite two incoming teleports");
    }

    #[test]
    fn compute_node_stats_counts_match_node_count() {
        let (field, mut graph) = make_field_and_graph(3, 2);
        let center = node_at(&field, 1, 0);
        let left = node_at(&field, 0, 0);
        let right = node_at(&field, 2, 0);
        let down = node_at(&field, 1, 1);
        graph.add_edge(center, left, EdgeKind::Basic);
        graph.add_edge(center, right, EdgeKind::Basic);
        graph.add_edge(center, down, EdgeKind::Basic);
        let stats = compute_node_stats(&graph, &field);
        let total = stats.dead_ends + stats.straight + stats.turns
            + stats.junctions.iter().map(|(_, c)| c).sum::<usize>();
        assert_eq!(total, graph.node_count());
    }

    #[test]
    fn compute_node_stats_counts_a_turn() {
        // Corner of a 2x2 grid: (1,0)'s two neighbors (0,0) and (1,1) form a right angle.
        let (field, mut graph) = make_field_and_graph(2, 2);
        let corner = node_at(&field, 1, 0);
        let left = node_at(&field, 0, 0);
        let down = node_at(&field, 1, 1);
        graph.add_bidirectional_edge(corner, left, EdgeKind::Basic);
        graph.add_bidirectional_edge(corner, down, EdgeKind::Basic);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.turns, 1);
    }

    #[test]
    fn compute_node_stats_junctions_grouped_and_sorted_by_degree() {
        // Two distinct junction degrees present: one 3-way, one 4-way.
        let (field, mut graph) = make_field_and_graph(3, 3);
        let three_way = node_at(&field, 0, 1); // edge node: up/down/right = 3 neighbors max
        graph.add_bidirectional_edge(three_way, node_at(&field, 0, 0), EdgeKind::Basic);
        graph.add_bidirectional_edge(three_way, node_at(&field, 0, 2), EdgeKind::Basic);
        graph.add_bidirectional_edge(three_way, node_at(&field, 1, 1), EdgeKind::Basic);

        let four_way = node_at(&field, 1, 1);
        graph.add_bidirectional_edge(four_way, node_at(&field, 0, 1), EdgeKind::Basic);
        graph.add_bidirectional_edge(four_way, node_at(&field, 2, 1), EdgeKind::Basic);
        graph.add_bidirectional_edge(four_way, node_at(&field, 1, 0), EdgeKind::Basic);
        graph.add_bidirectional_edge(four_way, node_at(&field, 1, 2), EdgeKind::Basic);

        let stats = compute_node_stats(&graph, &field);
        let degrees: Vec<usize> = stats.junctions.iter().map(|&(deg, _)| deg).collect();
        let mut sorted = degrees.clone();
        sorted.sort_unstable();
        assert_eq!(degrees, sorted, "junctions must be sorted by degree");
        assert!(degrees.contains(&3));
        assert!(degrees.contains(&4));
    }

    #[test]
    fn compute_spatial_edge_stats_no_edges_all_walls() {
        let (field, graph) = make_field_and_graph(2, 1);
        let stats = compute_spatial_edge_stats(&graph, &field);
        assert_eq!(stats.walls, 1, "single adjacent pair, no edges -> 1 wall");
        assert_eq!(stats.bidirectional, 0);
        assert_eq!(stats.one_way_passages, 0);
    }

    #[test]
    fn compute_spatial_edge_stats_bidirectional_edge() {
        let (field, mut graph) = make_field_and_graph(2, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Basic);
        graph.add_edge(b, a, EdgeKind::Basic);
        let stats = compute_spatial_edge_stats(&graph, &field);
        assert_eq!(stats.bidirectional, 1);
        assert_eq!(stats.walls, 0);
        assert_eq!(stats.one_way_passages, 0);
    }

    #[test]
    fn compute_spatial_edge_stats_one_way_edge() {
        let (field, mut graph) = make_field_and_graph(2, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Basic);
        let stats = compute_spatial_edge_stats(&graph, &field);
        assert_eq!(stats.one_way_passages, 1);
        assert_eq!(stats.bidirectional, 0);
        assert_eq!(stats.walls, 0);
    }

    #[test]
    fn compute_spatial_edge_stats_total_matches_adjacency_pair_count() {
        let (field, mut graph) = make_field_and_graph(3, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Basic);
        graph.add_edge(b, a, EdgeKind::Basic);
        // (1,0)-(2,0) stays a wall.
        let stats = compute_spatial_edge_stats(&graph, &field);
        assert_eq!(stats.total_pairs, 2, "3x1 field has 2 adjacent pairs");
        assert_eq!(stats.bidirectional + stats.one_way_passages + stats.walls, stats.total_pairs);
        assert_eq!(stats.bidirectional, 1);
        assert_eq!(stats.walls, 1);
    }

    #[test]
    fn adjacency_pairs_does_not_double_count_symmetric_neighbors() {
        let (field, graph) = make_field_and_graph(2, 1);
        let pairs = adjacency_pairs(&graph, &field, None);
        assert_eq!(pairs.len(), 1, "one adjacent pair, not counted twice from each direction");
    }

    #[test]
    fn compute_teleport_edge_stats_no_teleports() {
        let (_, graph) = make_field_and_graph(3, 1);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.two_way, 0);
        assert_eq!(stats.one_way, 0);
    }

    #[test]
    fn compute_teleport_edge_stats_two_way_pair() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        graph.add_edge(b, a, EdgeKind::Teleport);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.two_way, 1);
        assert_eq!(stats.one_way, 0);
    }

    #[test]
    fn compute_teleport_edge_stats_one_way_pair() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.one_way, 1);
        assert_eq!(stats.two_way, 0);
    }

    #[test]
    fn compute_teleport_edge_stats_ignores_basic_edges() {
        let (field, mut graph) = make_field_and_graph(2, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Basic);
        graph.add_edge(b, a, EdgeKind::Basic);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.two_way, 0);
        assert_eq!(stats.one_way, 0);
    }

    #[test]
    fn compute_teleport_edge_stats_counts_multiple_pairs() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        let c = node_at(&field, 2, 0);
        let d = node_at(&field, 3, 0);
        graph.add_edge(a, d, EdgeKind::Teleport);
        graph.add_edge(d, a, EdgeKind::Teleport);
        graph.add_edge(b, c, EdgeKind::Teleport);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.two_way, 1);
        assert_eq!(stats.one_way, 1);
    }

    #[test]
    fn compute_node_stats_scoped_counts_only_the_given_floor() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(3, 1);
        // level0: a-b-c chain (a and c are dead ends, b is straight).
        let a0 = node_at_level(&field, level0, 0, 0);
        let b0 = node_at_level(&field, level0, 1, 0);
        let c0 = node_at_level(&field, level0, 2, 0);
        graph.add_bidirectional_edge(a0, b0, EdgeKind::Basic);
        graph.add_bidirectional_edge(b0, c0, EdgeKind::Basic);
        // level1: left untouched, all 3 nodes stay dead ends.
        let stats0 = compute_node_stats_scoped(&graph, &field, Some(level0));
        assert_eq!(stats0.dead_ends, 2);
        assert_eq!(stats0.straight, 1);
        let stats1 = compute_node_stats_scoped(&graph, &field, Some(level1));
        assert_eq!(stats1.dead_ends, 3);
        assert_eq!(stats1.straight, 0);
    }

    #[test]
    fn compute_node_stats_scoped_teleport_entry_excluded_when_destination_on_other_floor() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b1 = node_at_level(&field, level1, 1, 0);
        graph.add_edge(a0, b1, EdgeKind::Teleport);
        let stats0 = compute_node_stats_scoped(&graph, &field, Some(level0));
        assert_eq!(stats0.teleport_entries, 0, "teleport destination is on level1, not level0");
        let stats1 = compute_node_stats_scoped(&graph, &field, Some(level1));
        assert_eq!(stats1.teleport_entries, 1, "b1 is the teleport's destination, on level1");
    }

    #[test]
    fn compute_spatial_edge_stats_scoped_counts_only_the_given_floor() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b0 = node_at_level(&field, level0, 1, 0);
        graph.add_edge(a0, b0, EdgeKind::Basic);
        graph.add_edge(b0, a0, EdgeKind::Basic);
        // level1's only adjacent pair stays a wall.
        let stats0 = compute_spatial_edge_stats_scoped(&graph, &field, Some(level0));
        assert_eq!(stats0.bidirectional, 1);
        assert_eq!(stats0.walls, 0);
        let stats1 = compute_spatial_edge_stats_scoped(&graph, &field, Some(level1));
        assert_eq!(stats1.bidirectional, 0);
        assert_eq!(stats1.walls, 1);
    }

    #[test]
    fn compute_teleport_edge_stats_scoped_counts_same_floor_teleport() {
        let (field, mut graph, level0, _level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b0 = node_at_level(&field, level0, 1, 0);
        graph.add_edge(a0, b0, EdgeKind::Teleport);
        graph.add_edge(b0, a0, EdgeKind::Teleport);
        let stats = compute_teleport_edge_stats_scoped(&graph, &field, level0);
        assert_eq!(stats.two_way, 1);
    }

    #[test]
    fn compute_teleport_edge_stats_scoped_excludes_cross_floor_teleport_from_both_floors() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b1 = node_at_level(&field, level1, 0, 0);
        graph.add_edge(a0, b1, EdgeKind::Teleport);
        graph.add_edge(b1, a0, EdgeKind::Teleport);
        let stats0 = compute_teleport_edge_stats_scoped(&graph, &field, level0);
        assert_eq!(stats0.two_way + stats0.one_way, 0, "cross-floor teleport must not count toward level0");
        let stats1 = compute_teleport_edge_stats_scoped(&graph, &field, level1);
        assert_eq!(stats1.two_way + stats1.one_way, 0, "cross-floor teleport must not count toward level1 either");
    }

    #[test]
    fn average_degree_empty_graph_is_zero() {
        let graph = Graph::new();
        assert_eq!(average_degree(&graph), 0.0);
    }

    #[test]
    fn average_degree_no_edges_is_zero() {
        let (_, graph) = make_field_and_graph(3, 1);
        assert_eq!(average_degree(&graph), 0.0);
    }

    #[test]
    fn average_degree_matches_hand_computed_value() {
        let (field, mut graph) = make_field_and_graph(3, 1);
        let left = node_at(&field, 0, 0);
        let mid = node_at(&field, 1, 0);
        let right = node_at(&field, 2, 0);
        graph.add_bidirectional_edge(left, mid, EdgeKind::Basic);
        graph.add_bidirectional_edge(mid, right, EdgeKind::Basic);
        // left: 1 neighbor, mid: 2 neighbors, right: 1 neighbor -> total 4 / 3 nodes.
        assert_eq!(average_degree(&graph), 4.0 / 3.0);
    }

    /// Three independent `w`x`h` floors, no cross-floor edges wired — callers add those
    /// themselves. Needed (over `make_two_level_field_and_graph`) for `Elevator` tests, which
    /// require 3+ floors to distinguish "one group across many floors" from "one group per pair".
    fn make_three_level_field_and_graph(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph, LevelId, LevelId, LevelId) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let level0 = field.single_level_id();
        let level1 = field.add_level(Field::new(square_rect(w, h), &mut ids).unwrap());
        let level2 = field.add_level(Field::new(square_rect(w, h), &mut ids).unwrap());
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph, level0, level1, level2)
    }

    #[test]
    fn compute_vertical_stats_no_vertical_edges_all_zero() {
        let (field, graph, _level0, _level1) = make_two_level_field_and_graph(2, 1);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.bidirectional_passages, 0);
        assert_eq!(stats.one_way_passages_up, 0);
        assert_eq!(stats.one_way_passages_down, 0);
        assert_eq!(stats.elevator_groups, 0);
        assert_eq!(stats.elevator_stop_count, 0);
        assert_eq!(stats.average_elevator_stops, 0.0);
        assert_eq!(stats.cross_floor_teleports, 0);
    }

    #[test]
    fn compute_vertical_stats_bidirectional_passage() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        graph.add_bidirectional_edge(a0, a1, EdgeKind::VerticalPassage);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.bidirectional_passages, 1);
        assert_eq!(stats.one_way_passages_up, 0);
        assert_eq!(stats.one_way_passages_down, 0);
    }

    #[test]
    fn compute_vertical_stats_one_way_up_and_down() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(3, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        graph.add_edge(a0, a1, EdgeKind::VerticalPassage); // level0 -> level1: up
        let b0 = node_at_level(&field, level0, 1, 0);
        let b1 = node_at_level(&field, level1, 1, 0);
        graph.add_edge(b1, b0, EdgeKind::VerticalPassage); // level1 -> level0: down
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.one_way_passages_up, 1);
        assert_eq!(stats.one_way_passages_down, 1);
        assert_eq!(stats.bidirectional_passages, 0);
    }

    #[test]
    fn compute_vertical_stats_elevator_counts_one_group_for_full_fan() {
        let (field, mut graph, level0, level1, level2) = make_three_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        let a2 = node_at_level(&field, level2, 0, 0);
        // Full fan across 3 floors at the same x-y point (mirrors `try_add_elevator_edge`'s
        // pairwise bidirectional wiring) -> one elevator group, not 3 edges' worth.
        for (x, y) in [(a0, a1), (a0, a2), (a1, a2)] {
            graph.add_bidirectional_edge(x, y, EdgeKind::Elevator);
        }
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.elevator_groups, 1);
        assert_eq!(stats.elevator_stop_count, 3, "one group spanning all 3 floors has 3 stops");
        assert_eq!(stats.average_elevator_stops, 3.0);
    }

    #[test]
    fn compute_vertical_stats_elevator_counts_distinct_points_separately() {
        let (field, mut graph, level0, level1, _level2) = make_three_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        let b0 = node_at_level(&field, level0, 1, 0);
        let b1 = node_at_level(&field, level1, 1, 0);
        graph.add_bidirectional_edge(a0, a1, EdgeKind::Elevator);
        graph.add_bidirectional_edge(b0, b1, EdgeKind::Elevator);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.elevator_groups, 2);
        assert_eq!(stats.elevator_stop_count, 4, "two 2-stop elevators");
        assert_eq!(stats.average_elevator_stops, 2.0);
    }

    #[test]
    fn compute_vertical_stats_elevator_same_point_disjoint_floor_sets_count_as_two_groups() {
        // 6-floor field: floors 0-2 form one elevator at (0,0), floors 3-5 form a separate
        // elevator at the same x-y point, with no edges connecting the two sets.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let levels: Vec<LevelId> = std::iter::once(field.single_level_id())
            .chain((1..6).map(|_| field.add_level(Field::new(square_rect(2, 1), &mut ids).unwrap())))
            .collect();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }

        let node_at_floor = |field: &MultiLevelField<SquareTessellation>, idx: usize| node_at_level(field, levels[idx], 0, 0);
        for (i, j) in [(0, 1), (0, 2), (1, 2)] {
            let (a, b) = (node_at_floor(&field, i), node_at_floor(&field, j));
            graph.add_bidirectional_edge(a, b, EdgeKind::Elevator);
        }
        for (i, j) in [(3, 4), (3, 5), (4, 5)] {
            let (a, b) = (node_at_floor(&field, i), node_at_floor(&field, j));
            graph.add_bidirectional_edge(a, b, EdgeKind::Elevator);
        }

        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.elevator_groups, 2, "same x-y point but disjoint floor sets are two separate elevators");
    }

    #[test]
    fn compute_elevator_stop_count_scoped_splits_by_floor() {
        let (field, mut graph, level0, level1, level2) = make_three_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        let a2 = node_at_level(&field, level2, 0, 0);
        for (x, y) in [(a0, a1), (a0, a2), (a1, a2)] {
            graph.add_bidirectional_edge(x, y, EdgeKind::Elevator);
        }
        let groups = graph.elevator_groups();
        assert_eq!(compute_elevator_stop_count_scoped(&groups, &field, level0), 1);
        assert_eq!(compute_elevator_stop_count_scoped(&groups, &field, level1), 1);
        assert_eq!(compute_elevator_stop_count_scoped(&groups, &field, level2), 1);
    }

    #[test]
    fn compute_elevator_stop_count_scoped_zero_when_no_elevator_on_floor() {
        let (field, graph, level0, _level1) = make_two_level_field_and_graph(2, 1);
        assert_eq!(compute_elevator_stop_count_scoped(&graph.elevator_groups(), &field, level0), 0);
    }

    #[test]
    fn compute_vertical_stats_cross_floor_teleport_counted_once_per_pair() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b1 = node_at_level(&field, level1, 1, 0);
        graph.add_edge(a0, b1, EdgeKind::Teleport);
        graph.add_edge(b1, a0, EdgeKind::Teleport);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.cross_floor_teleports, 1);
    }

    #[test]
    fn compute_vertical_stats_same_floor_teleport_excluded() {
        let (field, mut graph) = make_field_and_graph(2, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.cross_floor_teleports, 0);
    }
