# Quality Control

A read-only analysis pass that detects problems in a `Maze` and produces a list of `Issue` values. Runs before and after each repair iteration in the pipeline.

## Core Concepts

### IssueKind

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IssueKind {
    MissingEndpoints,
    UnreachableFinish,
    InvalidLoop,
    MissingLoops,
    CycleAnalysisOverflowed,
    RepairLimitReached,
    QcNoProgress,
    ExcessiveSccCount,
    RegionNeedsExpansion,
    MissingRegions,
}
```

`LoopDistanceFromStartCheck`/`LoopDistanceFromFinishCheck` (below) reuse `InvalidLoop` — no new `IssueKind` variant, same as every other check flagging cycles invalid for a check-specific reason.

`MissingLoops` mirrors `InvalidLoop`'s role, but for a missing-count condition (too few loops overall) instead of a specific invalid cycle — currently produced only by `MinLoopsCountCheck`; future checks needing more loops added may reuse this kind rather than inventing a new one.

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
pub const INVALID_LOOP:       IssueKind = IssueKind::InvalidLoop;
pub const MISSING_LOOPS:      IssueKind = IssueKind::MissingLoops;
pub const CYCLE_ANALYSIS_OVERFLOWED: IssueKind = IssueKind::CycleAnalysisOverflowed;
```

`MissingRegions` mirrors `MissingLoops`'s role, but for a deficit in the count of regions of a specific `RegionClass` (Path/Alternative/Unreachable/Trap — see "Region Classes" in `graph-analytics.md`) instead of overall loop count — currently produced only by `MinRegionCountCheck`.

Always use the named constant — never use string literals or enum variants inline.

**Hard rule: `IssueKind` is a semantic category, not a producer id.** `InvalidLoop` means "this cycle is invalid for some check-specific reason" — it does not identify *which* check found it. Multiple checks can legitimately produce the same `IssueKind` for different underlying reasons — currently `MinLoopLengthCheck` (cycles shorter than a threshold) and `MaxLoopLengthCheck` (cycles longer than a threshold); future checks may flag cycles invalid for still other reasons and reuse this same kind rather than inventing a new one per reason. Which check(s) actually contributed to a given `Issue` is tracked separately, in `Issue.source_checks` (below) — never by adding more `IssueKind` variants.

`RegionNeedsExpansion` mirrors `InvalidLoop`'s role for SCC regions: a semantic category ("this region needs to be expanded for some check-specific reason"), not tied to size specifically or to any one reason. Currently produced by `MinRegionSizeCheck` (region smaller than a configured absolute tile count) and `MinRegionRatioCheck` (region smaller than a configured share of the field), but future checks may flag a region as needing expansion for reasons unrelated to size and reuse this same kind. Carries `IssueData::RegionsNeedingExpansion` — see that variant's doc comment.

**`CycleAnalysisOverflowed` is not a toggleable QC check** — every other kind here is produced by a `Check<T>` implementation the user selects via `config.checks`; this one is raised directly by `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) whenever `GraphAnalytics::cycle_analysis_overflowed` is true (cycle enumeration aborted past `MAX_SIMPLE_CYCLES` — see `graph-analytics.md`). It bypasses `QualityControlEngine` entirely: `build_analytics_snapshot` pushes `Issue::new(CYCLE_ANALYSIS_OVERFLOWED)` straight into the issue list after the engine (or `issues_override`) has already run, so it surfaces unconditionally — same `IssuesBlock`/`FeatureCard` UI as any other issue, but with no corresponding `Check<T>` or `RepairStrategy` and no way for a user to disable it. `IssueKind::from_str` still parses it like any other kind (used to validate `config.strategies` keys), but no strategy can ever be registered against it — see `from_str`'s doc comment.

### Issue

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub kind: IssueKind,
    pub data: Option<IssueData>,
    source_checks: Vec<String>, // private — see accessors below
    details: HashMap<String, HashMap<&'static str, String>>, // private — see accessors below
}

impl Issue {
    pub fn new(kind: IssueKind) -> Self;                                       // data: None, source_checks: []
    pub fn with_data(kind: IssueKind, data: IssueData) -> Self;                 // source_checks: []
    pub fn new_from_check(kind: IssueKind, source_check: &str) -> Self;
    pub fn with_data_from_check(kind: IssueKind, data: IssueData, source_check: &str) -> Self;
    /// Chainable — attaches one display detail under `source_check`. See `details()` below.
    pub fn with_detail(self, source_check: &str, key: &'static str, value: String) -> Self;
    pub fn source_checks(&self) -> &[String];
    /// `Some` only when there is exactly one source check (the normal raw, pre-merge case) —
    /// `None` for zero (e.g. `CYCLE_ANALYSIS_OVERFLOWED`) or 2+ sources (an already-merged
    /// issue, or a malformed raw one). Pipeline rule-routing uses this, not `source_checks()`
    /// indexing, so a malformed multi-source raw issue can't be silently misrouted by an
    /// arbitrary first id — see `repair.md`'s "Pipeline" section.
    pub fn single_source_check(&self) -> Option<&str>;
    pub fn details(&self) -> &HashMap<String, HashMap<&'static str, String>>;
    pub(crate) fn push_source(&mut self, source: &str); // merge_issue only
    pub(crate) fn merge_details(&mut self, incoming: HashMap<String, HashMap<&'static str, String>>); // merge_issue only
}
```

**`source_checks`/`details` carry a rule-scoped composite id, not a check type id** — see GitHub
issue #60. Two active configurations of the same check type (e.g. two `min_region_count`
instances, each with its own `region_class`/`count`) need distinct routing identity, so the
string here is `{rule_id}:{local_id}` (built once, by `composite_check_id()` in
`maze-wasm/src/runner.rs`, never reconstructed or parsed back apart anywhere in `maze_core`).
`Issue` stays exactly as rule-agnostic as before this change — it still has no `rule_id` field
and no concept of rules; the string it carries simply happens to be built from one outside this
crate. Treat it as opaque: compare and pass it through, never split on `:`.

