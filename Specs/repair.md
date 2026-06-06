# Repair

A mutation pass that attempts to fix issues detected by Quality Control. Works with `Maze` as the unified state object.

## Core Concepts

### RepairResult

```rust
pub enum RepairResult {
    Fixed,
    Failed,
}
```

- `Fixed` — strategy resolved the issue (or the issue was already absent; see idempotency below).
- `Failed` — the strategy cannot fix this issue under current conditions and must not be called again for this issue in the current pipeline run.

### RepairStrategy trait

```rust
pub trait RepairStrategy<F: Field> {
    fn apply(&self, issue: &Issue, maze: &mut Maze<F>, rng: &mut dyn RngCore) -> RepairResult;
}
```

- Receives `rng` from the caller — must not create its own RNG instances.
- Must be deterministic: given the same `maze` state and `rng` state, `apply` must produce the same result.
- Must not depend on external or global state.
- May read `maze.analysis` but must not write to it.
- **Idempotency**: if the relevant meta field is already set, return `Fixed` immediately without modifying state or consuming `rng`. This ensures safe re-invocation.

### RepairEngine

```rust
pub struct RepairEngine<F: Field> {
    strategies: HashMap<IssueKind, Box<dyn RepairStrategy<F>>>,
}

impl<F: Field> RepairEngine<F> {
    pub fn new(strategies: HashMap<IssueKind, Box<dyn RepairStrategy<F>>>) -> Self;
    pub fn run(
        &self,
        issues: &[Issue],
        maze: &mut Maze<F>,
        rng: &mut impl RngCore,
    ) -> Vec<(IssueKind, RepairResult)>;
}
```

- For each issue: looks up strategy by `issue.kind`.
- If no strategy found: issue is skipped (not included in results). The pipeline detects this via the progress fingerprint guard.
- Returns results only for issues that had a matching strategy, in the same order as the input slice.
- One `IssueKind` maps to exactly one strategy. Multiple issues of the same kind are not expected by the engine (the pipeline deduplicates before calling).

## Built-in Strategies

### CreateEndpointsStrategy

Handles `MISSING_ENDPOINTS`.

- If both `maze.meta.start` and `maze.meta.finish` are `Some`: returns `Fixed` immediately (idempotency guard).
- If `maze.meta.start.is_none()`:
  - If `finish` is also `None`: candidates = all node ids (sorted).
  - If `finish` is `Some`: candidates = `reachable_to(finish)` minus finish (nodes that can reach finish). Empty → `Failed`.
  - Picks candidate at random via `rng`, sets `maze.meta.start`.
- If `maze.meta.finish.is_none()`: candidates = `reachable_from(start)` minus start. Empty → `Failed`. Picks at random, sets `maze.meta.finish`.
- Returns `Fixed`.

### FarthestEndpointsStrategy

Handles `MISSING_ENDPOINTS`. Places start and finish at maximally distant nav-graph nodes (distance measured in tile count — edge weight = `path.len() - 1`).

- If both `maze.meta.start` and `maze.meta.finish` are `Some`: returns `Fixed` immediately.
- Empty nav graph: returns `Failed`.
- **Neither set**: picks a random nav node via `rng`, runs Dijkstra from it, takes the farthest node as `start`. Then runs Dijkstra from `start`, takes the farthest node as `finish`.
- **Only start set**: runs Dijkstra from `start`'s nav node, takes the farthest node as `finish`.
- **Only finish set**: runs reverse Dijkstra (traversing incoming edges) from `finish`'s nav node, takes the farthest node as `start`. This finds the node with the longest path that can actually reach `finish`, which is correct for one-way graphs.
- If farthest node equals the source (isolated nav node or no reachable peers in the same component): returns `Failed`.
- Disconnected nav-graph: Dijkstra only reaches nodes in the same connected component as the source. Unreachable nodes (distance `usize::MAX`) are excluded from selection, so start and finish always end up in the same component.

## Pipeline

Defined in `maze_core::generation::pipeline`.

```rust
pub const MAX_REPAIR_ITERATIONS: usize = 8;

pub fn build_maze<F: Field>(
    field: F,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<F>,
    repair_engine: RepairEngine<F>,
) -> (Maze<F>, Vec<Issue>)
```

`build_maze` and `MAX_REPAIR_ITERATIONS` are re-exported from `maze_core` root.

The second return value is the list of unresolved issues after all repair iterations. An empty vec means all issues were resolved. Callers decide how to handle unresolved issues — the pipeline always returns a maze regardless.

Logic:

1. Construct `Maze` via `Maze::new(field, graph)` — sets `MazeMeta::empty()` and `MazeAnalysis::default()`.
2. Create `rng = SmallRng::seed_from_u64(seed)`. This single RNG is shared across all repair iterations for cross-iteration determinism.
3. Track `failed: HashSet<IssueKind>` — issues whose strategy returned `Failed`.
4. Track `previous_fingerprint: Option<Vec<IssueKind>>` for progress detection.
5. Loop up to `MAX_REPAIR_ITERATIONS`:
   - Run QC.
   - Deduplicate issues by `IssueKind` (keep first occurrence per kind), then filter out `failed` kinds. This preserves one issue per kind, in original QC order.
   - If no active issues: break (all resolved).
   - Compute fingerprint: sorted list of active `IssueKind` values.
   - If fingerprint equals previous: break (no progress possible).
   - Run repair on active issues.
   - Add `Failed` results to `failed` set.
6. Final QC: return `(maze, remaining_issues)`.

**Note:** `generate_maze` must be called **before** `build_maze`. `build_maze` only handles metadata, not graph structure.

## Determinism Contract

A `build_maze` call is fully deterministic if:
1. The same graph structure is provided.
2. The same `seed` is used.
3. The same checks and strategies are registered in the same order.

`CreateEndpointsStrategy` sorts candidate lists before sampling, making results independent of node insertion order. `FarthestEndpointsStrategy` breaks distance ties by minimum `node_id` for determinism.
