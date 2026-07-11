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
    InvalidTeleport,
    TeleportGroupProximity,
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
pub const INVALID_TELEPORT:  IssueKind = IssueKind::InvalidTeleport;
```

`IssueKind` still exists exactly as above and remains the runtime-erased representation used for
config, DTOs, and serialization — see "Issue trait and the 12 concrete types" below for how it
relates to the type-level `Issue` design (GitHub issue #113).

`MissingRegions` mirrors `MissingLoops`'s role, but for a deficit in the count of regions of a specific `RegionClass` (Path/Alternative/Unreachable/Trap — see "Region Classes" in `graph-analytics.md`) instead of overall loop count — currently produced only by `MinRegionCountCheck`.

`InvalidTeleport` mirrors `InvalidLoop`'s role, but for a `Teleport` edge (`EdgeKind::Teleport`) flagged invalid for a check-specific reason instead of a cycle — see GitHub issue #74. Currently produced by `TeleportDuplicatesConnectionCheck` (a regular connection already duplicates the teleport), `TeleportWaypointDistanceCheck` (the teleport sits too close to a waypoint), `TeleportMinGeometricLengthCheck`/`TeleportMaxGeometricLengthCheck` (the teleport's geometric length is out of the configured range), and `TeleportSuperHubAvoidanceCheck` (an endpoint vertex already has too many outgoing connections). Carries `IssueData::InvalidTeleports` — see that variant's doc comment. Repaired by `RemoveTeleportStrategy` (see `repair.md`).

`TeleportGroupProximity` is a distinct kind from `InvalidTeleport`, not a reuse — see GitHub issue #75. Where `InvalidTeleport` flags a single teleport edge invalid on its own, `TeleportGroupProximity` flags a *relationship* between two teleport edges (neither individually invalid). Currently produced only by `TeleportGroupProximityCheck`. Carries `TeleportGroupProximityIssue { pairs, .. }` — see that type's doc comment. Repaired by `TeleportGroupProximityStrategy` (see `repair.md`).

Always use the named constant — never use string literals or enum variants inline.

**Hard rule: `IssueKind` is a semantic category, not a producer id.** `InvalidLoop` means "this cycle is invalid for some check-specific reason" — it does not identify *which* check found it. Multiple checks can legitimately produce the same `IssueKind` for different underlying reasons — currently `MinLoopLengthCheck` (cycles shorter than a threshold) and `MaxLoopLengthCheck` (cycles longer than a threshold); future checks may flag cycles invalid for still other reasons and reuse this same kind rather than inventing a new one per reason. Which check(s) actually contributed to a given `Issue` is tracked separately, in `Issue.source_checks` (below) — never by adding more `IssueKind` variants.

`RegionNeedsExpansion` mirrors `InvalidLoop`'s role for SCC regions: a semantic category ("this region needs to be expanded for some check-specific reason"), not tied to size specifically or to any one reason. Currently produced by `MinRegionSizeCheck` (region smaller than a configured absolute tile count) and `MinRegionRatioCheck` (region smaller than a configured share of the field), but future checks may flag a region as needing expansion for reasons unrelated to size and reuse this same kind. Carries `IssueData::RegionsNeedingExpansion` — see that variant's doc comment.

**`CycleAnalysisOverflowed` is not a toggleable QC check** — every other kind here is produced by a `Check<T, I>` implementation the user selects via `config.checks`; this one is raised directly by `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) whenever `GraphAnalytics::cycle_analysis_overflowed` is true (cycle enumeration aborted past `MAX_SIMPLE_CYCLES` — see `graph-analytics.md`). It bypasses `QualityControlEngine` entirely: `build_analytics_snapshot` pushes `Box::new(CycleAnalysisOverflowedIssue::default())` straight into the issue list after the engine (or `issues_override`) has already run, so it surfaces unconditionally — same `IssuesBlock`/`FeatureCard` UI as any other issue, but with no corresponding `Check<T, I>` or `RepairStrategy` and no way for a user to disable it. `IssueKind::from_str` still parses it like any other kind (used to validate `config.strategies` keys), but no strategy can ever be registered against it — see `from_str`'s doc comment.

### Issue trait and the 12 concrete types

See GitHub issue #113. `Issue` used to be one concrete struct with a runtime `kind: IssueKind`
field and an `Option<IssueData>` payload — nothing in the type system connected a `Check`'s
output, a `Rule`'s configured `kind`, and the `RepairStrategy` it dispatched to, so a mismatch
between them was only ever caught (if at all) by a handful of manual
`debug_assert_eq!(issue.kind, self.handles())` calls. `Issue` is now a **trait**, with one
concrete type per former `IssueKind` variant living in `quality_control::issue_kinds`:
`MissingEndpointsIssue`, `UnreachableFinishIssue`, `InvalidLoopIssue`, `MissingLoopsIssue`,
`CycleAnalysisOverflowedIssue`, `RepairLimitReachedIssue`, `QcNoProgressIssue`,
`ExcessiveSccCountIssue`, `RegionNeedsExpansionIssue`, `MissingRegionsIssue`,
`InvalidTeleportIssue`, `TeleportGroupProximityIssue`. `Check<T, I>`, `RepairStrategy<T, I>`, and
`Rule<T, I>` are all generic over the concrete `I` — the compiler now guarantees that a `Rule`'s
checks and its one strategy agree on exactly which `Issue` type they produce/consume; there is no
longer a runtime `kind` field on `Rule` to independently agree with.

```rust
pub trait Issue: std::any::Any {
    fn kind(&self) -> IssueKind;               // object-safe mirror of Self::KIND, for dyn Issue callers
    fn meta(&self) -> &IssueMeta;
    fn meta_mut(&mut self) -> &mut IssueMeta;
    fn as_any(&self) -> &dyn std::any::Any;     // downcast entry point at the erased boundary
    fn eq_dyn(&self, other: &dyn Issue) -> bool;    // object-safe value equality
    fn clone_box(&self) -> Box<dyn Issue>;          // object-safe clone

    fn source_checks(&self) -> &[String] { self.meta().source_checks() }
    fn details(&self) -> &HashMap<String, HashMap<&'static str, String>> { self.meta().details() }
}

/// Split out from `Issue` itself only because associated consts with a `where Self: Sized` bound
/// aren't stable yet (`generic_const_items`) — logically part of the same contract.
pub trait IssueKindConst: Issue + Sized {
    const KIND: IssueKind;
}

/// Not object-safe (`Self: Sized`) — never called through `dyn Issue`/`Box<dyn Issue>`. Only
/// called from `Rule<T, I>::run_checks_typed`, where `I` is statically known.
pub trait IssueMerge: Issue + IssueKindConst {
    fn merge(&mut self, other: Self);
}
```

`dyn Issue` is object-safe through exactly `kind()`/`meta()`/`meta_mut()`/`as_any()`/`eq_dyn()`/
`clone_box()` — the only methods callable on `&dyn Issue`/`Box<dyn Issue>`. `eq_dyn`/`clone_box`
bodies are identical across every concrete type (only `Self` in `downcast_ref::<Self>()` varies,
implicitly) — generated via `impl_issue_dyn_boilerplate!()`, invoked once inside each type's own
`impl Issue for ConcreteType { ... }` block, rather than hand-duplicated in all 12
`issue_kinds/*.rs` files. `const KIND` (via `IssueKindConst`) and `merge` (via `IssueMerge`) are
**not** object-safe and are never called through the erased boundary — everywhere `Self` is
statically known, code reads `Self::KIND` directly, never `self.kind()`.

