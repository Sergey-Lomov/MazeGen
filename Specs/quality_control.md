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
    InvalidLoop,
    CycleAnalysisOverflowed,
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
pub const INVALID_LOOP:       IssueKind = IssueKind::InvalidLoop;
pub const CYCLE_ANALYSIS_OVERFLOWED: IssueKind = IssueKind::CycleAnalysisOverflowed;
```

Always use the named constant — never use string literals or enum variants inline.

**Hard rule: `IssueKind` is a semantic category, not a producer id.** `InvalidLoop` means "this cycle is invalid for some check-specific reason" — it does not identify *which* check found it. Multiple checks can legitimately produce the same `IssueKind` for different underlying reasons — currently `MinLoopLengthCheck` (cycles shorter than a threshold) and `MaxLoopLengthCheck` (cycles longer than a threshold); future checks may flag cycles invalid for still other reasons and reuse this same kind rather than inventing a new one per reason. Which check(s) actually contributed to a given `Issue` is tracked separately, in `Issue.source_checks` (below) — never by adding more `IssueKind` variants.

**`CycleAnalysisOverflowed` is not a toggleable QC check** — every other kind here is produced by a `Check<T>` implementation the user selects via `config.checks`; this one is raised directly by `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) whenever `GraphAnalytics::cycle_analysis_overflowed` is true (cycle enumeration aborted past `MAX_SIMPLE_CYCLES` — see `graph-analytics.md`). It bypasses `QualityControlEngine` entirely: `build_analytics_snapshot` pushes `Issue::new(CYCLE_ANALYSIS_OVERFLOWED)` straight into the issue list after the engine (or `issues_override`) has already run, so it surfaces unconditionally — same `IssuesBlock`/`FeatureCard` UI as any other issue, but with no corresponding `Check<T>` or `RepairStrategy` and no way for a user to disable it. `IssueKind::from_str` still parses it like any other kind (used to validate `config.strategies` keys), but no strategy can ever be registered against it — see `from_str`'s doc comment.

### Issue

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub kind: IssueKind,
    pub data: Option<IssueData>,
    source_checks: Vec<&'static str>, // private — see accessors below
}

