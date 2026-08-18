/// Direct unit tests for `Maze::draft()` (GitHub issue #118, `Specs/repair.md`) — the working-copy
/// mechanism `DraftMaze` builds on. Had no direct coverage before, only exercised transitively via
/// `MissingRegionsStrategy`'s own tests.
mod draft_tests {
    use super::super::*;
    use crate::graph::EdgeKind;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};

    fn maze_n(n: usize) -> (Maze<SquareTessellation>, Vec<ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(n, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        let nodes: Vec<_> = field.all_node_ids().collect();
        for &node in &nodes { g.add_node(node); }
        (Maze::new(field, g), nodes)
    }

    #[test]
    fn draft_copies_graph_edges_and_meta() {
        let (mut maze, nodes) = maze_n(2);
        maze.graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[1]);

        let draft = maze.draft();
        assert!(draft.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert_eq!(draft.meta.start, Some(nodes[0]));
        assert_eq!(draft.meta.finish, Some(nodes[1]));
    }

    #[test]
    fn mutating_draft_graph_never_touches_the_original() {
        let (maze, nodes) = maze_n(2);
        let mut draft = maze.draft();
        draft.graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);

        assert!(draft.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none(),
            "mutating the draft's graph must never affect the original Maze");
    }

    #[test]
    fn mutating_original_after_draft_never_touches_the_draft() {
        let (mut maze, nodes) = maze_n(2);
        let draft = maze.draft();
        maze.graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);

        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(draft.graph.edge_between(nodes[0], nodes[1]).is_none(),
            "a draft taken before a later mutation on the original must not see that mutation");
    }

    #[test]
    fn draft_gets_a_fresh_analysis_cache_not_the_original_stale_one() {
        let (mut maze, nodes) = maze_n(2);
        maze.meta.start = Some(nodes[0]);
        // Populate the original's nav_graph cache before drafting.
        let _ = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        let mut draft = maze.draft();
        // Mutate the draft's graph directly (bypassing DraftMaze, to isolate draft()'s own
        // cache-freshness contract) — if the draft had inherited the original's cache keyed on the
        // pre-mutation graph version, nav_graph would wrongly reuse it instead of rebuilding.
        draft.graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        draft.meta.finish = Some(nodes[1]);

        let nav = draft.analysis.nav_graph(&draft.graph, &draft.meta);
        assert!(nav.nav_node_for(nodes[1]).is_some(),
            "draft's fresh analysis cache must reflect the draft's own graph, not stale/inherited state");
    }
}

/// GitHub issue #219 — `Maze` owns an `IdGenerator` built via `resume_after`, so `add_node_at`
/// never collides with a NodeId the field already held at construction time.
mod add_node_at_tests {
    use super::super::*;
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    #[test]
    fn add_node_at_yields_an_id_not_colliding_with_any_existing_node() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
        let mut g = Graph::new();
        let existing: Vec<ids::NodeId> = field.all_node_ids().collect();
        for &node in &existing { g.add_node(node); }

        let mut maze = Maze::new(field, g);
        let added = maze.add_node_at(SquarePoint { x: 1, y: 1 });

        assert!(!existing.contains(&added));
    }

    #[test]
    fn add_node_at_registers_the_new_node_in_the_graph() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 2), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }

        let mut maze = Maze::new(field, g);
        let added = maze.add_node_at(SquarePoint { x: 0, y: 0 });
        let level = maze.field.single_level_id();

        assert!(maze.graph.nodes().any(|n| n.id == added));
        assert!(maze.field.nodes_at(level, SquarePoint { x: 0, y: 0 }).contains(&added));
    }
}

