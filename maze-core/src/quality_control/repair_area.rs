use crate::space::LevelId;

/// Where a deficit issue's missing entities must be added — see GitHub issue #369's floor-scope
/// follow-up. A `FloorScope::PerFloor` check computes its deficit independently per floor, but a
/// repair strategy that samples candidates from the whole field regardless (e.g.
/// `MissingLoopsRandomStrategy`'s `maze.field.all_node_ids()` pool) can satisfy the reported total
/// while adding every new entity to the wrong floor. `RepairArea` closes that gap: each deficit
/// entry now says not just how many entities are missing, but where they're missing from, so a
/// strategy can restrict its own candidate pool to the named area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RepairArea {
    /// No floor restriction — a `FloorScope::WholeMaze` check's own deficit, or any candidate on
    /// any floor satisfies it equally.
    WholeMaze,
    /// The deficit belongs to one specific floor — a `FloorScope::PerFloor` check's own per-floor
    /// deficit. A strategy must restrict its candidate pool to nodes/edges on this floor.
    Level(LevelId),
}
