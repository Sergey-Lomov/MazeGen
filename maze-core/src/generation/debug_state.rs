// Ledger of every node that ever existed during a debug-instrumented run, including ones later
// removed or replaced (`MutationCommand::RemoveNode`/`ReplacePointNodes`) — GitHub issue #271.
// Lives outside `Field` deliberately: `Field` must forget a removed node's point (`cell_of`/
// `neighbors` correctness depends on it), so this is a separate, append-only record.
//
// **Minting invariant**: the only sanctioned way to learn a freshly minted `NodeId` in the
// runtime pipeline is to call `.note(id, point)` immediately alongside `field.add_node_at(field_level, ...)`.
// Every runtime call site that mints a node is required to pair it with a `.note()` call in the
// same diff — exhaustive list (see `Specs/event_log.md`'s #271 section):
//   - `generation::preset_state::apply_split_points` (preset split points, all algorithms)
//   - `generation::split_logic::mint_split_nodes` (pattern-mode split, `CustomVertexBased` only)
//   - `generation::node_ops::try_replace_point_nodes` (QC repair mint)
//
// **Removal invariant**: a node removed by `RemoveNode`/`ReplacePointNodes` may never have been
// minted mid-run at all — it can be one of `Field`'s own original base nodes, whose coordinates
// otherwise exist nowhere once it's gone from both `Field` and the final snapshot. Every runtime
// call site that removes/replaces a node is required to `.note(id, point)` its coordinates
// *before* the removal (`field.cell_of` still resolves it) in the same diff:
//   - `quality_control::rule::apply_commands` (`RemoveNode`/`ReplacePointNodes` — the only two
//     mutating commands that ever remove a node from `Field`)
//
// Test-only field construction (`#[cfg(test)]` modules, `quality_control/checks/*.rs`'s synthetic
// fixtures) is exempt from both invariants — those never run through a real generation/repair
// pipeline.
pub struct DebugGenerationState<T: crate::space::Tessellation> {
    all_node_points: std::collections::HashMap<crate::ids::NodeId, T::CellId>,
}

impl<T: crate::space::Tessellation> DebugGenerationState<T> {
    pub fn new() -> Self {
        Self {
            all_node_points: std::collections::HashMap::new(),
        }
    }

    pub fn note(&mut self, id: crate::ids::NodeId, point: T::CellId) {
        self.all_node_points.insert(id, point);
    }

    pub fn all_node_points(&self) -> impl Iterator<Item = (crate::ids::NodeId, T::CellId)> + '_ {
        self.all_node_points.iter().map(|(&id, &point)| (id, point))
    }
}

impl<T: crate::space::Tessellation> Default for DebugGenerationState<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{SquarePoint, SquareTessellation};

    #[test]
    fn note_then_all_node_points_returns_it() {
        let mut state: DebugGenerationState<SquareTessellation> = DebugGenerationState::new();
        let point = SquarePoint { x: 1, y: 2 };
        state.note(5, point);
        let collected: Vec<_> = state.all_node_points().collect();
        assert_eq!(collected, vec![(5, point)]);
    }

    #[test]
    fn empty_state_yields_no_points() {
        let state: DebugGenerationState<SquareTessellation> = DebugGenerationState::new();
        assert_eq!(state.all_node_points().count(), 0);
    }

    #[test]
    fn note_overwrites_same_id() {
        let mut state: DebugGenerationState<SquareTessellation> = DebugGenerationState::new();
        state.note(1, SquarePoint { x: 0, y: 0 });
        state.note(1, SquarePoint { x: 9, y: 9 });
        let collected: Vec<_> = state.all_node_points().collect();
        assert_eq!(collected, vec![(1, SquarePoint { x: 9, y: 9 })]);
    }
}
