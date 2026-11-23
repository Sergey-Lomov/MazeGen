//! Zone scope of a QC rule (GitHub issue #1039, `Specs/quality_control.md`).
//!
//! A rule bound to scopes runs once per scope: its checks and strategy see the maze through a
//! `graph::ScopeMask` of the scope's cells (cells, not nodes: a split tile adds and removes nodes
//! while the cell stays), and a strategy may only change links anchored in those cells.

use crate::Maze;
use crate::ids::NodeId;
use crate::repair::MutationCommand;
use crate::space::{LevelId, MultiLevelField, Tessellation};
use std::collections::HashSet;

/// One scope of a rule: an id naming it in issues and the event log, and the field cells it covers.
pub struct ScopeCells<T: Tessellation> {
    id: String,
    cells: HashSet<(LevelId, T::CellId)>,
}

impl<T: Tessellation> ScopeCells<T> {
    pub fn new(
        id: impl Into<String>,
        cells: impl IntoIterator<Item = (LevelId, T::CellId)>,
    ) -> Self {
        Self {
            id: id.into(),
            cells: cells.into_iter().collect(),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    /// The nodes currently sitting on the scope's cells, split nodes included.
    pub fn inner_nodes(&self, field: &MultiLevelField<T>) -> HashSet<NodeId> {
        self.cells
            .iter()
            .flat_map(|&(level, cell)| field.nodes_at(level, cell).iter().copied())
            .collect()
    }

    /// Whether `node` sits on one of the scope's cells; `false` for a node the field does not hold.
    pub fn contains_node(&self, field: &MultiLevelField<T>, node: NodeId) -> bool {
        field
            .level_of(node)
            .zip(field.cell_of(node))
            .is_some_and(|key| self.cells.contains(&key))
    }

    /// The anchor rule (`Specs/repair.md`): a command may touch a link when at least one end of it
    /// sits in the scope, so a scope of scattered cells can still link out of itself. A command
    /// that cannot be resolved against the maze (its edge is gone) is let through, since it fails
    /// on its own. A group passes only when every member does.
    pub fn allows(&self, maze: &Maze<T>, cmd: &MutationCommand) -> bool {
        let field = &maze.field;
        let either =
            |a: NodeId, b: NodeId| self.contains_node(field, a) || self.contains_node(field, b);
        let edge = |id| maze.graph.edge(id).is_none_or(|e| either(e.from, e.to));
        match cmd {
            MutationCommand::AddDirectedEdge { from, to }
            | MutationCommand::AddDirectedTeleport { from, to }
            | MutationCommand::AddDirectedVerticalPassage { from, to }
            | MutationCommand::RemoveEdgeBetween { from, to } => either(*from, *to),
            MutationCommand::AddBidirectionalEdge { a, b }
            | MutationCommand::AddBidirectionalTeleport { a, b }
            | MutationCommand::AddBidirectionalVerticalPassage { a, b }
            | MutationCommand::AddBidirectionalElevator { a, b } => either(*a, *b),
            MutationCommand::RemoveEdge { id }
            | MutationCommand::RemoveEdgeWithReverse { id }
            | MutationCommand::RemoveTeleportWithReverse { id }
            | MutationCommand::RemoveVerticalPassageWithReverse { id } => edge(*id),
            MutationCommand::SetStart(node) | MutationCommand::SetFinish(node) => {
                self.contains_node(field, *node)
            }
            MutationCommand::RemoveNode { node } => self.contains_node(field, *node),
            MutationCommand::ReplacePointNodes { at, .. } => self.contains_node(field, *at),
            MutationCommand::Atomic { commands } => commands.iter().all(|c| self.allows(maze, c)),
        }
    }
}