`Issue` derives `PartialEq` but not `Eq` — `IssueData` is not `Eq` (future variants are expected to carry `f64` fields, e.g. weights/scores).

`Issue` is mostly an **internal QC artifact** — `data` is plumbing between a `Check` and the matching `RepairStrategy` within one QC pass and is never serialized (see "Not exposed over WASM" below). `kind`, `source_checks`, and `details` are the exception: the WASM layer (`maze-wasm/src/analytics.rs`) does serialize these three into `IssueDto` for the web UI (see `quality-feature.md`), since the UI needs to know which check(s) produced an issue and render a check-specific message. Keep this boundary explicit when extending `Issue`: a genuinely display-only payload belongs in `details` (generic, serialized), not `data` (kind-specific, repair-only, never serialized).

`source_checks` (private field, read via `source_checks()`) records which check instance(s)
(rule-scoped composite ids — see above) produced or contributed to this issue. Every toggleable
`Check<T>` implementation should construct its issues via `new_from_check`/`with_data_from_check`,
passing its own `instance_id` field (set externally at construction time by
`maze-wasm/src/runner.rs::build_check`, since core itself never mints these ids). The one
exception is `CYCLE_ANALYSIS_OVERFLOWED`, pushed directly by `build_analytics_snapshot` outside
any `Check<T>` (see its doc comment below) — it has no check id to attribute to, so it uses plain
`Issue::new` and `source_checks` stays empty. When two issues of the same kind are merged (see
"Dedup interaction" below), `source_checks` is unioned without duplicates via `push_source` — the
field is private specifically so nothing outside `merge_issue` can append to it or construct an
`Issue` with an already-multi-source list before merge has legitimately produced one (a raw,
pre-merge issue is expected to carry exactly one source check; `single_source_check()` is the
type-level enforcement of that for rule-routing).

`details` (private field, read via `details()`, written via the chainable `with_detail`) carries
**raw display values only** — e.g. a check's configured threshold as a string — keyed by source
check instance id (the same composite string as `source_checks`), then by detail key (e.g.
`"rule_3:0" -> {"max_loop_length" -> "100"}`). Never an assembled message: wording belongs
entirely to the web UI's own i18n layer, which looks values up by key per check **type** (see
`quality-feature.md`'s issue rendering section — the web side needs `IssueDto.source_check_types`
to recover the type id from the composite instance id for this lookup). Keyed by check instance
rather than flattened because a merged `Issue` (see "Dedup interaction" below) may carry details
from several contributing checks at once — e.g. both `min_loop_length`'s and `max_loop_length`'s
thresholds on one merged `INVALID_LOOP` issue, or two `min_region_count` instances' thresholds on
one merged `MISSING_REGIONS` issue — and the UI renders one bubble per source check, each reading
only its own check's details. On merge, `merge_details` (`merge_issue`-only, mirroring
`push_source`) folds `incoming`'s per-check entries into `existing`'s; since a raw (pre-merge)
issue only ever has its own check instance id as a key, there is no same-key collision to
reconcile, just a union across checks.