impl Issue {
    pub fn new(kind: IssueKind) -> Self;                                            // data: None, source_checks: []
    pub fn with_data(kind: IssueKind, data: IssueData) -> Self;                     // source_checks: []
    pub fn new_from_check(kind: IssueKind, source_check: &'static str) -> Self;
    pub fn with_data_from_check(kind: IssueKind, data: IssueData, source_check: &'static str) -> Self;
    pub fn source_checks(&self) -> &[&'static str];
    /// `Some` only when there is exactly one source check (the normal raw, pre-merge case) —
    /// `None` for zero (e.g. `CYCLE_ANALYSIS_OVERFLOWED`) or 2+ sources (an already-merged
    /// issue, or a malformed raw one). Pipeline rule-routing uses this, not `source_checks()`
    /// indexing, so a malformed multi-source raw issue can't be silently misrouted by an
    /// arbitrary first id — see `repair.md`'s "Pipeline" section.
    pub fn single_source_check(&self) -> Option<&'static str>;
    pub(crate) fn push_source(&mut self, source: &'static str); // merge_issue only
}
```

`Issue` derives `PartialEq` but not `Eq` — `IssueData` is not `Eq` (future variants are expected to carry `f64` fields, e.g. weights/scores).

`Issue` is an **internal-only QC artifact** — it is never serialized as a DTO or surfaced as its own UI entity (the WASM layer only ever serializes `IssueKind::as_str()`/`Display`, see "Not exposed over WASM" below; the web UI attaches strategies to checks directly, not to a separate issues list — see `quality-feature.md`). Keep this boundary explicit when extending `Issue`: new fields belong here only if they're plumbing between a `Check` and the matching `RepairStrategy` within one QC pass, not if they're meant for display.

`source_checks` (private field, read via `source_checks()`) records which check id(s) (the wasm `available_checks()` id, e.g. `"min_loop_length"`) produced or contributed to this issue. Every toggleable `Check<T>` implementation should construct its issues via `new_from_check`/`with_data_from_check`, passing its own check id. The one exception is `CYCLE_ANALYSIS_OVERFLOWED`, pushed directly by `build_analytics_snapshot` outside any `Check<T>` (see its doc comment below) — it has no check id to attribute to, so it uses plain `Issue::new` and `source_checks` stays empty. When two issues of the same kind are merged (see "Dedup interaction" below), `source_checks` is unioned without duplicates via `push_source` — the field is private specifically so nothing outside `merge_issue` can append to it or construct an `Issue` with an already-multi-source list before merge has legitimately produced one (a raw, pre-merge issue is expected to carry exactly one source check; `single_source_check()` is the type-level enforcement of that for rule-routing).

### IssueData

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum IssueData {
    TestPayload(Vec<u64>),       // temporary infra-only variant, see below
    InvalidLoops {                // produced by any check flagging cycles invalid, see below
        all: Vec<Vec<EdgeId>>,
        invalid: Vec<usize>,
        invalid_sources: HashMap<Vec<EdgeId>, Vec<&'static str>>,
    },
}
```

`data` is a **per-kind payload** a `Check` may attach to an `Issue` it produces, carrying findings discovered during detection (e.g. candidate nodes, conflicting edges) for a matching `RepairStrategy` to use.

- **Whether `data` is required is a per-`IssueKind` decision, not a global rule.** Some kinds have no data variant at all. Some have one that's a genuine optimization (the strategy can cheaply recompute the same thing itself if `data` is absent). Some have one that's effectively mandatory — the data *is* the result of work too expensive to duplicate in the strategy, and there is no other channel to give the strategy what it needs. Each `RepairStrategy::apply` documents and decides for itself what `None`/wrong-variant `data` means for its own kind — there is no blanket "data is always optional" contract to fall back on.
- **Lifecycle**: `IssueData` is valid only for the Check → Strategy pair within a single QC pass. It is never carried across pipeline iterations and must not be retained by a strategy after `apply` returns — the maze may have mutated since.
- **Kind↔data invariant** (documentation-only, not runtime-checked — consistent with other contracts in this module): each `IssueKind` is expected to use a specific, fixed set of `IssueData` variants. It is the responsibility of the `Check`/`RepairStrategy` author to keep kind and data variant in sync.
- **`TestPayload`**: a temporary, infra-only variant not tied to any real `IssueKind`, used to exercise `Clone`/equality on a non-trivial owned payload. Marked `// TODO` in code for removal once a first real variant lands.
- **`InvalidLoops { all, invalid, invalid_sources }`**: produced by any check that flags simple cycles invalid for a check-specific reason (paired with `INVALID_LOOP`) — currently `MinLoopLengthCheck` (cycles shorter than a configured threshold) and `MaxLoopLengthCheck` (cycles longer than a configured threshold), **mandatory** for this kind, see `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy` in `repair.md`. `all` holds **every** simple cycle found in the maze, valid and invalid alike, each as the **set** of base-`Graph` edges forming it — element order carries no meaning beyond membership, only used as a convenient container, and `EdgeId` values never repeat within one cycle. `invalid` is the subset of indices into `all` that the producing check(s) flagged — the cycles a repair strategy must actually break. An empty `invalid` is valid and means no cycle was flagged (`all` may still be non-empty in that case). Future checks may flag cycles invalid for reasons other than length and reuse this same variant, rather than introducing a new one per reason — see the `IssueKind` hard rule above.
- **`invalid_sources`**: per-cycle check attribution, keyed by `canonical_cycle_key` (the cycle's edge set, sorted) rather than by index into `all` — indices get remapped on every merge (see `merge_invalid_loops` in `repair.md`'s "Pipeline" section), but a cycle's canonical key is stable across merges, so this map never needs remapping. Maps a cycle to the check id(s) that flagged it invalid. A cycle absent from this map was flagged by no check directly tracked — shouldn't happen for entries in `invalid`, but the map is not required to cover every index; absence means "no recorded source," not an error.
- Keeping the valid cycles in `all` (not just the invalid ones) lets a strategy avoid cutting an edge that is also part of a cycle the maze is meant to keep — see `InvalidLoopScoredStrategy` in `repair.md`.
- **Not exposed over WASM**: the WASM layer only serializes `IssueKind` (via `as_str()`/`Display`), never the `Issue` struct or its `data`. No serde derive is needed unless that changes.
- **Dedup interaction**: multiple checks may produce an `Issue` of the same `IssueKind` in one QC pass. The pipeline (see `repair.md`'s "Pipeline" section) **merges** them into a single `Issue` rather than keeping only the first and dropping the rest — this replaces an earlier dedup-by-first-occurrence design that silently lost a second issue's `data`. The merge rule is per-`IssueData`-variant: for `InvalidLoops`, cycles are merged canonically (a cycle is identified by its edge set, not by `Vec` order, so the same cycle found by two checks collapses to one entry instead of being duplicated); `invalid_sources` is unioned per canonical key (no remap needed); `source_checks` (on `Issue`, see above) is unioned. A combination of `IssueData` variants with no defined merge rule is a `debug_assert!`/panic in debug builds, not a silent pick-one-side fallback.

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
- Merging issues with the same `IssueKind` (not dropping duplicates) is the pipeline's responsibility — see `repair.md`'s "Pipeline" section and the "Dedup interaction" note above.

## Built-in Checks

### MissingEndpointsCheck

Produces `Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints")` if either `maze.meta.start` or `maze.meta.finish` is `None`.

### UnreachableFinishCheck

Produces `Issue::new_from_check(UNREACHABLE_FINISH, "unreachable_finish")` if both `maze.meta.start` and `maze.meta.finish` are `Some` but `finish` is not reachable from `start` via directed graph traversal.

Skips the check silently if either endpoint is `None` — those cases are covered by `MissingEndpointsCheck`.

### MinLoopsCountCheck

```rust
pub const MIN_LOOPS_DEFAULT: u32 = 1;

pub struct MinLoopsCountCheck {
    pub min_loops: u32,
}
```

Intended to fire `Issue::new_from_check(MIN_LOOPS_COUNT, "min_loops_count")` when the maze has fewer loops than `min_loops`. Loop detection is not yet implemented — the check always fires regardless of `min_loops`.

### MinLoopLengthCheck

```rust
pub const MIN_LOOP_LENGTH_DEFAULT: u32 = 10;

pub struct MinLoopLengthCheck {
    pub min_loop_length: u32,
}
```

A separate, unrelated check from `MinLoopsCountCheck` (that one counts total loops; this one checks individual loop *length*). Uses `maze.analysis.nav_graph(&maze.graph, &maze.meta)` (the shared, pinned-by-`meta` cache — see `analysis.md`), then `find_all_simple_cycles` (`maze-core/src/graph/cycles.rs`, Johnson's algorithm — see `graph-analytics.md` for the full description of this shared, single-source-of-truth cycle enumeration), `dedup_bidirectional_pairs` (collapses each visual loop walked in either direction to one entry, drops trivial reverse-pair turn-arounds). Every resulting cycle (short and long alike) is resolved to base-`Graph` `EdgeId`s and stored in `IssueData::InvalidLoops.all`; the subset whose tile-length is below `min_loop_length` becomes `invalid` (indices into `all`).

Symmetric counterpart: `MaxLoopLengthCheck` (below) flags cycles whose tile-length exceeds a maximum instead. Both checks may run in the same QC pass and both produce `INVALID_LOOP` — see the merge behavior in `repair.md`'s "Pipeline" section.

Not a fundamental cycle basis — a basis only yields β₁ cycles relative to one spanning tree and can miss short cycles that are the symmetric difference of two longer fundamental cycles (unacceptable false negatives for a health check). `find_all_simple_cycles` enumerates ALL simple directed cycles with no length bound; this check filters the already-complete result by tile-length afterward, rather than embedding a bound into the search itself (kept uniform with the other consumers of `find_all_simple_cycles` — see `graph-analytics.md`).

Self-loop nav-edges (junction-free rings) are included — previously a known gap (a ring with at most one junction compresses into a self-loop `NavEdge` that the old `build_cyclic_core` unconditionally excluded, making such loops invisible to this check). Fixed by `find_all_simple_cycles` treating self-loops as first-class cycles.

If any cycles below the threshold are found (`invalid` non-empty), fires a single `Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid }, "min_loop_length")`. No issue is fired if `invalid` is empty, even if `all` is not. Other checks may also produce `INVALID_LOOP` issues for different reasons in the same pass — see the pipeline's merge behavior in `repair.md`.

### MaxLoopLengthCheck

```rust
pub const MAX_LOOP_LENGTH_DEFAULT: u32 = 100;

pub struct MaxLoopLengthCheck {
    pub max_loop_length: u32,
}
```

Symmetric counterpart to `MinLoopLengthCheck` — same cycle enumeration pipeline (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs` → tile-length filter → `resolve_to_edge_ids`), same silent skip on `CycleSearchResult::TooManyCycles` overflow, same `IssueData::InvalidLoops` shape. The only difference: the filter keeps cycles whose tile-length is **above** `max_loop_length` (`tile_length > max_loop_length`) instead of below a minimum.

If any cycles above the threshold are found (`invalid` non-empty), fires a single `Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid }, "max_loop_length")`. No issue is fired if `invalid` is empty. Both `MinLoopLengthCheck` and `MaxLoopLengthCheck` can be active at once — they each populate their own `invalid` subset and the pipeline merges the two `INVALID_LOOP` issues canonically (see "Dedup interaction" above and `repair.md`'s "Pipeline" section).

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
    pub check_rules: Vec<QcRuleConfig>,                        // rule configs — see below
    pub check_params: HashMap<String, HashMap<String, String>>, // check_id → param_id → value
    // ...
}
```

The runner matches checks by string ID (`match id.as_str()`), not by `IssueKind`. Unknown check IDs return an error. Unknown param keys are silently ignored; missing params fall back to the check's default constant.

### QcRuleConfig

```rust
#[derive(Deserialize)]
pub struct QcRuleConfig {
    pub id: String,                       // opaque rule id, assigned by the web client
    pub checks: Vec<String>,              // check ids, must share one IssueKind
    pub strategy: Option<StrategyConfig>, // None = "no_fix"
}
```

One user-defined QC rule: a non-empty set of active checks producing the same `IssueKind`, sharing one repair strategy (or none — `strategy: None`, the rule's issues still merge for attribution but no `RepairStrategy` is dispatched). See `repair.md`'s "QcRule and rule-based RepairEngine" section for how this is validated and turned into core's `QcRule`/`RepairRuleConfig`.

`GenerateConfig::default()` ships one default rule: `{ id: "default_missing_endpoints", checks: ["missing_endpoints"], strategy: Some(farthest_endpoints) }`. `unreachable_finish` has no default rule.

### Available checks

| ID | Issue kind | Params | Default selected |
|----|------------|--------|-----------------|
| `missing_endpoints` | `missing_endpoints` | — | yes |
| `unreachable_finish` | `unreachable_finish` | — | yes |
| `min_loops_count` | `min_loops_count` | `min_loops: Integer(default=1, min=1, max=1_000_000)` | no |
| `min_loop_length` | `invalid_loop` | `min_loop_length: Integer(default=10, min=1, max=100_000)` | no |
| `max_loop_length` | `invalid_loop` | `max_loop_length: Integer(default=100, min=1, max=100_000)` | no |

Checks without params are auto-selected on `loadRegistry`. Checks with params are not auto-selected — the user must add them explicitly.

## Architectural Contract

Only code that owns the `Maze` may call `&mut self` accessors on `maze.analysis`. QC checks and repair strategies may read `maze.analysis` via shared reference but must not write to it.

`MazeAnalysis` caches derived data lazily. See `analysis.md` for the full contract.
