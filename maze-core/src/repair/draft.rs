use super::command::MutationCommand;
use crate::Maze;
use crate::generation::PresetState;
use crate::ids::{EdgeId, NodeId};
use crate::space::Tessellation;

/// Thin wrapper around a draft `Maze` (see `Maze::draft`) that records every mutation as a
/// `MutationCommand` at the moment it happens, via the same `try_*` helpers a strategy already
/// calls today — a strategy keeps calling mutation methods exactly as it does against a plain
/// `Maze`, just through `.maze` on this wrapper, and the command log falls out for free (no
/// manual parallel command list, no post-hoc graph diff). GitHub issue #118, `Specs/repair.md`.
///
/// **Nesting**: `DraftMaze` can wrap a `DraftMaze` — a strategy needing per-candidate rollback
/// inside a larger multi-step attempt (e.g. `MissingRegionsStrategy::try_reuse`) takes
/// `DraftMaze::new(outer.maze.draft())` for each candidate, tries it, and on failure simply drops
/// the inner `DraftMaze` (ordinary Rust drop, nothing to undo); on success, extends `outer`'s own
/// command log with `inner.into_commands()` and updates `outer.maze` to the inner draft's final
/// state so the next attempt in the same outer scope sees this one's committed effect.
///
/// **Maintenance rule**: every mutating helper in `generation::mod` that `MissingRegionsStrategy`
/// (the only consumer of `DraftMaze`) needs must get a mirrored method here in the same commit —
/// same rationale as `MutationCommand`'s own helper-correspondence rule. Deliberately not
/// code-generated (single consumer, small and slow-growing method count) — see `Specs/repair.md`.
pub struct DraftMaze<T: Tessellation> {
    pub maze: Maze<T>,
    commands: Vec<MutationCommand>,
}

impl<T: Tessellation> DraftMaze<T> {
    pub fn new(maze: Maze<T>) -> Self {
        Self {
            maze,
            commands: Vec::new(),
        }
    }

    /// Consumes `self`, returning the accumulated commands — called once an attempt this draft
    /// represents is committed by its caller (a successful region/candidate/seed).
    pub fn into_commands(self) -> Vec<MutationCommand> {
        self.commands
    }

    /// Commits a successful nested `DraftMaze` attempt into `self` (`DraftMaze` wraps
    /// `DraftMaze`, see this type's own doc comment): `self.maze` is replaced by `inner.maze`
    /// (which already reflects everything `self.maze` had, since `inner` was drafted from it,
    /// plus `inner`'s own successful mutations), and `inner`'s accumulated commands are appended
    /// to `self`'s own log — so the next attempt at `self`'s level sees this one's committed
    /// effect, same as the outermost level between regions/classes.
    pub fn absorb(&mut self, inner: DraftMaze<T>) {
        self.maze = inner.maze;
        self.commands.extend(inner.commands);
    }

    pub fn try_add_directed_edge(
        &mut self,
        from: NodeId,
        to: NodeId,
        preset_state: &PresetState,
    ) -> bool {
        let added =
            crate::generation::try_add_directed_edge(&mut self.maze.graph, from, to, preset_state);
        if added {
            self.commands
                .push(MutationCommand::AddDirectedEdge { from, to });
        }
        added
    }

    pub fn try_add_bidirectional_edge(
        &mut self,
        a: NodeId,
        b: NodeId,
        preset_state: &PresetState,
    ) -> bool {
        let added =
            crate::generation::try_add_bidirectional_edge(&mut self.maze.graph, a, b, preset_state);
        if added {
            self.commands
                .push(MutationCommand::AddBidirectionalEdge { a, b });
        }
        added
    }

    pub fn try_remove_edge(
        &mut self,
        from: NodeId,
        to: NodeId,
        preset_state: &PresetState,
    ) -> bool {
        let removed =
            crate::generation::try_remove_edge(&mut self.maze.graph, from, to, preset_state);
        if removed {
            self.commands
                .push(MutationCommand::RemoveEdgeBetween { from, to });
        }
        removed
    }

    pub fn try_remove_edge_by_id(&mut self, id: EdgeId, preset_state: &PresetState) -> bool {
        let removed =
            crate::generation::try_remove_edge_by_id(&mut self.maze.graph, id, preset_state);
        if removed {
            self.commands.push(MutationCommand::RemoveEdge { id });
        }
        removed
    }
}