### IssueData

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum IssueData {
    TestPayload(Vec<u64>),       // temporary infra-only variant, see below
    InvalidLoops {                // produced by any check flagging cycles invalid, see below
        all: Vec<Vec<EdgeId>>,
        invalid: Vec<usize>,
        invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
    },
    Missing {                     // produced by any check flagging too few loops, see below
        missing: u32,
    },
    RegionsNeedingExpansion {            // produced by any check flagging SCC regions needing expansion, see below
        invalid: Vec<usize>,
        invalid_sources: HashMap<usize, Vec<String>>,
    },
    MissingRegions {               // produced by MinRegionCountCheck, region balance per class, see below
        balance_by_class: HashMap<RegionClass, i32>,
    },
}
```

`data` is a **per-kind payload** a `Check` may attach to an `Issue` it produces, carrying findings discovered during detection (e.g. candidate nodes, conflicting edges) for a matching `RepairStrategy` to use.

- **Whether `data` is required is a per-`IssueKind` decision, not a global rule.** Some kinds have no data variant at all. Some have one that's a genuine optimization (the strategy can cheaply recompute the same thing itself if `data` is absent). Some have one that's effectively mandatory — the data *is* the result of work too expensive to duplicate in the strategy, and there is no other channel to give the strategy what it needs. Each `RepairStrategy::apply` documents and decides for itself what `None`/wrong-variant `data` means for its own kind — there is no blanket "data is always optional" contract to fall back on.
- **Lifecycle**: `IssueData` is valid only for the Check → Strategy pair within a single QC pass. It is never carried across pipeline iterations and must not be retained by a strategy after `apply` returns — the maze may have mutated since.
- **Kind↔data invariant** (documentation-only, not runtime-checked — consistent with other contracts in this module): each `IssueKind` is expected to use a specific, fixed set of `IssueData` variants. It is the responsibility of the `Check`/`RepairStrategy` author to keep kind and data variant in sync.
- **`TestPayload`**: a temporary, infra-only variant not tied to any real `IssueKind`, used to exercise `Clone`/equality on a non-trivial owned payload. Marked `// TODO` in code for removal once a first real variant lands.
- **`InvalidLoops { all, invalid, invalid_sources }`**: produced by any check that flags simple cycles invalid for a check-specific reason (paired with `INVALID_LOOP`) — currently `MinLoopLengthCheck` (cycles shorter than a configured threshold) and `MaxLoopLengthCheck` (cycles longer than a configured threshold), **mandatory** for this kind, see `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy` in `repair.md`. `all` holds **every** simple cycle found in the maze, valid and invalid alike, each as the **set** of base-`Graph` edges forming it — element order carries no meaning beyond membership, only used as a convenient container, and `EdgeId` values never repeat within one cycle. `invalid` is the subset of indices into `all` that the producing check(s) flagged — the cycles a repair strategy must actually break. An empty `invalid` is valid and means no cycle was flagged (`all` may still be non-empty in that case). Future checks may flag cycles invalid for reasons other than length and reuse this same variant, rather than introducing a new one per reason — see the `IssueKind` hard rule above.
- **`invalid_sources`**: per-cycle check attribution, keyed by `canonical_cycle_key` (the cycle's edge set, sorted) rather than by index into `all` — indices get remapped on every merge (see `merge_invalid_loops` in `repair.md`'s "Pipeline" section), but a cycle's canonical key is stable across merges, so this map never needs remapping. Maps a cycle to the check instance composite id(s) (see "Issue" above) that flagged it invalid. A cycle absent from this map was flagged by no check directly tracked — shouldn't happen for entries in `invalid`, but the map is not required to cover every index; absence means "no recorded source," not an error.
- Keeping the valid cycles in `all` (not just the invalid ones) lets a strategy avoid cutting an edge that is also part of a cycle the maze is meant to keep — see `InvalidLoopScoredStrategy` in `repair.md`.
- **`Missing { missing }`**: produced by any check that flags the maze as short on loops overall (paired with `MISSING_LOOPS`) — currently only `MinLoopsCountCheck`. `missing` is how many loops short of the requirement the maze is (`min_loops.saturating_sub(graph_analytics.cycle_count)` — the independent-cycle count, see `MinLoopsCountCheck` below), letting a repair strategy know how many to add. No merge rule defined yet — currently only one check ever produces `MISSING_LOOPS`, so the dedup/merge path is never exercised for this variant.
- **`RegionsNeedingExpansion { invalid, invalid_sources }`**: produced by any check that flags SCC regions undersized for a check-specific reason (paired with `REGION_NEEDS_EXPANSION`) — currently `MinRegionSizeCheck` (region smaller than a configured absolute tile count) and `MinRegionRatioCheck` (region smaller than a configured share of the field). `invalid` holds indices into `maze.analysis.scc(&maze.graph).components` — not a copy of the regions themselves: that computation is already cached there (keyed by `graph.version()`, see `analysis.md`), and a future repair strategy can re-fetch it (cache hit within the same QC pass) instead of `Issue` carrying a duplicate snapshot. `invalid_sources` is keyed by the same component index — unlike `invalid_sources` on `InvalidLoops`, this needs no remap on merge, because every check sharing this issue within one QC pass reads from the same single `scc()` cache entry, so a given index means the same region on both sides of a merge (see `merge_regions_needing_expansion` in `repair.md`'s "Pipeline" section). No `RepairStrategy` registered yet for this kind — same "detectable, not yet repairable" status `EXCESSIVE_SCC_COUNT` has.
- **`MissingRegions { balance_by_class }`**: produced by `MinRegionCountCheck` (paired with `MISSING_REGIONS`) — carries the **region balance** per `RegionClass` (Path/Alternative/Unreachable/Trap, see `graph-analytics.md`'s "Region Classes" section). `-N` means the maze is short `N` regions of that class against its configured minimum — a repair strategy must create or convert regions into it. `+N` means the class has `N` regions *above* its minimum — a spendable surplus a repair strategy may consume (reuse outright, or merge into an undersized candidate of the same class) when fixing a different class's shortfall. A class sitting exactly at its minimum, or with no minimum configured (`min_count == 0`), carries **no entry at all** — absence means "nothing to fix, nothing to spend" for that class, not a `0` entry. Since GitHub issue #60's multi-instance design is retired, a single `MinRegionCountCheck` instance now evaluates all four classes' counts in one pass and produces one `Issue` with every off-target class's balance already in `balance_by_class` — no cross-instance merge happens in the common case (there's normally exactly one active instance), though `merge_missing_regions` (see `repair.md`'s "Pipeline" section) still unions two instances' output if more than one is ever active at once, taking the value **further from zero** for a class present on both sides. `HashMap` iteration order is not stable — code that serializes or displays `balance_by_class` (the wasm DTO layer, the web UI) sorts by `RegionClass::as_str()` at the point of use rather than relying on map order, without needing an `Ord` derive on `RegionClass` itself for this one call site.
- **`data` is not exposed over WASM**: the WASM layer serializes `IssueKind`, `source_checks`, and `details` (see `IssueDto` in `quality-feature.md`) but never `Issue.data` itself — that field stays internal, Check-to-Strategy plumbing only.
- **Dedup interaction**: multiple checks may produce an `Issue` of the same `IssueKind` in one QC pass. The pipeline (see `repair.md`'s "Pipeline" section) **merges** them into a single `Issue` rather than keeping only the first and dropping the rest — this replaces an earlier dedup-by-first-occurrence design that silently lost a second issue's `data`. The merge rule is per-`IssueData`-variant: for `InvalidLoops`, cycles are merged canonically (a cycle is identified by its edge set, not by `Vec` order, so the same cycle found by two checks collapses to one entry instead of being duplicated); `invalid_sources` is unioned per canonical key (no remap needed); `source_checks` and `details` (on `Issue`, see above) are unioned. A combination of `IssueData` variants with no defined merge rule is a `debug_assert!`/panic in debug builds, not a silent pick-one-side fallback.

### Check trait

```rust
pub trait Check<T: Tessellation> {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, rng: &mut dyn RngCore);
}
```

- **Read-only**: `maze` is immutable. A `Check` must not mutate any state.
- **No side effects**: `check` must not access global state or perform I/O.
- **`rng` is the one sanctioned source of non-determinism**: most checks ignore it (`_rng`) and stay fully deterministic, but a check whose contract is inherently randomized — currently only `MaxLoopDensityCheck` (below), which must pick *which* excess loops to flag without a deterministic ordering rule — draws from it instead of seeding its own. `QualityControlEngine::run` takes the `rng` from its caller (the pipeline's per-`build_maze`-call `MazeRng`, seeded from the generation seed) rather than each check owning one, so a whole QC pass stays reproducible for a given seed.
- A check may produce zero or more issues per call.
- A check may read `maze.analysis` to avoid redundant computation.

### QualityControlEngine

```rust
pub struct QualityControlEngine<T: Tessellation> {
    checks: Vec<Box<dyn Check<T>>>,
}

impl<T: Tessellation> QualityControlEngine<T> {
    pub fn new(checks: Vec<Box<dyn Check<T>>>) -> Self;
    pub fn run(&self, maze: &Maze<T>, rng: &mut dyn RngCore) -> Vec<Issue>;
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

Counts loops via `maze.analysis.graph_analytics(&maze.graph, &maze.meta).cycle_count` — the **independent** cycle count (Euler's formula, `E - V + C` on the pure-cycle core, see `graph-analytics.md`), the same number shown to the user as the "Cycle count" analytics stat. Deliberately **not** `find_deduped_simple_cycles`'s raw simple-cycle enumeration: that is a different (usually much larger) metric, and using it here would make this check disagree with what the UI displays as the maze's loop count. Silently skips (no issue) when `graph_analytics.cycle_analysis_overflowed` is true, same overflow rationale as the simple-cycle checks below (shared underlying enumeration). If `cycle_count` is below `min_loops`, fires `Issue::with_data_from_check(MISSING_LOOPS, IssueData::Missing { missing }, "min_loops_count")` with `.with_detail("min_loops_count", "missing", missing.to_string())` chained on, where `missing = min_loops.saturating_sub(cycle_count)`. No issue is fired when the count meets or exceeds `min_loops`.

### MinLoopDensityCheck

```rust
pub const MIN_LOOP_DENSITY_DEFAULT: u32 = 30;
pub const AVG_LOOP_LENGTH_ESTIMATE_DEFAULT: u32 = 10;

pub struct MinLoopDensityCheck {
    pub min_density: u32,
    pub avg_loop_length_estimate: u32,
}
```

Flags too few loops when too small a share of the field is covered by loops overall — see GitHub issue #36. Symmetric counterpart to `MaxLoopDensityCheck` (below): same **density** metric (count of distinct field cells covered by any simple loop, a cell shared by several loops counted once, expressed per 100 field cells via `maze.field.node_count()`), same cycle enumeration pipeline (`nav_graph` → `find_deduped_simple_cycles` → `resolve_to_edge_ids`), same silent skip on `CycleSearchResult::TooManyCycles` overflow — but checked against a **minimum** instead of a maximum, and producing `MISSING_LOOPS` (a loop-count deficit) instead of `INVALID_LOOP` (specific cycles to cut), since adding loops rather than removing them is the only way to raise coverage.

If density is at or above `min_density`, the check is silent, same as every other loop check producing no issue when nothing is wrong. If density is below `min_density`, the deficit is converted from a cell count into a loop count: `missing_cells = (min_density - density) * field_cells / 100`, then `missing = ceil(missing_cells / avg_loop_length_estimate)` — rounded up so the request never undershoots the actual deficit (the repair strategy can always add more loops than asked, but never fewer to safely close the gap, since `avg_loop_length_estimate` is only an estimate, not a guarantee any newly added loop covers exactly that many cells). If `missing` rounds to `0` (deficit too small relative to the estimate), no issue is fired.

Fires `Issue::with_data_from_check(MISSING_LOOPS, IssueData::Missing { missing }, "min_loop_density")` with `.with_detail("min_loop_density", "missing", missing.to_string())` chained on — same detail key as `MinLoopsCountCheck`, so the web UI's per-source-check label resolver can render both with one shared message shape. Repaired the same way as `MinLoopsCountCheck`'s `MISSING_LOOPS` issues — `MissingLoopsRandomStrategy` (see `repair.md`) needs no new logic, since both checks produce the same `IssueData::Missing` shape.

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

If any cycles below the threshold are found (`invalid` non-empty), fires a single `Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid }, "min_loop_length")` with `.with_detail("min_loop_length", "min_loop_length", self.min_loop_length.to_string())` chained on — the configured threshold, for the web UI to render a specific message ("loop shorter than N tiles") instead of the generic `INVALID_LOOP` label. No issue is fired if `invalid` is empty, even if `all` is not. Other checks may also produce `INVALID_LOOP` issues for different reasons in the same pass — see the pipeline's merge behavior in `repair.md`.

### MaxLoopLengthCheck

```rust
pub const MAX_LOOP_LENGTH_DEFAULT: u32 = 100;

pub struct MaxLoopLengthCheck {
    pub max_loop_length: u32,
}
```

Symmetric counterpart to `MinLoopLengthCheck` — same cycle enumeration pipeline (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs` → tile-length filter → `resolve_to_edge_ids`), same silent skip on `CycleSearchResult::TooManyCycles` overflow, same `IssueData::InvalidLoops` shape. The only difference: the filter keeps cycles whose tile-length is **above** `max_loop_length` (`tile_length > max_loop_length`) instead of below a minimum.

If any cycles above the threshold are found (`invalid` non-empty), fires a single `Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid }, "max_loop_length")` with `.with_detail("max_loop_length", "max_loop_length", self.max_loop_length.to_string())` chained on, same rationale as `MinLoopLengthCheck` above. No issue is fired if `invalid` is empty. Both `MinLoopLengthCheck` and `MaxLoopLengthCheck` can be active at once — they each populate their own `invalid` subset and the pipeline merges the two `INVALID_LOOP` issues canonically (see "Dedup interaction" above and `repair.md`'s "Pipeline" section); the merged issue then carries both checks' details, and the UI renders one bubble per source check.

### ExternalEscapeDiversityCheck

```rust
pub const EXTERNAL_ESCAPE_DIVERSITY_DEFAULT: u32 = 3;

pub struct ExternalEscapeDiversityCheck {
    pub min_distinct_exits: u32,
}
```

Detects cycles that are "locally trapped" despite having many outgoing connections — see issue #32. Uses the same enumeration pipeline as `MinLoopLengthCheck`/`MaxLoopLengthCheck` (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs`, same silent skip on `CycleSearchResult::TooManyCycles`), but the filter is purely topological rather than length- or geometry-based: for each cycle, collect the set of cycle vertices (nav-nodes touched by any of its nav-edges), then count the distinct nav-nodes outside that set reached by a direct outgoing nav-edge from any cycle vertex (`distinct_exit_count`). No further traversal past that one hop, no geometry, no connected-component analysis on the rest of the graph — a cycle with 8 outgoing edges that all land on the same external node scores 1, not 8.

If any cycle's distinct exit count is below `min_distinct_exits`, fires a single `Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid }, "external_escape_diversity")` with `.with_detail("external_escape_diversity", "min_distinct_exits", self.min_distinct_exits.to_string())` chained on. No issue is fired if `invalid` is empty. Can be active alongside `MinLoopLengthCheck`/`MaxLoopLengthCheck` — all three merge into one `INVALID_LOOP` issue per the same dedup rule.

### LoopDistanceFromStartCheck

```rust
pub const LOOP_DISTANCE_FROM_START_DEFAULT: u32 = 0;

pub struct LoopDistanceFromStartCheck {
    pub min_distance_from_start: u32,
}
```

Flags simple cycles placed too close to `meta.start` in progression space — see GitHub issue #33. Uses `maze.analysis.distance_from_start` (`HashMap<NavNodeId, usize>`, tile distance, lazily computed and cached — see `graph-analytics.md`'s "Distance Maps" section), then the same cycle enumeration pipeline as the other loop checks (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs`, same silent skip on `CycleSearchResult::TooManyCycles`). A cycle's distance from start is the **minimum** tile distance among all nav-nodes the cycle touches (every `from`/`to` endpoint of its nav-edges) — the cycle's closest point to start, not its average or farthest — computed by `cycle_min_distance` (`maze-core/src/graph/distance_map.rs`), the single shared reduction `LoopDistanceFromFinishCheck` (below) reuses too, rather than each check carrying its own copy. A nav-node unreachable from start is excluded from that minimum; if every touched nav-node is unreachable the cycle is treated as having no defined distance and never flagged.

Silently skips (no issue, no panic) if `meta.start` is unset — `distance_from_start` returns `None` in that case, and that failure mode belongs to `MissingEndpointsCheck`, not this check.

Default `0` never fires on its own — the threshold has no natural default (unlike a tile-length minimum), so the check is a no-op until a user picks a value. If any cycles closer than the threshold are found, fires a single `Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid }, "loop_distance_from_start")` with `.with_detail("loop_distance_from_start", "min_distance_from_start", self.min_distance_from_start.to_string())` chained on. Can be active alongside any other `INVALID_LOOP`-producing check — all merge into one issue per the same dedup rule.

### LoopDistanceFromFinishCheck

```rust
pub const LOOP_DISTANCE_FROM_FINISH_DEFAULT: u32 = 0;

pub struct LoopDistanceFromFinishCheck {
    pub min_distance_from_finish: u32,
}
```

Symmetric counterpart to `LoopDistanceFromStartCheck` — flags simple cycles placed too close to `meta.finish` instead. Uses `maze.analysis.distance_from_finish` (distance **to** finish, following directed edges backward), same cycle enumeration pipeline, same "minimum among touched nav-nodes" rule, same silent skip on missing `meta.finish` or `TooManyCycles` overflow.

Fires `Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid }, "loop_distance_from_finish")` with `.with_detail("loop_distance_from_finish", "min_distance_from_finish", self.min_distance_from_finish.to_string())` chained on.

### MaxLoopDensityCheck

```rust
pub const MAX_LOOP_DENSITY_DEFAULT: u32 = 30;

pub struct MaxLoopDensityCheck {
    pub max_density: u32,
}
```

Flags excess simple loops when too large a share of the field is covered by loops overall — see GitHub issue #37. Unlike the other loop checks, this one judges the maze's loops as a set rather than each cycle independently.

Same cycle enumeration pipeline as the other loop checks (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs`, same silent skip on `CycleSearchResult::TooManyCycles` overflow), then resolves every cycle to its base-`Graph` `EdgeId`s via `resolve_to_edge_ids` same as the others, but additionally maps each cycle's edges to the set of base-`Graph` `NodeId`s (cells) its edges touch. **Density** is the count of distinct field cells covered by any loop (a cell shared by several loops counts once), expressed per 100 field cells (`maze.field.node_count()`): `covered_cells * 100 / field_cells`. If density is at or below `max_density`, the check is silent — same as every other loop check producing no issue when nothing is wrong.

If density exceeds `max_density`, the check must pick which loops to flag — there is no single deterministic "worst" loop the way there is a shortest/longest one, so it shuffles the cycle indices via the `rng` passed into `check` (see the `Check` trait's `rng` note above) and flags them one at a time in that random order, recomputing the remaining covered-cell count after each pick: removing a loop only frees the cells not also covered by another loop not yet picked, so the running total is the *set difference* against the still-unselected loops' coverage, not a flat per-loop cell count. Picking stops as soon as the remaining density is at or below `max_density`, or once every loop has been picked (covers the case where even flagging all of them can't reach an unusually low `max_density`). The picked indices become `invalid`.

Fires a single `Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid, invalid_sources }, "max_loop_density")` with `.with_detail("max_loop_density", "max_density", self.max_density.to_string())` chained on. Can be active alongside any other `INVALID_LOOP`-producing check — all merge into one issue per the same dedup rule. The flagged loops need no new repair logic — `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy` cut them exactly like any other check's `invalid` entries.

### SccCountCheck

```rust
pub const MAX_SCC_COUNT_DEFAULT: u32 = 1;

pub struct SccCountCheck {
    pub max_scc_count: u32,
}
```

Flags an excessively fragmented graph — see GitHub issue #48. Uses `maze.analysis.scc(&maze.graph)` (cached per `graph.version()` — see `analysis.md`), itself backed by `build_scc` (`maze-core/src/graph/scc.rs`, Tarjan's algorithm), rather than re-implementing or directly recomputing SCC; counts `ConnectedComponents::components.len()`. If the count is at or below `max_scc_count`, the check is silent. If it exceeds `max_scc_count`, fires `Issue::new_from_check(EXCESSIVE_SCC_COUNT, "scc_count")` with `.with_detail("scc_count", "max_scc_count", self.max_scc_count.to_string())` and `.with_detail("scc_count", "scc_count", count.to_string())` chained on — both raw values for the web UI to render a specific message.

No `IssueData` variant and no registered `RepairStrategy` yet — `EXCESSIVE_SCC_COUNT` is a detectable-but-not-yet-repairable issue kind, same as any other kind with `strategy: None` in its `QcRuleConfig` (see `repair.md`'s "QcRule and rule-based RepairEngine" section).

### MinRegionSizeCheck

```rust
pub const MIN_REGION_SIZE_DEFAULT: u32 = 20;

pub struct MinRegionSizeCheck {
    pub min_region_size: u32,
    pub region_classes: Vec<RegionClass>,
}
```

Flags SCC regions with fewer tiles than a configured absolute minimum — see GitHub issue #50. Uses `maze.analysis.scc(&maze.graph)` (same cache `SccCountCheck` reads), and flags every component whose `len()` is below `min_region_size`. If no region is undersized, the check is silent. Otherwise fires a single `Issue::with_data_from_check(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid, invalid_sources }, "min_region_size")` with `.with_detail("min_region_size", "min_region_size", self.min_region_size.to_string())` chained on — `invalid` holds every undersized component's index into `scc.components`.

`region_classes` restricts the check to SCC regions of the listed `RegionClass`(es) (Path/Alternative/Unreachable/Trap — see `graph-analytics.md`'s "Region Classes" section) — see GitHub issue #54. Empty means no region matches (the check is always silent). All four classes (`ALL_REGION_CLASSES`, the wasm layer's `"all"` dropdown option) means every region is checked, the pre-#54 behavior, and skips computing `RegionClass`es entirely (no `start`/`finish` requirement in that case). For any other non-empty subset, the check additionally needs `maze.analysis.region_classes(&maze.graph, start, finish)` to look up each component's class; if either `maze.meta.start` or `maze.meta.finish` is `None`, the check is silent (classification unavailable — same failure mode `MinRegionCountCheck` has).

### MinRegionRatioCheck

```rust
pub const MIN_REGION_RATIO_DEFAULT: u32 = 25;