Each concrete type carries its own data fields directly (what used to be one `IssueData` enum
variant) plus a shared `meta: IssueMeta` for `source_checks`/`details` bookkeeping:

```rust
pub struct InvalidLoopIssue {
    meta: IssueMeta,   // private — see accessors below
    pub all: Vec<Vec<EdgeId>>,
    pub invalid: Vec<usize>,
    pub invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
}
impl InvalidLoopIssue {
    pub fn new_from_check(source_check: &str, all: Vec<Vec<EdgeId>>, invalid: Vec<usize>, invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>) -> Self;
    pub fn with_detail(self, source_check: &str, key: &'static str, value: String) -> Self;  // chainable
}
```

**`source_checks`/`details` carry a rule-scoped composite id, not a check type id** — see GitHub
issue #60. Two active configurations of the same check type (e.g. two `min_region_count`
instances, each with its own `region_class`/`count`) need distinct routing identity, so the
string here is `{rule_id}:{local_id}` (built once, by `composite_check_id()` in
`maze-runner`/`maze-wasm`'s `runner.rs`, never reconstructed or parsed back apart anywhere in
`maze_core`). Treat it as opaque: compare and pass it through, never split on `:`.

Every concrete type is mostly an **internal QC artifact** — its own data fields are plumbing
between a `Check<T, I>` and the matching `RepairStrategy<T, I>` within one QC pass and are never
serialized (see "Not exposed over WASM" below). `kind()`, `source_checks()`, and `details()` are
the exception: the WASM layer (`maze-wasm/src/analytics.rs`) does serialize these into `IssueDto`
for the web UI, downcasting `&dyn Issue` to whichever concrete type it needs a payload from (e.g.
`InvalidLoopIssue`/`RegionNeedsExpansionIssue` for `IssuePayloadDto`, `RepairLimitReachedIssue`/
`QcNoProgressIssue` for their own no-source-check detail entries — see "IssueDto" below).

`IssueMeta`'s `source_checks`/`details` fields are private, mutated only via `push_source`/
`merge_details` (both `pub(crate)`, called exclusively from each concrete type's own `IssueMerge`
impl) — nothing outside a merge can append to `source_checks` or construct an issue with an
already-multi-source list before merge has legitimately produced one. `details` carries **raw
display values only** — e.g. a check's configured threshold as a string — keyed by source check
composite id, then by detail key. Never an assembled message: wording belongs entirely to the web
UI's own i18n layer (see `quality-feature.md`'s issue rendering section — the web side needs
`IssueDto.source_check_types` to recover the type id from the composite instance id for this
lookup).

**Erased boundary — where `Box<dyn Issue>` is unavoidable.** Two places in the pipeline need
genuine cross-`I` heterogeneity and stay type-erased by design:
- `Stage.rules: Vec<Box<dyn RuleTrait<T>>>` — a `Stage` deliberately groups rules of different
  concrete `Issue` types together. `RuleTrait<T>` is the erased view of `Rule<T, I>` for exactly
  this boundary (`run_checks`/`report_checks` return `Box<dyn Issue>`/`Vec<Box<dyn Issue>>`;
  `dispatch_repair` takes `issue: &dyn Issue`, downcasting internally to the rule's own `I` — an
  internal invariant, never a legitimate external input, so it `expect()`s rather than returning
  `Result`).
- Nested-strategy slots (`NestedStrategyConfig<T>`, see `repair.md`) — a parent strategy's own `I`
  and its nested strategy's `I` are independent (e.g. `ReduceSccCountStrategy` handles
  `ExcessiveSccCountIssue` but delegates to a `RegionNeedsExpansionIssue`-handling nested
  strategy). `ErasedRepairStrategy<T>` is the erased view of `RepairStrategy<T, I>` for this
  boundary.

