    use super::*;
    use std::collections::HashMap;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, MultiLevelField};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy), None)
    }

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(side, side), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingTeleportsIssue {
        let entries = if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] };
        MissingTeleportsIssue::new_from_check("min_teleport_count", entries)
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = maze_grid(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_adds_teleport_edges_on_a_grid() {
        let mut maze = maze_grid(5);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().all(|e| e.kind == EdgeKind::Teleport));
        assert!(maze.graph.edges().count() > 0);
    }

    #[test]
    fn apply_fails_on_single_node_field() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn reserve_percent_override_changes_target_teleport_count() {
        let mut maze = maze_grid(5);
        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("one_way_chance".to_string(), "100".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 missing * (1 + 0%) = 2 teleports, one_way_chance=100% => one directed edge each.
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn one_way_chance_zero_always_adds_the_reverse_edge() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(1);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("one_way_chance".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 2, "one_way_chance=0 must add both directions of the single teleport");
        for edge in maze.graph.edges() {
            assert!(maze.graph.edge_between(edge.to, edge.from).is_some(), "every added edge must have its reverse");
        }
    }

    #[test]
    fn desired_length_interval_restricts_the_exit_distance() {
        // 1x10 corridor: entry fixed at node 0 via a deterministic seed choice is fragile, so
        // instead assert on distance directly -- with min=max=3, any accepted teleport not
        // falling back to set 3/1 must land exactly 3 tile-hops from its entry.
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        for i in 0..9 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("desired_length".to_string(), "3,3".to_string());
        overrides.insert("allow_out_of_interval".to_string(), "false".to_string());
        overrides.insert("unreachable_priority".to_string(), "forbidden".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(3);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
        let dist = bfs_distances(&maze, teleport.from);
        // Since the graph was already fully connected before the teleport was added, entry can
        // reach everything -- so unreachable_priority=forbidden always routes through the interval set,
        // never the unreachable/out-of-interval fallback branches.
        let dist_before_teleport = dist.get(&teleport.to).copied();
        assert!(dist_before_teleport.is_some());
    }

    #[test]
    fn one_way_chance_zero_falls_back_to_directed_when_reverse_is_preset_blocked() {
        // Every ordered pair (a, b) with a > b is blocked -- i.e. only the "ascending" direction
        // of any pair is ever open. one_way_chance=0 always *wants* the reverse, but whichever
        // (entry, exit) pair gets picked, the reverse (exit, entry) is always the descending,
        // blocked direction -- pick_exit's caller must downgrade to a directed-only teleport
        // instead of proposing an AddBidirectionalTeleport that would be silently dropped whole
        // by apply_commands' preset revalidation.
        let mut maze = maze_grid(5);
        let all_nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
        let mut preset_state = PresetState::empty();
        for &a in &all_nodes {
            for &b in &all_nodes {
                if a > b {
                    preset_state.blocked.insert((a, b));
                }
            }
        }

        let issue = missing_issue(1);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("one_way_chance".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &preset_state, &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 1, "reverse must be dropped, not silently discarded as a whole bidirectional command");
    }

    #[test]
    fn attempts_limit_failure_on_one_slot_does_not_abort_remaining_slots() {
        // 2 teleports needed, attempts_limit=1: force the very first random pick to be
        // infeasible (both directions blocked) so slot #1 always burns its one attempt and
        // fails, while slot #2 still gets a real chance at whatever the pool has left. Every
        // node's outgoing edges are blocked so the FIRST candidate the RNG draws deterministically
        // fails -- but only one node is blocked this way, so eviction guarantees progress.
        let mut maze = maze_grid(5);
        let all_nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
        let mut preset_state = PresetState::empty();
        // Lock every node's outgoing edges except the very last -- whichever the RNG draws first
        // among the locked ones fails immediately (pick_exit returns None since no exit is
        // directed_edge_feasible from a locked_out entry), forcing at least one slot to burn its
        // single attempt before a workable entry is found.
        for &n in &all_nodes[..all_nodes.len() - 1] {
            preset_state.locked_out.insert(n);
        }

        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("attempts_limit".to_string(), "1".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(2);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &preset_state, &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // Both target teleports must land, not just the first -- a weaker `> 0` check would
        // still pass under the pre-fix `break 'slots` behavior if slot #1 happened to succeed
        // before ever exhausting its attempts_limit budget, without actually proving the fix
        // (a failed slot no longer aborts every slot after it).
        let teleport_count = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
        assert_eq!(teleport_count, 2, "both teleport slots must succeed despite earlier attempts_limit exhaustion on locked-out candidates");
    }

    #[test]
    fn apply_restricts_entry_to_the_named_level_but_allows_any_exit() {
        // Two disjoint 4x4 levels, no connections between them at all. The deficit is reported
        // only for level_b -- every added teleport's entry must be on level_b, but its exit is
        // free to land on either level (a teleport can legitimately cross floors).
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
        let level_b = mf.add_level(field_b);
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);

        let issue = MissingTeleportsIssue::new_from_check("min_teleport_count", vec![(RepairArea::Level(level_b), 2)]);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().count() > 0);
        // A bidirectional teleport mints edges in both directions, so a plain `edge.from` check
        // would wrongly flag the reverse (exit -> entry) edge. Each teleport's node *pair* must
        // still include the reported level on one side (the entry), regardless of edge direction.
        for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
            let from_level = maze.field.level_of(edge.from);
            let to_level = maze.field.level_of(edge.to);
            assert!(
                from_level == Some(level_b) || to_level == Some(level_b),
                "every teleport must have its entry on the reported level"
            );
        }
    }

    #[test]
    fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
        // GitHub issue #369 follow-up: per-floor + whole-maze entries on the same rule must not
        // stack — 1 per floor on 3 floors + 3 whole-maze must add 3 teleports total, not 6.
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let field_c = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
        let level_b = mf.add_level(field_b);
        let level_c = mf.add_level(field_c);
        let level_a = mf.levels_ordered().next().unwrap();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);

        let issue = MissingTeleportsIssue::new_from_check("min_teleport_count", vec![
            (RepairArea::Level(level_a), 1),
            (RepairArea::Level(level_b), 1),
            (RepairArea::Level(level_c), 1),
            (RepairArea::WholeMaze, 3),
        ]);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(11);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let teleport_count = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
        assert!(teleport_count <= 6, "at most 3 teleports (each possibly bidirectional -> 2 edges), not 6+3=9 or worse");
        // Count distinct (entry, exit) pairs regardless of direction to get the actual teleport count.
        let mut pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
        for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
            let key = if edge.from <= edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
            pairs.insert(key);
        }
        assert_eq!(pairs.len(), 3, "3 distinct teleports total, not 6");
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = maze_grid(5);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let mut maze_b = maze_grid(5);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }

    #[test]
    fn apply_does_not_duplicate_an_existing_edge_between_the_same_pair() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        g.build_initial_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        // Only pair on a 1x2 field is already connected both ways -- nothing new can be added.
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn entry_pick_farthest_from_random_places_entry_at_the_far_end_of_a_directed_chain() {
        // Directed chain 0->1->2->3->4 (one-way only): farthest_from_random must hop from
        // whichever random node the pool offers to the farthest node forward-reachable from it.
        // Every node in 0..=3 forward-reaches node 4 (the chain's own direction), and node 4
        // itself has nothing forward-reachable so `farthest_from` falls back to itself (also 4)
        // -- so on this particular chain shape, farthest_from_random resolves to node 4
        // regardless of which candidate the pool's random pick offers, which is exactly what
        // distinguishes this mode from plain `random` (whose entry would vary with the pick).
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        for i in 0..4 {
            g.build_initial_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("entry_pick".to_string(), "farthest_from_random".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
        assert_eq!(teleport.from, nodes[4], "farthest_from_random must resolve entry to node 4 -- the farthest-forward-reachable node from any candidate on this directed chain, including itself");
    }

    #[test]
    fn entry_pick_farthest_from_random_resolves_a_corridor_interior_candidate() {
        // 1x5 *bidirectional* corridor: every node has in-degree 2 / out-degree 2, so nodes 1..=3
        // are corridor-interior nav nodes (see `is_corridor_node`) -- only nodes 0 and 4 (the dead
        // ends) are nav nodes proper. The candidate pool is every maze node, so most picks land on
        // a corridor-interior node, which `NavGraph::nav_node_for` cannot resolve directly. Before
        // the `corridor_index` fallback, `farthest_from_via_nav` returned such a candidate
        // unchanged instead of hopping to a dead end -- this pins the fix.
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        for i in 0..4 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("entry_pick".to_string(), "farthest_from_random".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        // attempts_limit=1 so the very first random pick decides the outcome -- no retry can mask
        // a wrong resolution by eventually landing on a dead end by chance.
        overrides.insert("attempts_limit".to_string(), "1".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        // Seed chosen so the pool's first random pick lands on a corridor-interior node
        // (verified by sweeping seeds against the pre-fix code, where this seed was the first to
        // fail -- i.e. to resolve entry to something other than a dead end).
        let mut rng = MazeRng::seed_from_u64(0);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
        assert!(
            teleport.from == nodes[0] || teleport.from == nodes[4],
            "farthest_from_random must resolve entry to a dead end (node 0 or 4) even when the random candidate is a corridor-interior node, got {:?}",
            teleport.from,
        );
    }

    #[test]
    fn allow_out_of_interval_falls_back_to_an_out_of_range_exit_when_nothing_else_qualifies() {
        // 1x5 corridor, desired_length pinned to an interval no node can ever satisfy (min=max=99
        // on a graph whose farthest possible tile-hop distance is 4) and unreachable_priority=forbidden
        // on a single connected component (so the unreachable set is always empty too) -- the
        // only way apply() can still succeed is by falling through to set 1 (out_of_interval),
        // which requires allow_out_of_interval=true.
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        for i in 0..4 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("desired_length".to_string(), "99,99".to_string());
        overrides.insert("allow_out_of_interval".to_string(), "true".to_string());
        overrides.insert("unreachable_priority".to_string(), "forbidden".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }), "must succeed via the out_of_interval fallback since nothing satisfies the impossible interval or the (empty) unreachable set");
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
    }

    #[test]
    fn allow_out_of_interval_false_fails_when_nothing_satisfies_the_interval() {
        // Same impossible-interval setup as the fallback test above, but with
        // allow_out_of_interval=false: set 1 is never offered, and with a single connected
        // component the unreachable set is always empty too, so every entry attempt must fail.
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        for i in 0..4 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("desired_length".to_string(), "99,99".to_string());
        overrides.insert("allow_out_of_interval".to_string(), "false".to_string());
        overrides.insert("unreachable_priority".to_string(), "forbidden".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "no exit can ever satisfy the interval and out-of-interval picks are disallowed");
        assert!(maze.graph.edges().all(|e| e.kind != EdgeKind::Teleport), "no teleport must have been added");
    }

    #[test]
    fn unreachable_priority_bridges_a_separate_strongly_connected_component() {
        // Two disjoint 1x3 corridors (component A: nodes 0-2, component B: nodes 3-5), no edges
        // between them at all -- this is exactly the scenario MissingTeleportsStrategy's own doc
        // comment describes as its purpose (bridging separate SCCs). unreachable_priority=required
        // forces every pick_exit call to always try the unreachable set first; since it's never
        // empty here (the other component's 3 nodes are always unreachable from any entry), the
        // resulting teleport must land on a node in the OTHER component from its entry.
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        for i in 0..2 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        for i in 3..5 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut overrides = HashMap::new();
        overrides.insert("unreachable_priority".to_string(), "required".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
        let component_a: HashSet<NodeId> = [nodes[0], nodes[1], nodes[2]].into_iter().collect();
        let component_b: HashSet<NodeId> = [nodes[3], nodes[4], nodes[5]].into_iter().collect();
        let from_in_a = component_a.contains(&teleport.from);
        let to_in_b = component_b.contains(&teleport.to);
        let from_in_b = component_b.contains(&teleport.from);
        let to_in_a = component_a.contains(&teleport.to);
        assert!((from_in_a && to_in_b) || (from_in_b && to_in_a), "teleport must cross between the two separate components, not land within the entry's own component");
    }

    #[test]
    fn unreachable_priority_preferred_falls_back_to_in_interval_when_unreachable_is_empty() {
        // Fully-connected grid -- every node is BFS-reachable from any entry, so the "unreachable"
        // set `PriorityLevel::Preferred` favors is always empty and `pick_exit` must fall back to
        // the "in_interval" set on every attempt, exercising `order_zones`'s `[preferred, other]`
        // fallback ordering end-to-end (only unit-tested in isolation in `params.rs` otherwise).
        let mut maze = maze_grid(5);
        let mut overrides = HashMap::new();
        overrides.insert("unreachable_priority".to_string(), "preferred".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );

        let issue = missing_issue(3);
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }), "must succeed via the in_interval fallback, since no node is ever unreachable on a fully-connected grid");
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
    }

    fn two_level_maze() -> (Maze<SquareTessellation>, crate::space::LevelId, crate::space::LevelId) {
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
        let level_a = mf.levels_ordered().next().unwrap();
        let level_b = mf.add_level(field_b);
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        (Maze::new(mf, g), level_a, level_b)
    }

    #[test]
    fn cross_floor_mode_forbidden_never_crosses_floors() {
        let (mut maze, level_a, level_b) = two_level_maze();
        let issue = MissingTeleportsIssue::new_from_check("min_teleport_count", vec![(RepairArea::WholeMaze, 10)]);
        let mut overrides = HashMap::new();
        overrides.insert("cross_floor_mode".to_string(), "forbidden".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(9);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
        for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
            let from_level = maze.field.level_of(edge.from);
            let to_level = maze.field.level_of(edge.to);
            assert_eq!(from_level, to_level, "forbidden mode must never place a teleport across floors");
            assert!(from_level == Some(level_a) || from_level == Some(level_b));
        }
    }

    #[test]
    fn cross_floor_mode_manual_balance_zero_behaves_like_forbidden() {
        let (mut maze, _level_a, _level_b) = two_level_maze();
        let issue = MissingTeleportsIssue::new_from_check("min_teleport_count", vec![(RepairArea::WholeMaze, 10)]);
        let mut overrides = HashMap::new();
        overrides.insert("cross_floor_mode".to_string(), "manual".to_string());
        overrides.insert("cross_floor_balance".to_string(), "0".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(13);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
        for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
            assert_eq!(maze.field.level_of(edge.from), maze.field.level_of(edge.to), "balance=0 must behave as a hard same-floor-only preference, never falling back cross-floor");
        }
    }

    #[test]
    fn cross_floor_mode_manual_balance_one_always_crosses_floors() {
        let (mut maze, _level_a, _level_b) = two_level_maze();
        let issue = MissingTeleportsIssue::new_from_check("min_teleport_count", vec![(RepairArea::WholeMaze, 10)]);
        let mut overrides = HashMap::new();
        overrides.insert("cross_floor_mode".to_string(), "manual".to_string());
        overrides.insert("cross_floor_balance".to_string(), "1".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(17);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
        for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
            assert_ne!(maze.field.level_of(edge.from), maze.field.level_of(edge.to), "balance=1 must behave as a hard other-floor-only preference, never falling back same-floor");
        }
    }

    #[test]
    fn cross_floor_mode_natural_ignores_floor_entirely() {
        // Not a strict behavioral assertion beyond "it still works" -- natural is the pre-existing
        // default behavior (floor never consulted), this just pins that the new param plumbing
        // doesn't accidentally change it.
        let (mut maze, _level_a, _level_b) = two_level_maze();
        let issue = MissingTeleportsIssue::new_from_check("min_teleport_count", vec![(RepairArea::WholeMaze, 4)]);
        let mut overrides = HashMap::new();
        overrides.insert("cross_floor_mode".to_string(), "natural".to_string());
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&MissingTeleportsStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(21);
        let result = apply_and_commit(&MissingTeleportsStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
    }