pub struct MinRegionRatioCheck {
    pub min_region_ratio: u32,
    pub region_classes: Vec<RegionClass>,
}
```

Counterpart to `MinRegionSizeCheck` using a relative threshold instead of an absolute tile count — see GitHub issue #50. Flags every SCC region covering less than `min_region_ratio` percent of the field (`maze.field.node_count()`): `region.len() * 100 < min_region_ratio * field_cells`. Silently skips (no issue) if the field has zero cells. If no region is undersized, the check is silent. Otherwise fires a single `Issue::with_data_from_check(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid, invalid_sources }, "min_region_ratio")` with `.with_detail("min_region_ratio", "min_region_ratio", self.min_region_ratio.to_string())` chained on.

`region_classes` works exactly as for `MinRegionSizeCheck` above — see GitHub issue #54.

Can be active alongside `MinRegionSizeCheck` — both produce `REGION_NEEDS_EXPANSION` and merge into one issue (see `merge_regions_needing_expansion` in `repair.md`'s "Pipeline" section): since both checks read the same `scc()` cache entry within one QC pass, a region's component index is stable across the merge, so unioning `invalid` and `invalid_sources` needs no remap, unlike the cycle-index remap `merge_invalid_loops` must do.

### MinRegionCountCheck

```rust
pub const MIN_REGION_COUNT_DEFAULT: u32 = 0;