/// GitHub issue #221 — `Maze::remove_node_at` has no caller in this codebase yet (see its doc
/// comment), covered here only by direct unit tests.
mod remove_node_at_tests {
    use super::super::*;
    use crate::graph::EdgeKind;
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    #[test]
    fn removes_the_node_and_clears_edges_in_both_directions_leaving_the_sibling_slot_intact() {
        let mut ids = IdGenerator::new();
        // A - B - C line, B split into b0/b1. Wire both b0<->A and b1<->C, then remove b1: its
        // edges must disappear while b0's stay untouched.
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze = Maze::new(field, g);
        let level = maze.field.single_level_id();

        let a = maze.field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b_point = SquarePoint { x: 1, y: 0 };
        let b0 = maze.field.node_at(level, b_point).unwrap();
        let c = maze.field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        let b1 = maze.add_node_at(b_point);

        maze.graph.add_bidirectional_edge(a, b0, EdgeKind::Basic);
        maze.graph.add_bidirectional_edge(b1, c, EdgeKind::Basic);

        maze.remove_node_at(b1);

        assert!(maze.graph.edge_between(a, b0).is_some(), "b0's own edge must survive");
        assert!(maze.graph.edge_between(b1, c).is_none());
        assert!(maze.graph.edge_between(c, b1).is_none());
        assert!(!maze.field.nodes_at(level, b_point).contains(&b1));
    }

    #[test]
    #[should_panic(expected = "cannot remove a point's last remaining node")]
    fn delegates_the_last_remaining_node_panic() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze = Maze::new(field, g);
        let level = maze.field.single_level_id();
        let p = SquarePoint { x: 0, y: 0 };
        let original = maze.field.node_at(level, p).unwrap();

        maze.remove_node_at(original);
    }

    #[test]
    fn removes_a_node_that_is_not_a_points_original_slot() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze = Maze::new(field, g);
        let p1 = SquarePoint { x: 1, y: 0 };
        let extra_at_p1 = maze.add_node_at(p1);

        // extra_at_p1 belongs to p1, not p0 — MultiLevelField::remove_node_at resolves the point
        // from the node itself, so removal always targets the node's real point; this test's
        // "wrong point" premise no longer applies to the node-id-only API (GitHub issue #334).
        // Kept as a regression check that remove_node_at still works correctly on a node that
        // isn't a point's original/last slot.
        maze.remove_node_at(extra_at_p1);
        assert!(maze.field.level_of(extra_at_p1).is_none());
    }
}

mod distance_cache_tests {
    use super::super::*;
    use crate::graph::EdgeKind;
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    fn line_maze(len: usize) -> (Maze<SquareTessellation>, Vec<ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let level = field.single_level_id();
        let nodes: Vec<ids::NodeId> = (0..len)
            .map(|x| field.node_at(level, SquarePoint { x: x as i32, y: 0 }).unwrap())
            .collect();
        for i in 0..len - 1 {
            g.add_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let maze = Maze::new(field, g);
        (maze, nodes)
    }

    #[test]
    fn distance_from_start_repeated_call_returns_same_result_without_graph_change() {
        let (mut maze, nodes) = line_maze(4);
        maze.meta.start = Some(nodes[0]);
        let first = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
        let second = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
        assert_eq!(first, second, "repeated call with unchanged graph/start must return identical map");
    }

    #[test]
    fn distance_from_start_invalidates_on_graph_mutation() {
        let (mut maze, nodes) = line_maze(4);
        maze.meta.start = Some(nodes[0]);
        let last_nav = maze.analysis.nav_graph(&maze.graph, &maze.meta).nav_node_for(nodes[3]).unwrap();
        let before = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
        assert_eq!(before.get(&last_nav), Some(&3));

        // Add a shortcut directly from start to the last node — cached entry for `nodes[3]`
        // must reflect the new shorter path, not the stale pre-mutation value.
        maze.graph.add_edge(nodes[0], nodes[3], EdgeKind::Basic);
        let after = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
        assert_eq!(after.get(&last_nav), Some(&1), "cache must invalidate after graph.version() changes");
    }

    #[test]
    fn distance_from_finish_invalidates_when_finish_moves() {
        let (mut maze, nodes) = line_maze(4);
        maze.meta.finish = Some(nodes[3]);
        let first_nav = maze.analysis.nav_graph(&maze.graph, &maze.meta).nav_node_for(nodes[0]).unwrap();
        let before = maze.analysis.distance_from_finish(&maze.graph, &maze.meta).unwrap();
        assert_eq!(before.get(&first_nav), Some(&3));

        // Moving finish to nodes[1] without touching the graph itself (same version) must
        // still bust the cache — keyed on finish, not just graph.version().
        maze.meta.finish = Some(nodes[1]);
        let after = maze.analysis.distance_from_finish(&maze.graph, &maze.meta).unwrap();
        assert_eq!(after.get(&first_nav), Some(&1));
    }

    #[test]
    fn region_classes_repeated_call_returns_same_result_without_graph_change() {
        let (mut maze, nodes) = line_maze(4);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[3]);
        let first = maze.analysis.region_classes(&maze.graph, &maze.field, &maze.meta);
        let second = maze.analysis.region_classes(&maze.graph, &maze.field, &maze.meta);
        assert_eq!(first, second, "repeated call with unchanged graph/start/finish must return identical map");
    }

