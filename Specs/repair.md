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

### Strategy Parameters

```rust
pub struct StrategyParam {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: StrategyParamKind,
}

pub enum StrategyParamKind {
    Float { default: f64, min: f64, max: f64 },
    Bool { default: bool },
    Enum { options: &'static [&'static str], default: &'static str },
}

pub enum StrategyParamValue {
    Float(f64),
    Bool(bool),
    Enum(String),
}

pub type StrategyParams = HashMap<&'static str, StrategyParamValue>;
```

`build_params(descriptors, overrides)` builds a `StrategyParams` map from a descriptor slice and an optional `HashMap<String, String>` of raw string overrides:
- Float: parsed with `str::parse::<f64>`, clamped to `[min, max]`; NaN/infinite/unparseable → default.
- Bool: `"true"` / `"1"` → `true`, `"false"` / `"0"` → `false`; anything else → default.
- Enum: accepted only if the value is in `options`; otherwise → default.
- Keys in `overrides` that don't match any descriptor are ignored.

### RepairStrategy trait

```rust
pub trait RepairStrategy<F: Field> {
    fn params(&self) -> &'static [StrategyParam] { &[] }
    fn apply(&self, issue: &Issue, maze: &mut Maze<F>, rng: &mut dyn RngCore, params: &StrategyParams) -> RepairResult;
}
```

- `params()` returns the descriptor slice for this strategy's configurable parameters. Default impl returns empty slice.
- Receives `rng` from the caller — must not create its own RNG instances.
- Must be deterministic: given the same `maze` state, `rng` state, and `params`, `apply` must produce the same result.
- Must not depend on external or global state.
- May read `maze.analysis` but must not write to it.
- **Idempotency**: if the relevant meta field is already set, return `Fixed` immediately without modifying state or consuming `rng`. This ensures safe re-invocation.
- May read `issue.data` (see `quality_control.md`) — findings the matching `Check` already computed during detection. Whether `data` is optional (cheap to recompute, so `None` falls back gracefully) or effectively required (the data *is* the expensive result, with no other channel to get it) is a **per-`IssueKind` decision**, documented by each strategy for its own kind — there is no blanket rule across all strategies.

### RepairEngine

```rust
pub struct RepairEngine<F: Field> {
    strategies: HashMap<IssueKind, Box<dyn RepairStrategy<F>>>,
    param_overrides: HashMap<IssueKind, HashMap<String, String>>,
}

impl<F: Field> RepairEngine<F> {
    pub fn new(
        strategies: HashMap<IssueKind, Box<dyn RepairStrategy<F>>>,
        param_overrides: HashMap<IssueKind, HashMap<String, String>>,
    ) -> Self;
    pub fn run(
        &self,
        issues: &[Issue],
        maze: &mut Maze<F>,
        rng: &mut impl RngCore,
    ) -> Vec<(IssueKind, RepairResult)>;
}
```

- `param_overrides` is keyed by `IssueKind` (same key space as `strategies`).
- For each issue: looks up strategy by `issue.kind`, calls `build_params(strategy.params(), overrides)`, then calls `apply`.
- If no strategy found: issue is skipped (not included in results). The pipeline detects this via the progress fingerprint guard.
- Returns results only for issues that had a matching strategy, in the same order as the input slice.
- One `IssueKind` maps to exactly one strategy. Multiple issues of the same kind are not expected by the engine (the pipeline deduplicates before calling).

## Built-in Strategies

### RandomEndpointsStrategy

Handles `MISSING_ENDPOINTS`. No configurable parameters.

- If both `maze.meta.start` and `maze.meta.finish` are `Some`: returns `Fixed` immediately (idempotency guard).
- If `maze.meta.start.is_none()`:
  - If `finish` is also `None`: candidates = all node ids (sorted).
  - If `finish` is `Some`: candidates = `reachable_to(finish)` minus finish (nodes that can reach finish). Empty → `Failed`.
  - Picks candidate at random via `rng`, sets `maze.meta.start`.
- If `maze.meta.finish.is_none()`: candidates = `reachable_from(start)` minus start. Empty → `Failed`. Picks at random, sets `maze.meta.finish`.
- Returns `Fixed`.

### FarthestEndpointsStrategy

Handles `MISSING_ENDPOINTS`. No configurable parameters. Places start and finish at maximally distant nav-graph nodes (distance measured in tile count — edge weight = `path.len() - 1`).