pub struct MinRegionCountCheck {
    pub min_counts: HashMap<RegionClass, u32>,
}
```

Flags a region-count shortfall or surplus per `RegionClass` (Path/Alternative/Unreachable/Trap — see `graph-analytics.md`'s "Region Classes" section) — see GitHub issue #55 and issue #59's "Region Balance" data model. Lets a user enforce structural variety (e.g. guarantee at least N trap or alternative-route regions) instead of only constraining individual region size/ratio, and lets `MissingRegionsStrategy` (see `repair.md`) spend any class's surplus above its minimum when fixing a different class's shortfall.

A single instance carries one `min_count` threshold per class (`MIN_REGION_COUNT_DEFAULT = 0` — unset, that class is never checked either way). Unlike before GitHub issue #60 (retired), there is normally exactly **one** active instance: it evaluates all four classes' counts in one pass rather than needing one instance per class.

Uses `maze.analysis.region_classes(&maze.graph, start, finish)` and counts entries per class. Silently skips (no issue) if either `maze.meta.start` or `maze.meta.finish` is `None` — same as `UnreachableFinishCheck`/the loop-distance checks, that failure mode belongs to `MissingEndpointsCheck`, not this check. For each class with a non-zero configured minimum, computes `balance = count as i64 - min_count as i64`; a class at exactly its minimum (`balance == 0`) is omitted from the result entirely — only off-target classes are reported, each as `+N` (surplus) or `-N` (shortfall). If every configured class is at its minimum, the check is silent. Otherwise fires `Issue::with_data_from_check(MISSING_REGIONS, IssueData::MissingRegions { balance_by_class }, "min_region_count")` with `.with_detail("min_region_count", "region_classes", <comma-joined list of off-target classes>)` chained on.

`MissingRegionsStrategy` (see `repair.md`) is the registered `RepairStrategy` for `MISSING_REGIONS`: it creates/converts regions for every `-N` class, optionally spending `+N` surplus from other classes via cross-region growth or reuse-merge to reach a configured `min_region_size`.

## WASM Interface

The WASM layer exposes check metadata and accepts check configuration from the frontend.

### IssueDto

Serialized to JSON in `MazeSnapshot.issues` (`build_analytics_snapshot`, `maze-wasm/src/analytics.rs`) for every `Issue` the QC pass (or `issues_override`) produced:

```rust
struct IssueDto {
    kind: String,                                       // IssueKind::as_str()
    invalid_loop_edges: HashMap<String, Vec<Vec<[u32; 2]>>>, // invalid_loop only, keyed by source check instance id
    region_needs_expansion_nodes: HashMap<String, Vec<Vec<u32>>>, // region_needs_expansion only, keyed by source check instance id
    source_checks: Vec<String>,                          // Issue::source_checks() — opaque composite instance ids
    source_check_types: HashMap<String, String>,         // source_checks entry -> check type id
    details: HashMap<String, HashMap<String, String>>,   // Issue::details()
}
```

`source_checks` and `details` are the serialized form of `Issue`'s same-named accessors (see
"Issue" above) — the web UI uses them to render one bubble per contributing check, each with a
check-specific label built from that check's own `details` entry (see `quality-feature.md`).
`details` values are raw (numbers as strings, etc.) — the UI owns all wording.

`source_checks` entries are opaque per-**instance** composite ids (`{rule_id}:{local_id}`), not
check type ids — two active instances of the same type (e.g. two `min_region_count`s, see GitHub
issue #60) need distinct entries here. The web UI's per-check-type label lookup (`DETAIL_LABELS`
in `issueRegistry.ts`) keys off the check's **type**, not its instance, so `source_check_types`
maps each `source_checks` entry back to its type id. Built in `build_analytics_snapshot`
(`maze-wasm/src/analytics.rs`) from the same composite-id-to-type-id map `runner.rs` already
builds while constructing the active checks for this pass — invariant: exactly one
`source_check_types` entry per distinct id appearing anywhere in any issue's `source_checks` for
this snapshot, no extras.

`invalid_loop_edges` is keyed by source check instance id, not one flat list — a merged
`invalid_loop` issue may carry cycles from several checks at once (e.g. both `min_loop_length`'s
short loops and `max_loop_length`'s long loops), and each is attributed to its own check's entry
so the UI can highlight only the cycles relevant to the bubble being hovered, not every
contributing check's cycles combined. Built by looking up each invalid cycle's canonical key
(`canonical_cycle_key`) in `IssueData::InvalidLoops.invalid_sources` to find which check(s)
flagged it — the same attribution map `merge_invalid_loops` (`repair.md`'s "Pipeline" section)
already maintains across merges. A check instance id absent from `invalid_loop_edges` (or the
whole map empty) means that check flagged no cycles, or the issue isn't `invalid_loop`.

`region_needs_expansion_nodes` mirrors `invalid_loop_edges`'s role for `region_needs_expansion`
issues (currently produced by `MinRegionSizeCheck`/`MinRegionRatioCheck`) — keyed by source
check instance id for the same reason, so hovering one check's bubble highlights only the
regions that check flagged. Each inner `Vec<u32>` is one flagged region's member maze node ids
(not edges — the web client derives the region's perimeter and fill client-side from this node
set, the same way it derives preset boundary walls from a cell set; see
`IssueHighlightOverlay.ts`/`issueHighlightSelectors.ts`). Built from
`IssueData::RegionsNeedingExpansion.invalid` (indices into
`maze.analysis.scc(&maze.graph).components`) and `invalid_sources` (keyed by component index, no
remap needed within one QC pass — see `IssueData::RegionsNeedingExpansion`'s doc comment above).
A check instance id absent from `region_needs_expansion_nodes` means that check flagged no
regions, or the issue isn't `region_needs_expansion`.

### CheckDescriptor

Serialized to JSON by `available_checks()`:

```rust
struct CheckDescriptor {
    id: &'static str,           // check type id — used as CheckInstanceConfig.type_id
    label: &'static str,        // human-readable name
    description: &'static str,  // human-readable description
    issue_kinds: Vec<&'static str>, // IssueKind::as_str() values this check may produce
    params: Vec<ParamDescriptor>,
    allow_multiple_instances: bool, // see below
}
```

**`allow_multiple_instances`** gates whether the web store/UI permit more than one independent
active configuration of this check type at once (across rules, or within the same rule) — see
GitHub issue #60. `true` only for `min_region_count`: a second instance with a different
`region_class` is a legitimate, common configuration (e.g. "at least 2 trap regions" AND
separately "at least 2 alternative regions"). Every other check stays `false` — single active
instance at a time, same restriction that existed before #60's refactor. This is enforced
store-side (`addCheck`/`createRule` in `generationSlice.ts`) and mirrored in the UI's candidate
filtering (`RulesColumn.candidatesFor`, `CheckSelectDialog`) — wasm/core themselves don't reject
a duplicate `type_id` across instances; `QualityControlEngine` runs every configured instance
unconditionally regardless of this flag, since nothing in the QC/repair pipeline depends on it
being correct.

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
    pub check_rules: Vec<QcRuleConfig>, // rule configs — see below
    // ...
}
```

