use crate::Maze;
use crate::meta::MazeMeta;
use crate::graph::Graph;
use crate::space::Tessellation;

/// Stack of (Graph, MazeMeta) snapshots a `RepairStrategy` can push/pop around a sequence of
/// mutating actions it wants to be able to roll back. Intentionally opt-in and rarely used —
/// each `snapshot()` deep-copies the whole `Graph`, which is not cheap; this is meant for
/// occasional rollback points, not a hot-path tool.
pub struct SnapshotStack {
    stack: Vec<(Graph, MazeMeta)>,
}

impl SnapshotStack {
    /// Public so integration tests can construct a stack directly when calling `apply()` outside
    /// of `RepairEngine::run`. In normal pipeline operation only `RepairEngine::run` constructs a
    /// `SnapshotStack` (one per `apply()` call) — strategies receive an existing instance via
    /// `&mut` and only call `snapshot()`/`restore()` on it, they never construct their own.
    pub fn new() -> Self {
        Self { stack: Vec::new() }
    }
}

impl Default for SnapshotStack {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapshotStack {
    /// Pushes a copy of `maze`'s current graph + meta onto the stack. Always pushes
    /// unconditionally — no dedup against an unchanged top-of-stack entry, even if nothing has
    /// mutated since the last `snapshot()`.
    pub fn snapshot<T: Tessellation>(&mut self, maze: &Maze<T>) {
        self.stack.push((maze.graph.clone(), maze.meta.clone()));
    }

    /// Pops the most recent snapshot and replaces `maze`'s graph/meta with it — the whole
    /// `Graph` is swapped, not merged field-by-field. Bumps the graph version past whatever the
    /// current graph's version is, so `MazeAnalysis`'s version-keyed cache (`nav_graph`, `scc`,
    /// `route_info`, `graph_analytics`, distance maps) is unconditionally treated stale and
    /// rebuilt on next access — even when the restored content ends up identical to what it was
    /// right before this call (version is a monotonic cache-invalidation counter, not a content
    /// fingerprint).
    ///
    /// Any data derived from the graph before `restore()` — `NodeId`/`EdgeId`, paths, SCC
    /// components, nav-graph structures, distance maps — may no longer refer to what it did (or
    /// may not exist at all) in the restored graph. Callers must treat all such data as stale
    /// across a `restore()` and re-derive it, not just re-fetch cached ids.
    ///
    /// The stack remains a normal LIFO after this call — further `snapshot()`/`restore()` pairs
    /// within the same `apply()` are unrestricted.
    ///
    /// Panics if the stack is empty — calling `restore()` without a matching `snapshot()` is a
    /// strategy bug.
    pub fn restore<T: Tessellation>(&mut self, maze: &mut Maze<T>) {
        let (graph, meta) = self.stack.pop().expect("restore() called with empty snapshot stack");
        let version_before_restore = maze.graph.version();
        maze.graph = graph;
        maze.graph.force_bump_past(version_before_restore);
        maze.meta = meta;
    }
}
