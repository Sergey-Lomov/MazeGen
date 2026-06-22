# Quality Control

A read-only analysis pass that detects problems in a `Maze` and produces a list of `Issue` values. Runs before and after each repair iteration in the pipeline.

## Core Concepts

### IssueKind

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
    MinLoopsCount,
    MinLoopLength,
}
```

Each variant has a canonical string representation used in serialization and config:

```rust
impl IssueKind {
    pub fn as_str(self) -> &'static str { ... }   // "missing_endpoints", etc.
    pub fn from_str(s: &str) -> Option<Self> { ... }
}
```

Named constants alias the variants for use across crates:

```rust
pub const MISSING_ENDPOINTS: IssueKind = IssueKind::MissingEndpoints;
pub const UNREACHABLE_FINISH: IssueKind = IssueKind::UnreachableFinish;
pub const MIN_LOOPS_COUNT:    IssueKind = IssueKind::MinLoopsCount;
pub const MIN_LOOP_LENGTH:    IssueKind = IssueKind::MinLoopLength;
```

Always use the named constant — never use string literals or enum variants inline.

### Issue

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub kind: IssueKind,
    pub data: Option<IssueData>,
}

impl Issue {
    pub fn new(kind: IssueKind) -> Self;               // data: None
    pub fn with_data(kind: IssueKind, data: IssueData) -> Self;
}
```

`Issue` derives `PartialEq` but not `Eq` — `IssueData` is not `Eq` (future variants are expected to carry `f64` fields, e.g. weights/scores).

### IssueData

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum IssueData {
    TestPayload(Vec<u64>),       // temporary infra-only variant, see below
    ShortLoops(Vec<Vec<EdgeId>>), // produced by MinLoopLengthCheck, see below
}
```

`data` is a **per-kind payload** a `Check` may attach to an `Issue` it produces, carrying findings discovered during detection (e.g. candidate nodes, conflicting edges) for a matching `RepairStrategy` to use.

- **Whether `data` is required is a per-`IssueKind` decision, not a global rule.** Some kinds have no data variant at all. Some have one that's a genuine optimization (the strategy can cheaply recompute the same thing itself if `data` is absent). Some have one that's effectively mandatory — the data *is* the result of work too expensive to duplicate in the strategy, and there is no other channel to give the strategy what it needs. Each `RepairStrategy::apply` documents and decides for itself what `None`/wrong-variant `data` means for its own kind — there is no blanket "data is always optional" contract to fall back on.
- **Lifecycle**: `IssueData` is valid only for the Check → Strategy pair within a single QC pass. It is never carried across pipeline iterations and must not be retained by a strategy after `apply` returns — the maze may have mutated since.
- **Kind↔data invariant** (documentation-only, not runtime-checked — consistent with other contracts in this module): each `IssueKind` is expected to use a specific, fixed set of `IssueData` variants. It is the responsibility of the `Check`/`RepairStrategy` author to keep kind and data variant in sync.
- **`TestPayload`**: a temporary, infra-only variant not tied to any real `IssueKind`, used to exercise `Clone`/equality on a non-trivial owned payload. Marked `// TODO` in code for removal once a first real variant lands.
- **`ShortLoops(Vec<Vec<EdgeId>>)`**: produced by `MinLoopLengthCheck` (paired with `MIN_LOOP_LENGTH`) — **mandatory** for this kind, see `MinLoopLengthRandomStrategy` in `repair.md`. Each inner `Vec<EdgeId>` is the **set** of base-`Graph` edges forming one simple cycle shorter than the configured threshold — element order carries no meaning beyond membership, only used as a convenient container. An empty outer `Vec` is valid and means the check found nothing short enough to break. `EdgeId` values never repeat within one cycle. Length is measured in **base-graph tile-hops**, not nav-edges (one nav-edge may compress several tiles).
- **Not exposed over WASM**: the WASM layer only serializes `IssueKind` (via `as_str()`/`Display`), never the `Issue` struct or its `data`. No serde derive is needed unless that changes.
- **Dedup interaction**: see `repair.md` — QC dedup keeps at most one `Issue` per `IssueKind` per pass, which means a second issue of the same kind (and its `data`) is silently dropped. A `debug_assert!` in the pipeline's dedup filter catches this in development builds.

### Check trait

```rust
pub trait Check<T: Tessellation> {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>);
}
```

- **Read-only**: `maze` is immutable. A `Check` must not mutate any state.
- **No side effects**: `check` must not access global state, perform I/O, or produce non-deterministic output.
- A check may produce zero or more issues per call.
- A check may read `maze.analysis` to avoid redundant computation.

### QualityControlEngine

```rust
pub struct QualityControlEngine<T: Tessellation> {
    checks: Vec<Box<dyn Check<T>>>,
}

impl<T: Tessellation> QualityControlEngine<T> {
    pub fn new(checks: Vec<Box<dyn Check<T>>>) -> Self;
    pub fn run(&self, maze: &Maze<T>) -> Vec<Issue>;
}
```

- Runs checks in insertion order.
- Returns all issues collected across all checks, including duplicates.
- Deduplication of issues with the same `IssueKind` is the pipeline's responsibility.