Checks exist only inside `check_rules` — there is no separate flat check list or global param
dict (removed as part of GitHub issue #60; see `quality-feature.md`'s store-side model for the
matching web-side shape). The runner matches each check instance by its `type_id` string
(`match type_id.as_str()`), not by `IssueKind`. Unknown `type_id` values return an error. Unknown
param keys are silently ignored; missing params fall back to the check's default constant.

### QcRuleConfig

```rust
#[derive(Deserialize)]
pub struct CheckInstanceConfig {
    pub local_id: String,                  // unique only within this rule's `checks`, not globally
    pub type_id: String,                   // check type id — available_checks()'s CheckDescriptor.id
    pub params: HashMap<String, String>,   // this instance's own param overrides
}

#[derive(Deserialize)]
pub struct QcRuleConfig {
    pub id: String,                        // opaque rule id, assigned by the web client
    pub checks: Vec<CheckInstanceConfig>,  // check instances, must share one IssueKind
    pub strategy: Option<StrategyConfig>,  // None = "no_fix"
}
```

One user-defined QC rule: a non-empty set of active check **instances** producing the same
`IssueKind`, sharing one repair strategy (or none — `strategy: None`, the rule's issues still
merge for attribution but no `RepairStrategy` is dispatched). Two instances of the same
`type_id` in the same rule (or in different rules) is a normal, fully supported case — see
GitHub issue #60 — not deduplicated anywhere in this pipeline; `QualityControlEngine` runs every
instance independently and completely. `local_id` only needs to be unique within its own rule's
`checks` array — `maze-wasm/src/runner.rs::build_qc_and_repair` rejects a config with a
duplicate `local_id` inside one rule (`"rule {id} has duplicate local_id: {local_id}"`), as a
defense against malformed/hand-edited configs; the web store's own monotonic per-rule counter
already guarantees this never happens via normal UI flow. See `repair.md`'s "QcRule and
rule-based RepairEngine" section for how a `QcRuleConfig` is validated and turned into core's
`QcRule`/`RepairRuleConfig`.