/// Direct unit tests for `DraftMaze` (GitHub issue #118, `Specs/repair.md`) — the auto-tracking
/// mechanism itself, independent of `MissingRegionsStrategy` (its only real consumer): each
/// mutating method both mutates `self.maze` for real and records the matching `MutationCommand`,
/// a failed attempt records nothing, and `absorb` correctly folds a nested draft's state and
/// command log into the outer one.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{EdgeKind, Graph};
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};

    fn maze_n(n: usize) -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = crate::IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(n, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        (Maze::new(field, g), nodes)
    }

    #[test]
    fn new_starts_with_no_commands() {
        let (maze, _) = maze_n(2);
        let draft = DraftMaze::new(maze);
        assert!(draft.into_commands().is_empty());
    }

    #[test]
    fn try_add_directed_edge_mutates_and_records() {
        let (maze, nodes) = maze_n(2);
        let mut draft = DraftMaze::new(maze);
        assert!(draft.try_add_directed_edge(nodes[0], nodes[1], &PresetState::empty()));
        assert!(draft.maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert_eq!(
            draft.into_commands(),
            vec![MutationCommand::AddDirectedEdge {
                from: nodes[0],
                to: nodes[1]
            }]
        );
    }

    #[test]
    fn try_add_directed_edge_failure_records_nothing() {
        let (maze, nodes) = maze_n(2);
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(nodes[0]);
        let mut draft = DraftMaze::new(maze);
        assert!(!draft.try_add_directed_edge(nodes[0], nodes[1], &preset_state));
        assert!(draft.into_commands().is_empty());
    }

    #[test]
    fn try_add_bidirectional_edge_mutates_and_records() {
        let (maze, nodes) = maze_n(2);
        let mut draft = DraftMaze::new(maze);
        assert!(draft.try_add_bidirectional_edge(nodes[0], nodes[1], &PresetState::empty()));
        assert!(draft.maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(draft.maze.graph.edge_between(nodes[1], nodes[0]).is_some());
        assert_eq!(
            draft.into_commands(),
            vec![MutationCommand::AddBidirectionalEdge {
                a: nodes[0],
                b: nodes[1]
            }]
        );
    }

    #[test]
    fn try_remove_edge_mutates_and_records() {
        let (mut maze, nodes) = maze_n(2);
        maze.graph
            .build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut draft = DraftMaze::new(maze);
        assert!(draft.try_remove_edge(nodes[0], nodes[1], &PresetState::empty()));
        assert!(draft.maze.graph.edge_between(nodes[0], nodes[1]).is_none());
        assert_eq!(
            draft.into_commands(),
            vec![MutationCommand::RemoveEdgeBetween {
                from: nodes[0],
                to: nodes[1]
            }]
        );
    }

    #[test]
    fn try_remove_edge_by_id_mutates_and_records() {
        let (mut maze, nodes) = maze_n(2);
        let id = maze
            .graph
            .build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut draft = DraftMaze::new(maze);
        assert!(draft.try_remove_edge_by_id(id, &PresetState::empty()));
        assert!(draft.maze.graph.edge(id).is_none());
        assert_eq!(
            draft.into_commands(),
            vec![MutationCommand::RemoveEdge { id }]
        );
    }

    #[test]
    fn try_remove_edge_by_id_failure_records_nothing() {
        let (mut maze, nodes) = maze_n(2);
        let id = maze
            .graph
            .build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[1]));
        let mut draft = DraftMaze::new(maze);
        assert!(!draft.try_remove_edge_by_id(id, &preset_state));
        assert!(
            draft.maze.graph.edge(id).is_some(),
            "preset-protected edge must survive"
        );
        assert!(draft.into_commands().is_empty());
    }

    #[test]
    fn multiple_mutations_accumulate_commands_in_call_order() {
        let (mut maze, nodes) = maze_n(3);
        let id = maze
            .graph
            .build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let mut draft = DraftMaze::new(maze);
        draft.try_add_directed_edge(nodes[0], nodes[1], &PresetState::empty());
        draft.try_remove_edge_by_id(id, &PresetState::empty());
        assert_eq!(
            draft.into_commands(),
            vec![
                MutationCommand::AddDirectedEdge {
                    from: nodes[0],
                    to: nodes[1]
                },
                MutationCommand::RemoveEdge { id },
            ]
        );
    }

    #[test]
    fn absorb_folds_inner_state_and_commands_into_outer() {
        let (maze, nodes) = maze_n(3);
        let mut outer = DraftMaze::new(maze);
        outer.try_add_directed_edge(nodes[0], nodes[1], &PresetState::empty());

        // Nested draft, seeded from outer's current (already-mutated) state — mirrors
        // MissingRegionsStrategy's per-candidate rollback pattern.
        let mut inner = DraftMaze::new(outer.maze.draft());
        inner.try_add_directed_edge(nodes[1], nodes[2], &PresetState::empty());

        outer.absorb(inner);

        // outer.maze must now reflect both mutations (its own, plus inner's).
        assert!(outer.maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(outer.maze.graph.edge_between(nodes[1], nodes[2]).is_some());
        // Commands from both levels appear in order: outer's own first, then inner's.
        assert_eq!(
            outer.into_commands(),
            vec![
                MutationCommand::AddDirectedEdge {
                    from: nodes[0],
                    to: nodes[1]
                },
                MutationCommand::AddDirectedEdge {
                    from: nodes[1],
                    to: nodes[2]
                },
            ]
        );
    }

    #[test]
    fn dropping_a_failed_inner_draft_leaves_outer_untouched() {
        let (maze, nodes) = maze_n(2);
        let mut outer = DraftMaze::new(maze);
        outer.try_add_directed_edge(nodes[0], nodes[1], &PresetState::empty());

        {
            // A candidate attempt that fails — inner is simply dropped, never absorbed.
            let mut inner = DraftMaze::new(outer.maze.draft());
            let mut preset_state = PresetState::empty();
            preset_state.locked_out.insert(nodes[1]);
            assert!(!inner.try_add_directed_edge(nodes[1], nodes[0], &preset_state));
            // inner drops here — ordinary Rust drop, nothing to undo.
        }

        assert_eq!(
            outer.into_commands(),
            vec![MutationCommand::AddDirectedEdge {
                from: nodes[0],
                to: nodes[1]
            }],
            "a dropped failed inner draft must leave no trace on the outer draft's command log"
        );
    }
}