## Built-in Checks

### MissingEndpointsCheck

Produces `Issue::new(MISSING_ENDPOINTS)` if either `maze.meta.start` or `maze.meta.finish` is `None`.

### UnreachableFinishCheck

Produces `Issue::new(UNREACHABLE_FINISH)` if both `maze.meta.start` and `maze.meta.finish` are `Some` but `finish` is not reachable from `start` via directed graph traversal.

Skips the check silently if either endpoint is `None` — those cases are covered by `MissingEndpointsCheck`.

### MinLoopsCountCheck

```rust
pub const MIN_LOOPS_DEFAULT: u32 = 1;

pub struct MinLoopsCountCheck {
    pub min_loops: u32,
}
```

Intended to fire `Issue::new(MIN_LOOPS_COUNT)` when the maze has fewer loops than `min_loops`. Loop detection is not yet implemented — the check always fires regardless of `min_loops`.

### MinLoopLengthCheck

```rust
pub const MIN_LOOP_LENGTH_DEFAULT: u32 = 10;

pub struct MinLoopLengthCheck {
    pub min_loop_length: u32,
}
```

A separate, unrelated check from `MinLoopsCountCheck` (that one counts total loops; this one checks individual loop *length*). Builds a fresh `NavGraph` via `build_nav_graph(&maze.graph)` directly (not through `maze.analysis` — `Check::check` only receives `&Maze`), then uses `find_all_simple_cycles` (`maze-core/src/graph/cycles.rs`, Johnson's algorithm — see `graph-analytics.md` for the full description of this shared, single-source-of-truth cycle enumeration), `dedup_bidirectional_pairs` (collapses each visual loop walked in either direction to one entry, drops trivial reverse-pair turn-arounds), then filters the result to cycles whose tile-length is below `min_loop_length`.

Not a fundamental cycle basis — a basis only yields β₁ cycles relative to one spanning tree and can miss short cycles that are the symmetric difference of two longer fundamental cycles (unacceptable false negatives for a health check). `find_all_simple_cycles` enumerates ALL simple directed cycles with no length bound; this check filters the already-complete result by tile-length afterward, rather than embedding a bound into the search itself (kept uniform with the other consumers of `find_all_simple_cycles` — see `graph-analytics.md`).

Self-loop nav-edges (junction-free rings) are included — previously a known gap (a ring with at most one junction compresses into a self-loop `NavEdge` that the old `build_cyclic_core` unconditionally excluded, making such loops invisible to this check). Fixed by `find_all_simple_cycles` treating self-loops as first-class cycles.

If any cycles below the threshold are found, fires a single `Issue::with_data(MIN_LOOP_LENGTH, IssueData::ShortLoops(...))` carrying **all** of them (QC dedup allows at most one issue per kind per pass — see the invariant above).

## WASM Interface

The WASM layer exposes check metadata and accepts check configuration from the frontend.

### CheckDescriptor

Serialized to JSON by `available_checks()`:

```rust
struct CheckDescriptor {
    id: &'static str,           // check ID used in GenerateConfig.checks
    label: &'static str,        // human-readable name
    description: &'static str,  // human-readable description
    issue_kinds: Vec<&'static str>, // IssueKind::as_str() values this check may produce
    params: Vec<ParamDescriptor>,
}
```

### ParamDescriptor

```rust
struct ParamDescriptor {
    id: &'static str,
    label: &'static str,
    kind: ParamKindDto,
}

#[serde(tag = "type", rename_all = "snake_case")]
enum ParamKindDto {
    Float   { default: f64, min: f64, max: f64 },
    Integer { default: i64, min: i64, max: i64 },
    Bool    { default: bool },
    Enum    { options: Vec<&'static str>, default: &'static str },
}
```

### GenerateConfig — check fields

```rust
pub struct GenerateConfig {
    pub checks: Vec<String>,                                  // check IDs to run
    pub check_params: HashMap<String, HashMap<String, String>>, // check_id → param_id → value
    // ...
}
```

The runner matches checks by string ID (`match id.as_str()`), not by `IssueKind`. Unknown check IDs return an error. Unknown param keys are silently ignored; missing params fall back to the check's default constant.

### Available checks

| ID | Issue kind | Params | Default selected |
|----|------------|--------|-----------------|
| `missing_endpoints` | `missing_endpoints` | — | yes |
| `unreachable_finish` | `unreachable_finish` | — | yes |
| `min_loops_count` | `min_loops_count` | `min_loops: Integer(default=1, min=1, max=1_000_000)` | no |
| `min_loop_length` | `min_loop_length` | `min_loop_length: Integer(default=10, min=1, max=100_000)` | no |

Checks without params are auto-selected on `loadRegistry`. Checks with params are not auto-selected — the user must add them explicitly.

## Architectural Contract

Only code that owns the `Maze` may call `&mut self` accessors on `maze.analysis`. QC checks and repair strategies may read `maze.analysis` via shared reference but must not write to it.

`MazeAnalysis` caches derived data lazily. See `analysis.md` for the full contract.