`GenerateConfig::default()` ships one default rule: `{ id: "default_missing_endpoints", checks: [{ local_id: "missing_endpoints", type_id: "missing_endpoints", params: {} }], strategy: Some(farthest_endpoints) }` — `local_id == type_id` here is a deliberate special case for this fixed bootstrap singleton, not a general pattern. `unreachable_finish` has no default rule.

### Available checks

| ID | Issue kind | Params | Default selected |
|----|------------|--------|-----------------|
| `missing_endpoints` | `missing_endpoints` | — | yes |
| `unreachable_finish` | `unreachable_finish` | — | yes |
| `min_loops_count` | `missing_loops` | `min_loops: Integer(default=1, min=1, max=1_000_000)` | no |
| `min_loop_density` | `missing_loops` | `min_density: Integer(default=30, min=0, max=100)`, `avg_loop_length_estimate: Integer(default=10, min=1, max=100_000)` | no |
| `min_loop_length` | `invalid_loop` | `min_loop_length: Integer(default=10, min=1, max=100_000)` | no |
| `max_loop_length` | `invalid_loop` | `max_loop_length: Integer(default=100, min=1, max=100_000)` | no |
| `external_escape_diversity` | `invalid_loop` | `min_distinct_exits: Integer(default=3, min=0, max=1_000)` | no |
| `loop_distance_from_start` | `invalid_loop` | `min_distance_from_start: Integer(default=0, min=0, max=100_000)` | no |
| `loop_distance_from_finish` | `invalid_loop` | `min_distance_from_finish: Integer(default=0, min=0, max=100_000)` | no |
| `max_loop_density` | `invalid_loop` | `max_density: Integer(default=30, min=0, max=100)` | no |
| `scc_count` | `excessive_scc_count` | `max_scc_count: Integer(default=1, min=1, max=1_000_000)` | no |
| `min_region_size` | `region_needs_expansion` | `min_region_size: Integer(default=20, min=1, max=1_000_000)`, `region_class: Enum(options=[all,path,alternative,unreachable,trap], default=all)` | no |
| `min_region_ratio` | `region_needs_expansion` | `min_region_ratio: Integer(default=25, min=0, max=100)`, `region_class: Enum(options=[all,path,alternative,unreachable,trap], default=all)` | no |
| `min_region_count` | `missing_regions` | `region_class: Enum(options=[path,alternative,unreachable,trap], default=trap)`, `count: Integer(default=1, min=0, max=1_000_000)` | no |

Checks without params are auto-selected on `loadRegistry`. Checks with params are not auto-selected — the user must add them explicitly.

## Architectural Contract

Only code that owns the `Maze` may call `&mut self` accessors on `maze.analysis`. QC checks and repair strategies may read `maze.analysis` via shared reference but must not write to it.

`MazeAnalysis` caches derived data lazily. See `analysis.md` for the full contract.