- If both `maze.meta.start` and `maze.meta.finish` are `Some`: returns `Fixed` immediately.
- Empty nav graph: returns `Failed`.
- **Neither set**: picks a random nav node via `rng`. Runs reverse Dijkstra (incoming edges) from that node to find the node farthest *upstream* — this becomes `start` (landing in a source SCC). Then runs forward Dijkstra from `start` to find the farthest reachable node — this becomes `finish`.
- **Only start set**: runs Dijkstra from `start`'s nav node, takes the farthest node as `finish`.
- **Only finish set**: runs reverse Dijkstra (traversing incoming edges) from `finish`'s nav node, takes the farthest node as `start`. This finds the node with the longest path that can actually reach `finish`, which is correct for one-way graphs.
- If farthest node equals the source (isolated nav node or no reachable peers in the same component): returns `Failed`.
- Disconnected nav-graph: Dijkstra only reaches nodes in the same connected component as the source. Unreachable nodes (distance `usize::MAX`) are excluded from selection, so start and finish always end up in the same component.

### ScoredEndpointsStrategy

Handles `MISSING_ENDPOINTS`. Selects start/finish pair by maximizing a weighted score over all reachable (start → finish) paths in the nav graph.

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `path_weight` | Float | 1.0 | [0, 100] | Weight applied to path tile count |
| `junction_weight` | Float | 3.0 | [0, 100] | Weight applied to number of junction nav nodes on path |
| `oneway_weight` | Float | 5.0 | [0, 100] | Weight applied to number of one-way nav edges on path |

Score formula: `path_tiles * path_weight + junction_count * junction_weight + oneway_count * oneway_weight`

- Junction: nav node with ≥ 3 distinct neighbors (union of incoming and outgoing).
- One-way edge: nav edge `(u → v)` where no reverse edge `(v → u)` exists.
- Path cost (for Dijkstra): edge weight = `path.len() - 1` (tile count).

Behavior per case:
- Both set: returns `Fixed` immediately.
- Empty nav graph: returns `Failed`.
- **Neither set**: finds the `(start, finish)` pair with the highest score across all nav node pairs. Runs Dijkstra for each candidate start.
- **Only start set**: fixes start, searches for best finish.
- **Only finish set**: fixes finish, searches for best start.
- No reachable path found: returns `Failed`.

### MinLoopLengthRandomStrategy

Handles `MIN_LOOP_LENGTH`. Breaks each simple cycle found by `MinLoopLengthCheck` shorter than the threshold by removing one random edge from it (plus its reverse, if present) — a wall placed at a random point along the loop. No configurable parameters.

**`issue.data` is mandatory for this kind**, not an optional optimization: `MinLoopLengthCheck` already did the (potentially expensive) bounded cycle search, and there's no other channel for the strategy to learn the check's configured threshold or recompute the same result cheaply. This is a per-kind decision (see `quality_control.md`), not a general rule for all strategies.

- If `issue.data` is `Some(IssueData::ShortLoops(cycles))`: cuts directly from the resolved `Vec<Vec<EdgeId>>`. An empty outer `Vec` is valid — nothing to break, returns `Fixed` immediately.
- If `data` is missing or the wrong variant: this is a malformed call (should never happen in a normal pipeline run, where the check always attaches data) — returns `Failed`, not "already fixed".
- For each cycle: filters candidates to edges still present in the graph (`Graph::edge(id).is_some()` — an earlier cut in the same `apply` may have already broken a cycle sharing an edge with this one), then removes one random survivor plus its reverse (`Graph::edge_between(to, from)`), if any.
- **Accepted imprecision, not fully solved**: removing an edge can invalidate another cycle in the same batch through subtler graph changes than a shared `EdgeId` (e.g. corridor re-compression). The existence check only catches the shared-edge case; it does not re-validate every remaining cycle entry. Acceptable for a `Random` strategy — a smarter variant that recomputes between cuts is a separate future task if needed.
- **Does not guard connectivity or bridge status**: a cut may disconnect the maze, surfacing as `UnreachableFinish`/`MissingEndpoints` on the next QC pass. Deliberately not handled here — the pipeline's fixpoint loop (`build_maze`, up to `MAX_REPAIR_ITERATIONS`) already exists for exactly this kind of cascading repair, via the already-registered endpoint strategies.
- **No candidate weighting** (segment length, multi-cycle membership, etc.) — the name `Random` is deliberate. A smarter strategy on the same issue kind (à la `RandomEndpointsStrategy` vs `ScoredEndpointsStrategy`) is a separate future task.
- Returns `Fixed { score: None }`.

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
   - **Note**: QC dedup keeps at most one `Issue` per `IssueKind` per pass (first occurrence wins). If multiple issues of the same kind carry different `data`, only the first's payload survives — a `debug_assert!` flags this in development builds.
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
4. The same `param_overrides` are provided.

`RandomEndpointsStrategy` sorts candidate lists before sampling, making results independent of node insertion order. `FarthestEndpointsStrategy` breaks distance ties by minimum `node_id` for determinism.