    /// Directed line start(0) -> 1 -> 2 -> finish(3), each node its own SCC (one-way edges
    /// never merge into a single component the way `line_maze`'s bidirectional ones would).
    fn directed_line_maze(len: usize) -> (Maze<SquareTessellation>, Vec<ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let level = field.single_level_id();
        let nodes: Vec<ids::NodeId> = (0..len)
            .map(|x| field.node_at(level, SquarePoint { x: x as i32, y: 0 }).unwrap())
            .collect();
        for i in 0..len - 1 {
            g.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let maze = Maze::new(field, g);
        (maze, nodes)
    }

    #[test]
    fn region_classes_invalidates_on_graph_mutation() {
        let (mut maze, nodes) = directed_line_maze(4);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[3]);

        // Remove the one-way link into nodes[2] — nodes[2]/nodes[3] become unreachable from
        // start. nodes[3] is finish itself (always Path by definition), so check nodes[2].
        let cut = maze.graph.edge_between(nodes[1], nodes[2]).unwrap();
        maze.graph.remove_edge(cut);

        let scc = maze.analysis.scc(&maze.graph);
        let before = maze.analysis.region_classes(&maze.graph, &maze.field, &maze.meta);
        assert_eq!(before[&scc.component_of(nodes[2]).unwrap()], RegionClass::Unreachable);

        // Reconnect — cached entry for nodes[2]'s region must reflect the new reachability
        // (now on the start->finish route), not the stale pre-mutation value, since
        // graph.version() bumped.
        maze.graph.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let scc_after = maze.analysis.scc(&maze.graph);
        let after = maze.analysis.region_classes(&maze.graph, &maze.field, &maze.meta);
        assert_eq!(after[&scc_after.component_of(nodes[2]).unwrap()], RegionClass::Path, "cache must invalidate after graph.version() changes");
    }

    #[test]
    fn region_classes_invalidates_when_start_or_finish_changes() {
        let (mut maze, nodes) = directed_line_maze(4);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[3]);
        // Extra one-way branch off nodes[1] into a dead end — its own region, reachable from
        // start but never on the start->finish path regardless of which node is start.
        maze.graph.add_edge(nodes[1], nodes[3], EdgeKind::Basic);
        let scc = maze.analysis.scc(&maze.graph);

        // nodes[0] is start here, so its own region is Path by definition.
        let with_node0_as_start = maze.analysis.region_classes(&maze.graph, &maze.field, &maze.meta);
        assert_eq!(with_node0_as_start[&scc.component_of(nodes[0]).unwrap()], RegionClass::Path);

        // Same graph.version(), nodes[0] is no longer start — with no incoming edge into
        // nodes[0], it's unreachable from nodes[1]. Confirms the cache key includes start.
        let meta_with_node1_as_start = MazeMeta { start: Some(nodes[1]), finish: Some(nodes[3]), route_score: None };
        let with_node1_as_start = maze.analysis.region_classes(&maze.graph, &maze.field, &meta_with_node1_as_start);
        assert_eq!(with_node1_as_start[&scc.component_of(nodes[0]).unwrap()], RegionClass::Unreachable);
    }
}