Both erased boundaries downcast via `Issue::as_any()` + `downcast_ref::<ConcreteType>()`, and both
document the invariant the caller must uphold instead of runtime-validating it on every call — the
compile-time-checked path (a `Rule<T, I>`'s own checks and strategy) never needs this at all;
only the two genuinely-heterogeneous boundaries above do.

- **Dedup interaction**: multiple checks may produce an issue of the same concrete type in one QC pass. The pipeline (see `repair.md`'s "Pipeline" section) **merges** them into a single issue via `IssueMerge::merge` rather than keeping only the first and dropping the rest. The merge rule is per-concrete-type: for `InvalidLoopIssue`, cycles are merged canonically (a cycle is identified by its edge set, not by `Vec` order, so the same cycle found by two checks collapses to one entry instead of being duplicated); `invalid_sources` is unioned per canonical key (no remap needed); `source_checks`/`details` (via `IssueMeta`) are unioned. A type whose fields have no sensible merge rule is a `debug_assert!`/panic in debug builds, not a silent pick-one-side fallback.
- **Not exposed over WASM**: the WASM layer serializes `kind()`, `source_checks()`, and `details()` (see `IssueDto` below) but never a concrete type's own data fields directly — those stay internal, Check-to-Strategy plumbing only, except where `analytics.rs` explicitly downcasts to build a payload DTO (`InvalidLoopIssue`/`RegionNeedsExpansionIssue`) or a synthetic detail entry (`RepairLimitReachedIssue`/`QcNoProgressIssue`, both raised outside any `Check<T, I>` — see their own doc comments in `issue_kinds/`).

### Check trait

```rust
pub trait Check<T: Tessellation, I: Issue> {
    fn check_type_id(&self) -> &'static str;

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<I>, rng: &mut dyn RngCore);

    fn report_check(&self, maze: &Maze<T>, rng: &mut dyn RngCore) -> Vec<I> {
        let mut issues = Vec::new();
        self.repair_check(maze, &mut issues, rng);
        issues
    }
}
```

- **Read-only**: `maze` is immutable. A `Check` must not mutate any state.
- **No side effects**: neither method may access global state or perform I/O.
- **`rng` is the one sanctioned source of non-determinism**: most checks ignore it (`_rng`) and stay fully deterministic, but a check whose contract is inherently randomized — currently only `MaxLoopDensityCheck` (below), which must pick *which* excess loops to flag without a deterministic ordering rule — draws from it instead of seeding its own. `Rule::run_checks_typed`/`report_checks_typed` (see `repair.md`'s "Rule, Stage, and the unified QualityControlEngine" section, GitHub issue #106) take the `rng` from their caller (ultimately the pipeline's per-`build_maze`-call `MazeRng`, seeded from the generation seed) rather than each check owning one, so a whole QC pass stays reproducible for a given seed.
- A check may produce zero or more issues per call.
- A check may read `maze.analysis` to avoid redundant computation.
- **`repair_check` vs `report_check`** — see GitHub issue #102. Both methods detect the exact same problems; they differ only in how many issue values they produce per flagged instance:
  - `repair_check` is the detection the repair fixpoint loop (`Rule::run_checks_typed`, driven by `Stage::run_repair`) drives. It may bundle every flagged problem instance into one merged issue per call (e.g. `MinLoopLengthCheck` bundles all short cycles into one `InvalidLoopIssue { all, invalid, invalid_sources }`), since the loop dispatches one repair strategy call per rule against the whole batch — batching there is a feature, not a limitation, of the repair-dispatch contract.
  - `report_check` is the detection the final QC report (`remaining_issues`, analytics, UI) drives — driven by `Rule::report_checks_typed`, called both by `build_maze`'s final report pass and by `build_analytics_snapshot`'s check-only path (unified since GitHub issue #106; see `repair.md`). It must produce one issue per flagged problem instance instead, since a batched issue can't be split into accurate per-item counts, per-item highlighting, or (eventually) one-issue-per-cycle repair dispatch. Default implementation delegates to `repair_check` (calls it into a temporary `Vec` and returns it) — no behavior change for a check that doesn't override it.
  - Both methods return/populate the same concrete `I` — there is no separate report-only issue type.
  - `check_type_id()` identifies the check **type** (e.g. `"min_loop_length"`), used by `Rule::run_checks_typed`/`report_checks_typed` to aggregate per-check-type timing — distinct from `instance_id`, the per-instance composite routing key.

### QualityControlEngine, Rule, and Stage

See GitHub issue #106 (Stage/Rule ownership) and GitHub issue #113 (`Rule<T, I>` typing).
`QualityControlEngine` is not a flat holder of `checks: Vec<Box<dyn Check<T, I>>>` — it owns an
ordered list of `Stage<T>`s, each owning `Vec<Box<dyn RuleTrait<T>>>` (erased — see "Erased
boundary" above), each concrete `Rule<T, I>` owning its own checks plus (optionally) one
`RepairStrategy<T, I>`, all sharing the same `I`. Merging issues of the same concrete type
produced by different checks **within one `Rule`** (not dropping duplicates) is that `Rule`'s own
responsibility (`Rule::run_checks_typed`, via `IssueMerge::merge`) — see `repair.md`'s "Rule,
Stage, and the unified QualityControlEngine" section for the full type shapes and dispatch
algorithm, and the "Dedup interaction" note above for the per-type merge rules themselves. A
`Rule`'s checks always run in the order they were configured, same as the pre-#106 flat engine's
insertion order.

## Built-in Checks

### MissingEndpointsCheck

Produces `MissingEndpointsIssue::new_from_check("missing_endpoints")` if either `maze.meta.start` or `maze.meta.finish` is `None`.

### UnreachableFinishCheck

Produces `UnreachableFinishIssue::new_from_check("unreachable_finish")` if both `maze.meta.start` and `maze.meta.finish` are `Some` but `finish` is not reachable from `start` via directed graph traversal.

Skips the check silently if either endpoint is `None` — those cases are covered by `MissingEndpointsCheck`.

### MinLoopsCountCheck

```rust
pub const MIN_LOOPS_DEFAULT: u32 = 1;

pub struct MinLoopsCountCheck {
    pub min_loops: u32,
}
```

Counts loops via `maze.analysis.graph_analytics(&maze.graph, &maze.meta).cycle_count` — the **independent** cycle count (Euler's formula, `E - V + C` on the pure-cycle core, see `graph-analytics.md`), the same number shown to the user as the "Cycle count" analytics stat. Deliberately **not** `find_deduped_simple_cycles`'s raw simple-cycle enumeration: that is a different (usually much larger) metric, and using it here would make this check disagree with what the UI displays as the maze's loop count. Silently skips (no issue) when `graph_analytics.cycle_analysis_overflowed` is true, same overflow rationale as the simple-cycle checks below (shared underlying enumeration). If `cycle_count` is below `min_loops`, fires `MissingLoopsIssue::new_from_check("min_loops_count", missing)` with `.with_detail("min_loops_count", "missing", missing.to_string())` chained on, where `missing = min_loops.saturating_sub(cycle_count)`. No issue is fired when the count meets or exceeds `min_loops`.

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

Fires `MissingLoopsIssue::new_from_check("min_loop_density", missing)` with `.with_detail("min_loop_density", "missing", missing.to_string())` chained on — same detail key as `MinLoopsCountCheck`, so the web UI's per-source-check label resolver can render both with one shared message shape. Repaired the same way as `MinLoopsCountCheck`'s `MISSING_LOOPS` issues — `MissingLoopsRandomStrategy` (see `repair.md`) needs no new logic, since both checks produce the same `MissingLoopsIssue` shape.

### MinLoopLengthCheck

```rust
pub const MIN_LOOP_LENGTH_DEFAULT: u32 = 10;

pub struct MinLoopLengthCheck {
    pub min_loop_length: u32,
}
```

A separate, unrelated check from `MinLoopsCountCheck` (that one counts total loops; this one checks individual loop *length*). Uses `maze.analysis.nav_graph(&maze.graph, &maze.meta)` (the shared, pinned-by-`meta` cache — see `analysis.md`), then `find_all_simple_cycles` (`maze-core/src/graph/cycles.rs`, Johnson's algorithm — see `graph-analytics.md` for the full description of this shared, single-source-of-truth cycle enumeration), `dedup_bidirectional_pairs` (collapses each visual loop walked in either direction to one entry, drops trivial reverse-pair turn-arounds). Every resulting cycle (short and long alike) is resolved to base-`Graph` `EdgeId`s and stored in `InvalidLoopIssue.all`; the subset whose tile-length is below `min_loop_length` becomes `invalid` (indices into `all`).

Symmetric counterpart: `MaxLoopLengthCheck` (below) flags cycles whose tile-length exceeds a maximum instead. Both checks may run in the same QC pass and both produce `INVALID_LOOP` — see the merge behavior in `repair.md`'s "Pipeline" section.

Not a fundamental cycle basis — a basis only yields β₁ cycles relative to one spanning tree and can miss short cycles that are the symmetric difference of two longer fundamental cycles (unacceptable false negatives for a health check). `find_all_simple_cycles` enumerates ALL simple directed cycles with no length bound; this check filters the already-complete result by tile-length afterward, rather than embedding a bound into the search itself (kept uniform with the other consumers of `find_all_simple_cycles` — see `graph-analytics.md`).

Self-loop nav-edges (junction-free rings) are included — previously a known gap (a ring with at most one junction compresses into a self-loop `NavEdge` that the old `build_cyclic_core` unconditionally excluded, making such loops invisible to this check). Fixed by `find_all_simple_cycles` treating self-loops as first-class cycles.

If any cycles below the threshold are found (`invalid` non-empty), fires a single `InvalidLoopIssue::new_from_check("min_loop_length", all, invalid, invalid_sources)` with `.with_detail("min_loop_length", "min_loop_length", self.min_loop_length.to_string())` chained on — the configured threshold, for the web UI to render a specific message ("loop shorter than N tiles") instead of the generic `INVALID_LOOP` label. No issue is fired if `invalid` is empty, even if `all` is not. Other checks may also produce `INVALID_LOOP` issues for different reasons in the same pass — see the pipeline's merge behavior in `repair.md`.

### MaxLoopLengthCheck

```rust
pub const MAX_LOOP_LENGTH_DEFAULT: u32 = 100;

pub struct MaxLoopLengthCheck {
    pub max_loop_length: u32,
}
```

Symmetric counterpart to `MinLoopLengthCheck` — same cycle enumeration pipeline (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs` → tile-length filter → `resolve_to_edge_ids`), same silent skip on `CycleSearchResult::TooManyCycles` overflow, same `InvalidLoopIssue` shape. The only difference: the filter keeps cycles whose tile-length is **above** `max_loop_length` (`tile_length > max_loop_length`) instead of below a minimum.

If any cycles above the threshold are found (`invalid` non-empty), fires a single `InvalidLoopIssue::new_from_check("max_loop_length", all, invalid, invalid_sources)` with `.with_detail("max_loop_length", "max_loop_length", self.max_loop_length.to_string())` chained on, same rationale as `MinLoopLengthCheck` above. No issue is fired if `invalid` is empty. Both `MinLoopLengthCheck` and `MaxLoopLengthCheck` can be active at once — they each populate their own `invalid` subset and the pipeline merges the two `INVALID_LOOP` issues canonically (see "Dedup interaction" above and `repair.md`'s "Pipeline" section); the merged issue then carries both checks' details, and the UI renders one bubble per source check.

### ExternalEscapeDiversityCheck

```rust
pub const EXTERNAL_ESCAPE_DIVERSITY_DEFAULT: u32 = 3;

pub struct ExternalEscapeDiversityCheck {
    pub min_distinct_exits: u32,
}
```

Detects cycles that are "locally trapped" despite having many outgoing connections — see issue #32. Uses the same enumeration pipeline as `MinLoopLengthCheck`/`MaxLoopLengthCheck` (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs`, same silent skip on `CycleSearchResult::TooManyCycles`), but the filter is purely topological rather than length- or geometry-based: for each cycle, collect the set of cycle vertices (nav-nodes touched by any of its nav-edges), then count the distinct nav-nodes outside that set reached by a direct outgoing nav-edge from any cycle vertex (`distinct_exit_count`). No further traversal past that one hop, no geometry, no connected-component analysis on the rest of the graph — a cycle with 8 outgoing edges that all land on the same external node scores 1, not 8.

If any cycle's distinct exit count is below `min_distinct_exits`, fires a single `InvalidLoopIssue::new_from_check("external_escape_diversity", all, invalid, invalid_sources)` with `.with_detail("external_escape_diversity", "min_distinct_exits", self.min_distinct_exits.to_string())` chained on. No issue is fired if `invalid` is empty. Can be active alongside `MinLoopLengthCheck`/`MaxLoopLengthCheck` — all three merge into one `INVALID_LOOP` issue per the same dedup rule.

### LoopDistanceFromStartCheck

```rust
pub const LOOP_DISTANCE_FROM_START_DEFAULT: u32 = 0;

pub struct LoopDistanceFromStartCheck {
    pub min_distance_from_start: u32,
}
```

Flags simple cycles placed too close to `meta.start` in progression space — see GitHub issue #33. Uses `maze.analysis.distance_from_start` (`HashMap<NavNodeId, usize>`, tile distance, lazily computed and cached — see `graph-analytics.md`'s "Distance Maps" section), then the same cycle enumeration pipeline as the other loop checks (`nav_graph` → `find_all_simple_cycles` → `dedup_bidirectional_pairs`, same silent skip on `CycleSearchResult::TooManyCycles`). A cycle's distance from start is the **minimum** tile distance among all nav-nodes the cycle touches (every `from`/`to` endpoint of its nav-edges) — the cycle's closest point to start, not its average or farthest — computed by `cycle_min_distance` (`maze-core/src/graph/distance_map.rs`), the single shared reduction `LoopDistanceFromFinishCheck` (below) reuses too, rather than each check carrying its own copy. A nav-node unreachable from start is excluded from that minimum; if every touched nav-node is unreachable the cycle is treated as having no defined distance and never flagged.

Silently skips (no issue, no panic) if `meta.start` is unset — `distance_from_start` returns `None` in that case, and that failure mode belongs to `MissingEndpointsCheck`, not this check.

Default `0` never fires on its own — the threshold has no natural default (unlike a tile-length minimum), so the check is a no-op until a user picks a value. If any cycles closer than the threshold are found, fires a single `InvalidLoopIssue::new_from_check("loop_distance_from_start", all, invalid, invalid_sources)` with `.with_detail("loop_distance_from_start", "min_distance_from_start", self.min_distance_from_start.to_string())` chained on. Can be active alongside any other `INVALID_LOOP`-producing check — all merge into one issue per the same dedup rule.

### LoopDistanceFromFinishCheck

```rust
pub const LOOP_DISTANCE_FROM_FINISH_DEFAULT: u32 = 0;

pub struct LoopDistanceFromFinishCheck {
    pub min_distance_from_finish: u32,
}
```

Symmetric counterpart to `LoopDistanceFromStartCheck` — flags simple cycles placed too close to `meta.finish` instead. Uses `maze.analysis.distance_from_finish` (distance **to** finish, following directed edges backward), same cycle enumeration pipeline, same "minimum among touched nav-nodes" rule, same silent skip on missing `meta.finish` or `TooManyCycles` overflow.

Fires `InvalidLoopIssue::new_from_check("loop_distance_from_finish", all, invalid, invalid_sources)` with `.with_detail("loop_distance_from_finish", "min_distance_from_finish", self.min_distance_from_finish.to_string())` chained on.

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

Fires a single `InvalidLoopIssue::new_from_check("max_loop_density", all, invalid, invalid_sources)` with `.with_detail("max_loop_density", "max_density", self.max_density.to_string())` chained on. Can be active alongside any other `INVALID_LOOP`-producing check — all merge into one issue per the same dedup rule. The flagged loops need no new repair logic — `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy` cut them exactly like any other check's `invalid` entries.

### SccCountCheck

```rust
pub const MAX_SCC_COUNT_DEFAULT: u32 = 1;

pub struct SccCountCheck {
    pub max_scc_count: u32,
}
```

Flags an excessively fragmented graph — see GitHub issue #48. Uses `maze.analysis.scc(&maze.graph)` (cached per `graph.version()` — see `analysis.md`), itself backed by `build_scc` (`maze-core/src/graph/scc.rs`, Tarjan's algorithm), rather than re-implementing or directly recomputing SCC; counts `ConnectedComponents::components.len()`. If the count is at or below `max_scc_count`, the check is silent. If it exceeds `max_scc_count`, fires `ExcessiveSccCountIssue::new_from_check("scc_count", self.max_scc_count)` with `.with_detail("scc_count", "max_scc_count", self.max_scc_count.to_string())` and `.with_detail("scc_count", "scc_count", count.to_string())` chained on — both raw values for the web UI to render a specific message, `max_scc_count` for `ReduceSccCountStrategy` (see `repair.md`) to compute how many regions to merge.

### MinRegionSizeCheck

```rust
pub const MIN_REGION_SIZE_DEFAULT: u32 = 20;

pub struct MinRegionSizeCheck {
    pub min_region_size: u32,
    pub region_classes: Vec<RegionClass>,
}
```

Flags SCC regions with fewer tiles than a configured absolute minimum — see GitHub issue #50. Uses `maze.analysis.scc(&maze.graph)` (same cache `SccCountCheck` reads), and flags every component whose `len()` is below `min_region_size`. If no region is undersized, the check is silent. Otherwise fires a single `RegionNeedsExpansionIssue::new_from_check("min_region_size", invalid, invalid_sources)` with `.with_detail("min_region_size", "min_region_size", self.min_region_size.to_string())` chained on — `invalid` holds every undersized component's index into `scc.components`.

`region_classes` restricts the check to SCC regions of the listed `RegionClass`(es) (Path/Alternative/Unreachable/Trap — see `graph-analytics.md`'s "Region Classes" section) — see GitHub issue #54. Empty means no region matches (the check is always silent). All four classes (`ALL_REGION_CLASSES`, the wasm layer's `"all"` dropdown option) means every region is checked, the pre-#54 behavior, and skips computing `RegionClass`es entirely (no `start`/`finish` requirement in that case). For any other non-empty subset, the check additionally needs `maze.analysis.region_classes(&maze.graph, start, finish)` to look up each component's class; if either `maze.meta.start` or `maze.meta.finish` is `None`, the check is silent (classification unavailable — same failure mode `MinRegionCountCheck` has).

### MinRegionRatioCheck

```rust
pub const MIN_REGION_RATIO_DEFAULT: u32 = 25;

pub struct MinRegionRatioCheck {
    pub min_region_ratio: u32,
    pub region_classes: Vec<RegionClass>,
}
```

Counterpart to `MinRegionSizeCheck` using a relative threshold instead of an absolute tile count — see GitHub issue #50. Flags every SCC region covering less than `min_region_ratio` percent of the field (`maze.field.node_count()`): `region.len() * 100 < min_region_ratio * field_cells`. Silently skips (no issue) if the field has zero cells. If no region is undersized, the check is silent. Otherwise fires a single `RegionNeedsExpansionIssue::new_from_check("min_region_ratio", invalid, invalid_sources)` with `.with_detail("min_region_ratio", "min_region_ratio", self.min_region_ratio.to_string())` chained on.

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

Uses `maze.analysis.region_classes(&maze.graph, start, finish)` and counts entries per class. Silently skips (no issue) if either `maze.meta.start` or `maze.meta.finish` is `None` — same as `UnreachableFinishCheck`/the loop-distance checks, that failure mode belongs to `MissingEndpointsCheck`, not this check. For each class with a non-zero configured minimum, computes `balance = count as i64 - min_count as i64`; a class at exactly its minimum (`balance == 0`) is omitted from the result entirely — only off-target classes are reported, each as `+N` (surplus) or `-N` (shortfall). If every configured class is at its minimum, the check is silent. Otherwise fires `MissingRegionsIssue::new_from_check("min_region_count", balance_by_class)` with `.with_detail("min_region_count", "region_classes", <comma-joined list of off-target classes>)` chained on.

`MissingRegionsStrategy` (see `repair.md`) is the registered `RepairStrategy` for `MISSING_REGIONS`: it creates/converts regions for every `-N` class, optionally spending `+N` surplus from other classes via cross-region growth or reuse-merge to reach a configured `min_region_size`.

### TeleportDuplicatesConnectionCheck

```rust
pub struct TeleportDuplicatesConnectionCheck {
    pub instance_id: String,
    pub protect_route: bool,
}
```

Flags a teleport edge (`EdgeKind::Teleport`) as invalid when a regular (`EdgeKind::Basic`) connection already exists between the same pair of vertices in the same direction — see GitHub issue #74. A teleport that duplicates a passage the maze already has adds no new connectivity, only visual/navigational noise.

For every `Teleport` edge in `maze.graph`, checks whether a `Basic` edge exists with the same `from`/`to` (direction-specific — a `Basic` edge only in the *reverse* direction does not count as a duplicate). Each direction of a two-way teleport is its own `Teleport` edge and is flagged independently if it has its own matching `Basic` duplicate. If no teleport is flagged, the check is silent. Otherwise fires `InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", invalid)` — `invalid` holds every flagged teleport's `EdgeId` directly.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportWaypointDistanceCheck

```rust
pub const TELEPORT_WAYPOINT_DISTANCE_DEFAULT: u32 = 0;

pub enum TeleportWaypoint { Start, Finish, Any }
pub enum TeleportEdgeSelector { EntryOnly, EntryOrExit }

pub struct TeleportWaypointDistanceCheck {
    pub instance_id: String,
    pub distance: u32,
    pub waypoint: TeleportWaypoint,
    pub edge: TeleportEdgeSelector,
    pub protect_route: bool,
}
```

Flags a teleport edge placed too close to a waypoint (start/finish) in progression space — see GitHub issue #74. Multiple instances may be active at once (different `waypoint`/`edge`/`distance` combinations are all legitimate simultaneously, e.g. "entry must be far from start" AND separately "exit must be far from finish") — `allow_multiple_instances: true` (see "Available checks" below), same rationale as `MinRegionCountCheck`.

Distance is logical (tile count via `maze.analysis.distance_from_start`/`distance_from_finish`, see `graph-analytics.md`'s "Distance Maps" section), never geometric. For each teleport edge, resolves the relevant endpoint(s) (`from` only for `EntryOnly`, both `from` and `to` for `EntryOrExit`) to a `NavNodeId` via `maze.analysis.nav_graph(...).nav_node_for(...)` — always `Some` for a teleport endpoint, since a node touching a `Teleport` edge is never compressed into a passage node (see `nav-graph.md`'s "Passage Node" exemption). Looks up each resolved endpoint's distance in the relevant map(s) (`distance_from_start` for `Start`, `distance_from_finish` for `Finish`, both for `Any`) and takes the **minimum** across every relevant (endpoint, waypoint) combination — a teleport is flagged if that minimum is below `distance`. A combination whose endpoint is absent from the relevant distance map (unreachable from that waypoint) is skipped entirely, not treated as distance `0` — if every relevant combination is unreachable, the teleport is never flagged, symmetric with `LoopDistanceFromStartCheck`'s "cycle has no defined distance" rule.

Silently skips (no issue) if the maze doesn't have the waypoint(s) this instance needs set (`meta.start` for `Start`/`Any`, `meta.finish` for `Finish`/`Any`) — covered by `MissingEndpointsCheck`, same rationale as the loop-distance checks. Default `distance` of `0` never fires on its own, same as `LoopDistanceFromStartCheck`'s `min_distance_from_start`.

If any teleports are flagged, fires `InvalidTeleportIssue::new_from_check("teleport_waypoint_distance", invalid)` with `.with_detail("teleport_waypoint_distance", "distance", self.distance.to_string())` chained on. Can be active alongside `TeleportDuplicatesConnectionCheck` (or another `teleport_waypoint_distance` instance) — all merge into one `INVALID_TELEPORT` issue per the dedup rule in `repair.md`'s "Pipeline" section.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

`RemoveTeleportStrategy` (see `repair.md`) is the registered `RepairStrategy` for `INVALID_TELEPORT` — removes every flagged teleport edge outright.

### Geometric distance (`space::Tessellation::cartesian` / `space::geometric_distance`)

Shared utility the two checks below build on — see GitHub issue #74. `Tessellation::cartesian(point) -> (f64, f64)` (`maze-core/src/space/mod.rs`) projects a tessellation's own `Point` type into a canonical Cartesian coordinate, unit tile scale (one tile = 1.0), implemented separately per tessellation (`SquarePoint`, `HexPoint`, `TriPoint`). Never a pixel coordinate, and carries no rendering-specific orientation/rotation (hex flat_top/pointy_top, tri r0/r90/r180/r270 are display-only choices that live entirely in `maze-web`, which scales and — for hex/tri — rotates this canonical projection itself rather than duplicating per-tessellation formulas; see `maze-wasm`'s `cartesian_coords` below). Each tessellation's impl only needs to be internally consistent — `SquarePoint`'s returns the raw `(x, y)` grid coordinate, while `HexPoint`'s and `TriPoint`'s happen to bake in a screen-style Y flip (ported directly from `maze-web`'s pre-existing pixel-space formulas) — see `cartesian`'s own doc comment for the full rationale. This has no effect on distance calculations, since translation/reflection are isometries.

`space::geometric_distance::<T>(a, b) -> f64` is the Euclidean distance between two points of the same tessellation, via `cartesian`. Purely geometric — unrelated to graph/nav distance (`MazeAnalysis::distance_from_start`/`distance_from_finish`, used by `TeleportWaypointDistanceCheck` above), which counts tile-hops along actual edges instead of straight-line distance.

**WASM Interface**: `cartesian_coords(config: { tessellation_type, points }) -> [[f64; 2]]` (`maze-wasm/src/lib.rs`) exposes `cartesian` to the frontend — given a tessellation type and a list of points, returns each point's canonical projection in the same order. `maze-web`'s single caller is `cartesianCache.ts`: `warmCartesianCache(cfg)` batches one call over every field cell whenever the tessellation kind changes (confirmTessellation, project load, generate), populating a `Map<"x,y", [number, number]>` that `getCartesian(x, y, cfg)` reads from synchronously — render loops call tile-center lookups every frame, so a per-call wasm round-trip would be far too slow. A cache miss (a point outside the prewarmed field, e.g. an invalid preset connection's endpoint) falls back to a single-point wasm call, cached afterward. `tessellationGeometry.ts`'s `squareCenter`/`hexCenter`/`triCenter` read from this cache and apply their own tile-size scale, half-tile offset, and (for hex/tri) orientation rotation on top — the single source of truth for tile geometry, replacing what used to be independently-maintained TypeScript formulas.

### TeleportMinGeometricLengthCheck

```rust
pub const TELEPORT_MIN_GEOMETRIC_LENGTH_DEFAULT: f64 = 0.0;

pub struct TeleportMinGeometricLengthCheck {
    pub instance_id: String,
    pub min_length: f64,
    pub protect_route: bool,
}
```

Flags a teleport edge whose geometric (Euclidean, unit tile scale) distance between its entry and exit is shorter than a configured minimum — see GitHub issue #74. A teleport meant to feel like a meaningful "jump" across the maze becomes pointless noise if its endpoints are only a couple of tiles apart in Cartesian space, even when they're topologically far (no direct passage).

Distance is purely geometric — via `space::geometric_distance` (`Tessellation::cartesian`, see the "Geometric distance" section above), resolving each teleport edge's `from`/`to` maze `NodeId` to its tessellation `Point` via `maze.field.point_of(...)`. Never logical/graph distance (that's `TeleportWaypointDistanceCheck`'s concern). A teleport endpoint whose point can't be resolved (shouldn't happen for a live edge in a well-formed `Maze`) is silently excluded from `invalid`, not treated as distance `0`.

No waypoint/edge-selector parameters — unlike `TeleportWaypointDistanceCheck`, geometric length is a property of the teleport edge alone, not relative to start/finish. Default `min_length` of `0.0` never fires on its own (no distance is negative).

If any teleports are flagged, fires `InvalidTeleportIssue::new_from_check("teleport_min_geometric_length", invalid)` with `.with_detail("teleport_min_geometric_length", "min_length", self.min_length.to_string())` chained on. Can be active alongside any other `INVALID_TELEPORT`-producing check — all merge into one issue per the dedup rule in `repair.md`'s "Pipeline" section.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportMaxGeometricLengthCheck

```rust
pub const TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT: f64 = 1_000.0;

pub struct TeleportMaxGeometricLengthCheck {
    pub instance_id: String,
    pub max_length: f64,
    pub protect_route: bool,
}
```

Symmetric counterpart to `TeleportMinGeometricLengthCheck` — flags a teleport edge whose geometric distance between entry and exit **exceeds** a configured maximum instead, e.g. to keep teleports from spanning the entire field when a more local "jump" is desired. Same `geometric_distance`/`point_of` mechanics, same silent-exclusion-on-unresolvable-point behavior.

Fires `InvalidTeleportIssue::new_from_check("teleport_max_geometric_length", invalid)` with `.with_detail("teleport_max_geometric_length", "max_length", self.max_length.to_string())` chained on. Can be active alongside `TeleportMinGeometricLengthCheck` (or any other `INVALID_TELEPORT`-producing check) — all merge into one issue per the same dedup rule.

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportSuperHubAvoidanceCheck

```rust
pub const TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT: u32 = 1_000;

pub enum TeleportHubEdgeSelector {
    Entry,
    Exit,
    EntryOrExit,
}

pub struct TeleportSuperHubAvoidanceCheck {
    pub instance_id: String,
    pub max_connections: u32,
    pub edge: TeleportHubEdgeSelector,
    pub protect_route: bool,
}
```

Flags a teleport edge whose entry and/or exit vertex already has more than a configured maximum number of outgoing connections (of any `EdgeKind`, not just `Basic`) — see GitHub issue #74. Prevents a teleport from turning an already-busy vertex ("hub") into an even busier one, which would make that vertex a disproportionately convenient shortcut hub.

Outgoing-connection count is computed once per check call (a single pass building a `HashMap<NodeId, u32>` of per-vertex outgoing-edge counts across the whole graph, not per-teleport), then looked up per teleport edge: for `Entry`, the count at the teleport's own `from` vertex (which always includes the teleport itself, since it originates there); for `Exit`, the count at the teleport's `to` vertex, counting edges outgoing *from* `to` — the teleport itself never contributes to this count, since it originates from `from`, not `to`. `EntryOrExit` flags the teleport if *either* end's count exceeds `max_connections` (`over(entry) || over(exit)`, "worst wins", same reduction shape as `TeleportWaypointDistanceCheck`'s `EntryOrExit`, though that one takes the closest/min instead since it flags on being *too small*).

Default `max_connections` of `1_000` is high enough that it never fires in practice, while still being a sane UI slider bound (unlike `u32::MAX`, which the WASM descriptor would otherwise have to clamp down separately — see "WASM Interface" below).

If any teleports are flagged, fires `InvalidTeleportIssue::new_from_check("teleport_super_hub_avoidance", invalid)` with `.with_detail("teleport_super_hub_avoidance", "max_connections", self.max_connections.to_string())` chained on. Can be active alongside any other `INVALID_TELEPORT`-producing check — all merge into one issue per the same dedup rule.

The wire-level (WASM/web) param id for `edge` is `edge_hub`, not `edge` — despite matching `TeleportWaypointDistanceCheck`'s Rust field name, it's a deliberately distinct param id so the two checks don't share i18n text (`edge`'s label/description talk about distance-to-waypoint, which makes no sense for a connection-count check — see GitHub issue #74's follow-up fix).

`protect_route` (GitHub issue #78, default `true`) — see "`protect_route`: route protection for per-teleport checks" below.

### TeleportGroupProximityCheck

```rust
pub const TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

pub enum TeleportProximityEdge { Entry, Exit, EntryOrExit }

pub struct TeleportGroupProximityCheck {
    pub instance_id: String,
    /// `f64`, not an integer type — a fractional value (e.g. `1.5`) cleanly separates an integer
    /// tile-hop count (`1` fails, `2` passes) without off-by-one ambiguity. Compared as
    /// `(tile_hop_count as f64) < distance`.
    pub distance: f64,
    pub own_edge: TeleportProximityEdge,
    pub other_edge: TeleportProximityEdge,
    pub protect_route: bool,
}
```

Flags a *pair* of teleport edges placed topologically too close to each other — see GitHub issue #75. Every other teleport check (issue #74) evaluates one teleport edge in isolation; this one instead catches problems that only emerge from the relationship between two teleports, which no single-edge check can detect. Produces `TELEPORT_GROUP_PROXIMITY`, a distinct `IssueKind` from `INVALID_TELEPORT` — neither edge in a flagged pair is individually invalid, so reusing `INVALID_TELEPORT`/`InvalidTeleportIssue` (a flat set of "remove this edge" ids) would lose the pair membership `TeleportGroupProximityStrategy`'s `problematic` priority needs.

Distance is topological (tile-hops via the shared nav-graph distance map, same `compute_distance_map` mechanism as `TeleportWaypointDistanceCheck`), `min(forward, reverse)` between the two configured endpoints — the graph stays directed-only (each direction computed via its own Dijkstra pass), but a pair close in *either* direction is equally a proximity problem, so neither direction is preferred (same "either-direction" rationale as `LoopDistanceFromStartCheck`/`TeleportWaypointDistanceCheck`'s own reductions).

`own_edge`/`other_edge` are two independent selectors — the two ends of the *pair* being compared are independently configurable (e.g. "exit of the scanned teleport vs. entry of the other teleport"). `EntryOrExit` considers both ends of that side of the pair and takes the closest combination — same "min across every relevant combination" reduction `TeleportWaypointDistanceCheck`'s own `EntryOrExit` uses; e.g. `own_edge = EntryOrExit`, `other_edge = Entry` checks both (own entry, other entry) and (own exit, other entry) and keeps the smaller distance. When *both* sides are `EntryOrExit`, all four combinations are checked — (own entry, other entry), (own entry, other exit), (own exit, other entry), (own exit, other exit) — and the overall minimum across all four wins; this is the same rule applied twice, not a special case.

For each teleport edge, scans every other teleport edge for the first one whose `other_edge` endpoint(s) are closer than `distance` to the scanned teleport's `own_edge` endpoint(s) (closest combination, per the `EntryOrExit` rule above) — as soon as one problematic pair is found for a teleport, it's recorded and the scan moves to the next teleport (no need to enumerate every pair a teleport participates in, per the issue's own spec). Each direction of a two-way teleport is its own independent element of this scan, same as every other per-teleport check from issue #74 — so a pair `(a, b)` found while scanning from `a`'s side and the symmetric `(b, a)` found while scanning from `b`'s side are both recorded (not deduplicated within one check call; `merge_issue`'s unordered-pair dedup, see `repair.md`'s "Pipeline" section, only applies across *merged* issues from different check instances).

Default `distance` of `0` never fires on its own, same as every other teleport distance check. If no pair is found, the check is silent. Otherwise fires `TeleportGroupProximityIssue::new_from_check("teleport_group_proximity", pairs)` with `.with_detail("teleport_group_proximity", "distance", self.distance.to_string())` chained on.

Multiple instances may be active at once (`allow_multiple_instances: true`) — distinct `own_edge`/`other_edge`/`distance` combinations are a legitimate simultaneous configuration, same rationale as `TeleportWaypointDistanceCheck`.

**`protect_route` (GitHub issue #78, default `true`) — different rule than the per-edge checks below.** A close pair is only excluded when *both* teleports are route-critical (`graph::route_protection::is_teleport_route_protected`, checked on `own_id`/`other_id` right when a hit is found): if only one side of the pair sits on the maze's start→finish route, the pair is still recorded, since the non-route side remains a legitimate removal candidate — `TeleportGroupProximityStrategy`'s own `protect_route` (see `repair.md`) is what actually decides *which* side to spare in that mixed case. Excluding a pair for being fully route-protected does **not** end the scan for the teleport being scanned (`own_id`) — a farther, non-protected candidate is still searched for and recorded if found, so a route-critical teleport doesn't silently "use up" its one scan slot on a pair that turns out to be unresolvable.

### `protect_route`: route protection for per-teleport checks

`TeleportDuplicatesConnectionCheck`, `TeleportWaypointDistanceCheck`, `TeleportMinGeometricLengthCheck`, `TeleportMaxGeometricLengthCheck`, and `TeleportSuperHubAvoidanceCheck` all share the same `protect_route` rule (GitHub issue #78) — `TeleportGroupProximityCheck`'s own variant is described above, since it works on pairs rather than single edges.

For these five checks: when `protect_route` is `true` (the default), a teleport edge that would otherwise be flagged is excluded from `invalid` if `graph::route_protection::is_teleport_route_protected(maze, edge_id)` reports it lies on the maze's current start→finish route (`maze.analysis.route_info(&maze.graph, &maze.meta)`, reusing that cache rather than recomputing the path). For a two-way teleport (two independent `EdgeId`s in the base `Graph` — no `reverse_edge` link like `NavEdge` has), protection covers both directions: if either direction is itself a route hop, both are excluded, so `protect_route` never silently downgrades a two-way teleport to one-way. Setting `protect_route` to `false` reproduces the pre-#78 behavior exactly (every teleport meeting the check's own criterion is flagged, regardless of route).

Route protection lives entirely on the producing check, never on `RemoveTeleportStrategy` (see `repair.md`) — the strategy stays a pure "remove everything flagged" executor with no route-awareness of its own, since a route-critical teleport is simply never placed in `invalid` to begin with.

`TeleportGroupProximityStrategy` (see `repair.md`) is the registered `RepairStrategy` for `TELEPORT_GROUP_PROXIMITY`.

## WASM Interface

The WASM layer exposes check metadata and accepts check configuration from the frontend.

### IssueDto

Serialized to JSON in `MazeSnapshot.issues` (`build_analytics_snapshot`, `maze-wasm/src/analytics.rs`) for every `Issue` the QC pass (or `issues_override`) produced:

```rust
struct IssueDto {
    kind: String,                                       // IssueKind::as_str()
    payload: IssuePayloadDto,                            // tagged payload, see below
    source_checks: Vec<String>,                          // Issue::source_checks() — opaque composite instance ids
    source_check_types: HashMap<String, String>,         // source_checks entry -> check type id
    details: HashMap<String, HashMap<String, String>>,   // Issue::details()
}

#[serde(tag = "kind", rename_all = "snake_case")]
enum IssuePayloadDto {
    None,
    InvalidLoop { edges: HashMap<String, Vec<Vec<[u32; 2]>>> }, // invalid_loop only, keyed by source check instance id
    RegionNeedsExpansion { nodes: HashMap<String, Vec<Vec<u32>>> }, // region_needs_expansion only, keyed by source check instance id
}
```

`payload` is a discriminated union tagged via `#[serde(tag = "kind")]`, serialized through `serde_wasm_bindgen::Serializer::json_compatible()` into a real TS discriminated union — the web side narrows on `payload.kind` (`"none" | "invalid_loop" | "region_needs_expansion"`) to know which field (`edges`/`nodes`) is present, instead of reading two parallel always-mostly-empty maps. `IssueDto.kind` remains the source of truth for UI filtering/labels; `payload.kind` is purely a narrowing discriminant. `payload.kind`'s variant tags mirror `IssueKind::as_str()`'s wire strings by construction — `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) asserts (debug-only) that they never diverge.

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

`IssuePayloadDto::InvalidLoop.edges` is keyed by source check instance id, not one flat list — a
merged `invalid_loop` issue may carry cycles from several checks at once (e.g. both
`min_loop_length`'s short loops and `max_loop_length`'s long loops), and each is attributed to its
own check's entry so the UI can highlight only the cycles relevant to the bubble being hovered,
not every contributing check's cycles combined. Built by looking up each invalid cycle's
canonical key (`canonical_cycle_key`) in `InvalidLoopIssue.invalid_sources` to find which
check(s) flagged it — the same attribution map `merge_invalid_loops` (`repair.md`'s "Pipeline"
section) already maintains across merges. `payload` is only `InvalidLoop` when the issue is
`invalid_loop` and at least one check flagged a cycle — otherwise it's `None`.

`IssuePayloadDto::RegionNeedsExpansion.nodes` mirrors `InvalidLoop.edges`'s role for
`region_needs_expansion` issues (currently produced by `MinRegionSizeCheck`/`MinRegionRatioCheck`)
— keyed by source check instance id for the same reason, so hovering one check's bubble
highlights only the regions that check flagged. Each inner `Vec<u32>` is one flagged region's
member maze node ids (not edges — the web client derives the region's perimeter and fill
client-side from this node set, the same way it derives preset boundary walls from a cell set;
see `IssueHighlightOverlay.ts`/`issueHighlightSelectors.ts`). Built from
`RegionNeedsExpansionIssue.invalid` (indices into
`maze.analysis.scc(&maze.graph).components`) and `invalid_sources` (keyed by component index, no
remap needed within one QC pass — see `RegionNeedsExpansionIssue`'s doc comment above).
`payload` is only `RegionNeedsExpansion` when the issue is `region_needs_expansion` and at least
one check flagged a region — otherwise it's `None`.

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
    pub stages: Vec<StageConfig>, // named, ordered rule groups — see below and GitHub issue #65
    // ...
}
```

Checks exist only inside a stage's `rules` — there is no separate flat check list or global param
dict (removed as part of GitHub issue #60; see `quality-feature.md`'s store-side model for the
matching web-side shape). The runner matches each check instance by its `type_id` string
(`match type_id.as_str()`), not by `IssueKind`. Unknown `type_id` values return an error. Unknown
param keys are silently ignored; missing params fall back to the check's default constant.

### StageConfig

```rust
#[derive(Deserialize)]
pub struct StageConfig {
    pub id: String,               // opaque stage id, unique across every stage in the config
    pub name: String,              // user-facing name, e.g. "Stage 1"
    pub rules: Vec<QcRuleConfig>,  // this stage's own rules
}
```

A named, ordered group of rules — `QualityControlEngine` (`maze-core`, via its owned `Stage`s)
dispatches one stage at a time, in `stages` array order, only rules belonging to the current
stage, until it has no more active issues, then moves to the next stage. See `repair.md`'s "Rule,
Stage, and the unified QualityControlEngine" section for the full dispatch semantics and the
shared `RepairLimits` budget across stages. `maze-wasm/src/runner.rs::build_qc_and_repair`
rejects a config where a rule with a `strategy` doesn't appear in any stage's `rules`
(`"rule {id} not assigned to any stage"`), a duplicate `stage.id` across the config
(`"duplicate stage id: {id}"`), or a duplicate rule `id` across stages
(`"duplicate rule id: {id}"`).

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
GitHub issue #60 — not deduplicated anywhere in this pipeline; each `Rule` runs every one of its
own instances independently and completely. `local_id` only needs to be unique within its own
rule's `checks` array — `maze-wasm/src/runner.rs::build_qc_and_repair` rejects a config with a
duplicate `local_id` inside one rule (`"rule {id} has duplicate local_id: {local_id}"`), as a
defense against malformed/hand-edited configs; the web store's own monotonic per-rule counter
already guarantees this never happens via normal UI flow. See `repair.md`'s "Rule, Stage, and the
unified QualityControlEngine" section for how a `QcRuleConfig` is validated and turned into core's
`Rule`.

`GenerateConfig::default()` ships one default stage (`{ id: "stage_1", name: "Stage 1" }`) containing one default rule: `{ id: "default_missing_endpoints", checks: [{ local_id: "missing_endpoints", type_id: "missing_endpoints", params: {} }], strategy: Some(farthest_endpoints) }` — `local_id == type_id` here is a deliberate special case for this fixed bootstrap singleton, not a general pattern. `unreachable_finish` has no default rule (but does default to the same one stage, with `strategy: None`).

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
| `teleport_duplicates_connection` | `invalid_teleport` | `protect_route: Bool(default=true)` | no |
| `teleport_waypoint_distance` | `invalid_teleport` | `distance: Integer(default=0, min=0, max=100_000)`, `waypoint: Enum(options=[start,finish,any], default=any)`, `edge: Enum(options=[entry_only,entry_or_exit], default=entry_or_exit)`, `protect_route: Bool(default=true)` | no |
| `teleport_min_geometric_length` | `invalid_teleport` | `min_length: Float(default=0.0, min=0.0, max=100_000.0)`, `protect_route: Bool(default=true)` | no |
| `teleport_max_geometric_length` | `invalid_teleport` | `max_length: Float(default=1_000.0, min=0.0, max=1_000_000.0)`, `protect_route: Bool(default=true)` | no |
| `teleport_super_hub_avoidance` | `invalid_teleport` | `max_connections: Integer(default=1_000, min=0, max=1_000_000)`, `edge_hub: Enum(options=[entry,exit,entry_or_exit], default=entry_or_exit)`, `protect_route: Bool(default=true)` | no |
| `teleport_group_proximity` | `teleport_group_proximity` | `distance: Float(default=0.0, min=0.0, max=100_000.0)`, `own_edge: Enum(options=[entry,exit,entry_or_exit], default=entry_or_exit)`, `other_edge: Enum(options=[entry,exit,entry_or_exit], default=entry_or_exit)`, `protect_route: Bool(default=true)` | no |

Checks without params are auto-selected on `loadRegistry`. Checks with params are not auto-selected — the user must add them explicitly.

`teleport_waypoint_distance` has `allow_multiple_instances: true` (see "CheckDescriptor" above) — same rationale as `min_region_count`: distinct `waypoint`/`edge`/`distance` combinations are a legitimate simultaneous configuration.

## Architectural Contract

Only code that owns the `Maze` may call `&mut self` accessors on `maze.analysis`. QC checks and repair strategies may read `maze.analysis` via shared reference but must not write to it.

`MazeAnalysis` caches derived data lazily. See `analysis.md` for the full contract.
