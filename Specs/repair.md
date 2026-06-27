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
    fn apply(&self, issue: &Issue, maze: &mut Maze<F>, rng: &mut dyn RngCore, params: &StrategyParams, preset_state: &PresetState) -> RepairResult;
}
```

- `preset_state` carries the same `PresetState` built before generation (`blocked`, `locked_out`, `locked_in`, `preset_connected`, `preset_edges`). Strategies that mutate edges must not remove a directed edge present in `preset_state.preset_edges` — those are Passage/OneWay connections the user placed explicitly. Strategies that don't touch edges (e.g. the endpoint strategies) ignore this parameter.

- `params()` returns the descriptor slice for this strategy's configurable parameters. Default impl returns empty slice.
- Receives `rng` from the caller — must not create its own RNG instances.
- Must be deterministic: given the same `maze` state, `rng` state, and `params`, `apply` must produce the same result.
- Must not depend on external or global state.
- May read `maze.analysis` but must not write to it.
- **Idempotency**: if the relevant meta field is already set, return `Fixed` immediately without modifying state or consuming `rng`. This ensures safe re-invocation.
- May read `issue.data` (see `quality_control.md`) — findings the matching `Check` already computed during detection. Whether `data` is optional (cheap to recompute, so `None` falls back gracefully) or effectively required (the data *is* the expensive result, with no other channel to get it) is a **per-`IssueKind` decision**, documented by each strategy for its own kind — there is no blanket rule across all strategies.

### QcRule and rule-based RepairEngine

A **rule** is the unit `RepairEngine` actually dispatches on — not `IssueKind` directly. A rule is a non-empty set of checks producing one `IssueKind`, with at most one strategy. This lets two checks producing the same `IssueKind` (e.g. `min_loop_length` and `max_loop_length`, both `INVALID_LOOP`) be split into independent rules with different strategies, instead of being forced to share the single strategy a kind-keyed engine would allow.

```rust
/// Identifies a check type (`available_checks()`'s `CheckDescriptor.id`). One variant per
/// registered check — `as_str`/`from_str` are the wire-boundary conversion (wasm config
/// parsing, serialization), same pattern as `IssueKind`. See `quality_control.md`'s "Available
/// checks" table for the current full list of check ids this enum covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CheckId {
    MissingEndpoints,
    UnreachableFinish,
    MinLoopsCount,
    MinLoopLength,
    MaxLoopLength,
    ExternalEscapeDiversity,
    LoopDistanceFromStart,
    LoopDistanceFromFinish,
}

/// A user-defined QC rule. Caller-supplied configuration (built by the wasm layer from
/// `GenerateConfig.check_rules`, see `quality_control.md`'s `QcRuleConfig`), not generated or
/// interpreted by core. `id` is opaque — core never inspects its content, only uses it as a
/// lookup/dedup key for one `build_maze` call; it is not required to be stable or unique across
/// different `build_maze` calls.
pub struct QcRule {
    pub id: String,
    pub kind: IssueKind,
    pub checks: Vec<CheckId>,
}
```

`kind` is a **caller-supplied, caller-trusted invariant**: core never reads it for routing or validation logic (only `id`/`checks` are used by `check_id_to_rule`/`run`/`strategy_rule_ids`), and core does not verify that every check in `checks` actually produces `kind`. That check happens entirely on the caller side, before a `QcRule` is ever constructed — `maze-wasm/src/runner.rs::build_qc_and_repair` resolves each check id's kind and rejects a config where they disagree (`"checks in rule {id} produce different issue kinds"`) before building the `QcRule`. `kind` exists on the struct for callers that need to read it back (e.g. `maze-wasm` re-derives it when building `RepairRuleConfig`, and it round-trips into web-side `StrategySlotVM.kind` for UI display) — core just carries it through unread.

```rust
/// One rule's strategy assignment — RepairEngine's caller-supplied configuration unit.
pub struct RepairRuleConfig<F: Field> {
    pub rule: QcRule,
    pub strategy: Box<dyn RepairStrategy<F>>,
    pub param_overrides: HashMap<String, String>,
}

/// Result of running one rule's strategy. Named struct, not a tuple, so `rule_id` (an internal
/// wiring detail repair/pipeline use for failed-tracking) isn't mistaken for a meaningful part
/// of the domain result.
pub struct RepairOutcome {
    pub rule_id: String,
    pub result: RepairResult,
}

pub struct RepairEngine<F: Field> {
    /// Rules with a registered strategy — these are actually dispatched by `run`.
    rules: Vec<RepairRuleConfig<F>>,
    /// All rules, including ones with no strategy ("no_fix") — kept so `check_id_to_rule` can
    /// route every check id, not just the repaired ones. A rule without a strategy still needs
    /// correct merge/attribution upstream in `build_maze`.
    all_rules: Vec<QcRule>,
}

impl<F: Field> RepairEngine<F> {
    /// `rules` — strategy assignments (only for rules with a strategy). `all_rules` — full rule
    /// list, including rules with no strategy. Every rule in `rules` must also appear in
    /// `all_rules` (by `id`); callers (`maze-wasm/src/runner.rs::build_qc_and_repair`) are
    /// responsible for this invariant.
    pub fn new(rules: Vec<RepairRuleConfig<F>>, all_rules: Vec<QcRule>) -> Self;

    /// All check ids across every rule (strategy or not), mapped to their rule id. Used by
    /// `build_maze` to route raw issues to their rule before merging.
    pub fn check_id_to_rule(&self) -> HashMap<CheckId, String>;

    /// Rule ids with a registered strategy, as a lookup set — precomputed once per call rather
    /// than scanned per lookup, since `build_maze` calls this once per repair-loop iteration and
    /// tests it against every active rule that iteration. Rules without a strategy still merge
    /// issues for attribution but must not enter fingerprint tracking or repair dispatch.
    pub fn strategy_rule_ids(&self) -> HashSet<&str>;

    /// `issues` are `(rule_id, Issue)` pairs — the rule-aware merge result built by `build_maze`
    /// (see "Pipeline" below). For each pair: looks up the rule's strategy, calls
    /// `build_params(strategy.params(), param_overrides)`, then calls `apply`.
    pub fn run(
        &self,
        issues: &[(String, Issue)],
        maze: &mut Maze<F>,
        rng: &mut impl RngCore,
        preset_state: &PresetState,
    ) -> Vec<RepairOutcome>;
}
```

- `param_overrides` is per-rule (carried on `RepairRuleConfig`), not a separate map keyed by kind.
- If a `rule_id` in `issues` has no entry in `rules` (no strategy registered): skipped, not included in the result. The pipeline detects unresolved rules via the progress fingerprint guard, same mechanism as before, just keyed by rule id instead of kind.
- Returns one `RepairOutcome` per issue that had a matching rule+strategy.
- Multiple checks may produce the same `IssueKind`; which ones share a rule (and therefore a strategy) is caller-configured, not engine-decided. The pipeline merges issues sharing a *rule* (not a kind) into one `Issue` before calling `RepairEngine::run` — see "Pipeline" below.

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

### InvalidLoopRandomStrategy

Handles `INVALID_LOOP`. Breaks each simple cycle flagged invalid by any producing check (`MinLoopLengthCheck`: shorter than a threshold; `MaxLoopLengthCheck`: longer than a threshold; future checks may flag cycles invalid for other reasons) by removing one random edge from it (plus its reverse, if present) — a wall placed at a random point along the loop. No configurable parameters. The strategy itself is agnostic to *why* a cycle was flagged invalid — it only consumes `IssueData::InvalidLoops`.

**`issue.data` is mandatory for this kind**, not an optional optimization: the producing check already did the (potentially expensive) bounded cycle search, and there's no other channel for the strategy to learn the check's configured threshold or recompute the same result cheaply. This is a per-kind decision (see `quality_control.md`), not a general rule for all strategies.

- If `issue.data` is `Some(IssueData::InvalidLoops { all, invalid })`: cuts the cycles at indices `invalid` into `all`. An empty `invalid` is valid — nothing to break, returns `Fixed` immediately.
- If `data` is missing or the wrong variant: this is a malformed call (should never happen in a normal pipeline run, where the check always attaches data) — returns `Failed`, not "already fixed".
- For each cycle: filters candidates to edges still present in the graph (`Graph::edge(id).is_some()` — an earlier cut in the same `apply` may have already broken a cycle sharing an edge with this one) **and not in `preset_state.preset_edges`** — preset Passage/OneWay connections are never removed, filtered out upfront so the random pick never wastes a sample on a protected edge.
- Picks one random survivor from the filtered candidates and removes it via `try_remove_edge` (which re-checks `preset_state` as a final guard) plus its reverse (`Graph::edge_between(to, from)`, also via `try_remove_edge`), if any. If `try_remove_edge` ever refuses (defensive — shouldn't happen given the upfront filter), the candidate is dropped and another is picked at random; this repeats until either a cut succeeds or no candidates remain for that cycle.
- **Accepted imprecision, not fully solved**: removing an edge can invalidate another cycle in the same batch through subtler graph changes than a shared `EdgeId` (e.g. corridor re-compression). The existence check only catches the shared-edge case; it does not re-validate every remaining cycle entry. Acceptable for a `Random` strategy — a smarter variant that recomputes between cuts is a separate future task if needed.
- **Does not guard connectivity or bridge status**: a cut may disconnect the maze, surfacing as `UnreachableFinish`/`MissingEndpoints` on the next QC pass. Deliberately not handled here — the pipeline's fixpoint loop (`build_maze`, up to `MAX_REPAIR_ITERATIONS`) already exists for exactly this kind of cascading repair, via the already-registered endpoint strategies.
- **No candidate weighting** (segment length, multi-cycle membership, etc.) — the name `Random` is deliberate. `InvalidLoopScoredStrategy` (below) is the weighted alternative on the same issue kind.
- Returns `Fixed { score: None }`.

### InvalidLoopScoredStrategy

Handles `INVALID_LOOP`, same mandatory-`issue.data` contract as `InvalidLoopRandomStrategy` above. An alternative to it — registering one or the other for `INVALID_LOOP` is a config choice (`RepairEngine` maps one strategy per `IssueKind`), not a replacement.

Instead of picking a random edge from each invalid cycle, scores every still-present, non-preset-protected candidate edge in the cycle being cut and picks the highest-scoring one (ties broken via `rng`). The goal: bias cuts toward edges that simultaneously break several invalid loops at once (fewer total cuts needed to clear the issue) while avoiding edges that would also break a cycle the maze is meant to keep.

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `short_overlap_weight` | Float | 5.0 | [0, 100] | Weight per other invalid cycle (in `invalid`) sharing this edge |
| `other_overlap_weight` | Float | 6.0 | [0, 100] | Penalty per valid cycle (in `all`, not in `invalid`) sharing this edge |

For a candidate edge, `short_overlap` counts how many cycles in `all` at indices listed in `invalid` (including the cycle currently being cut — a constant offset shared by every candidate in that cycle, so it doesn't affect which one wins) contain that `EdgeId`; `other_overlap` counts how many cycles in `all` *not* in `invalid` contain it. Score: `short_overlap * short_overlap_weight - other_overlap * other_overlap_weight`.

The overlap counts (`edge -> (short_overlap, other_overlap)`) are computed **once** per `apply` call from the full `all` list, before any cut happens, and reused as-is for every cycle in `short` — including cycles processed later in the same `apply` call, after earlier cycles already had an edge cut. They are not recomputed between cuts, so a later cycle's candidate scores can reflect cycles that have already been (partially) broken by an earlier cut in the same call. Same accepted imprecision as `InvalidLoopRandomStrategy` regarding cross-cycle invalidation after a cut — a smarter variant that recomputes overlap between cuts is a separate future task if needed.

Same candidate filtering (existence + preset-protection), same cut mechanics (`try_remove_edge` plus reverse), same connectivity/bridge-status non-guarantee, and same `Fixed { score: None }` return as `InvalidLoopRandomStrategy`.

## Pipeline

Defined in `maze_core::generation::pipeline`.

```rust
pub const MAX_REPAIR_ITERATIONS: usize = 10;

/// Caps on the repair fixpoint loop. Both bounds are optional and independent — whichever is hit
/// first stops the loop. `None` for both means no hard cap (loop only stops on convergence or
/// no-progress) — callers surfacing this to users should flag that combination, since an
/// unconverging rule set can then loop indefinitely.
pub struct RepairLimits {
    pub max_iterations: Option<usize>,
    pub time_budget_secs: Option<f64>,
}

impl Default for RepairLimits {
    fn default() -> Self {
        RepairLimits { max_iterations: Some(MAX_REPAIR_ITERATIONS), time_budget_secs: None }
    }
}

pub fn build_maze<F: Field>(
    field: F,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<F>,
    repair_engine: RepairEngine<F>,
    preset_state: &PresetState,
    limits: RepairLimits,
) -> (Maze<F>, Vec<Issue>)
```

`build_maze`, `MAX_REPAIR_ITERATIONS`, and `RepairLimits` are re-exported from `maze_core` root.

The second return value is the list of unresolved issues after all repair iterations. An empty vec means all issues were resolved. Callers decide how to handle unresolved issues — the pipeline always returns a maze regardless.

Time is measured via a small internal `now_ms()` helper, not `std::time::Instant` directly — `Instant` panics on `wasm32-unknown-unknown` (no syscall backing it). Native (including `cargo test`) reads a process-lifetime monotonic clock; the `wasm32` target reads `js_sys::Date::now()` instead. Either way, the value is only ever used for measuring elapsed duration within one `build_maze` call.

Logic:

1. Construct `Maze` via `Maze::new(field, graph)` — sets `MazeMeta::empty()` and `MazeAnalysis::default()`.
2. Create `rng = SmallRng::seed_from_u64(seed)`. This single RNG is shared across all repair iterations for cross-iteration determinism.
3. Build `check_id_to_rule: HashMap<CheckId, String>` once via `repair_engine.check_id_to_rule()` — maps every check id across every configured rule (strategy or not) to its rule id.
4. Track `failed: HashSet<String>` — rule ids whose strategy returned `Failed`.
5. Track `previous_fingerprint: Option<Vec<String>>` (sorted rule ids) for progress detection.
6. Record `start_ms = now_ms()` before the loop. Loop, checking at the top of each iteration (before running QC):
   - If `limits.max_iterations` is `Some(max)` and the iteration count already reached `max`: break.
   - If `limits.time_budget_secs` is `Some(budget)` and `now_ms() - start_ms >= budget * 1000.0`: break.
   - Run QC.
   - **Merge, not drop, issues sharing a rule** — multiple checks in the same rule may legitimately produce the same `IssueKind` in one pass (e.g. several reasons a cycle can be invalid; see `quality_control.md`). For each raw issue, route by `issue.single_source_check()` — `Some(check_id)` only when the issue carries exactly one source check, looked up via `check_id_to_rule`; `None` (zero sources, e.g. `CYCLE_ANALYSIS_OVERFLOWED`, or — should never happen for a raw pre-merge issue, guarded by `debug_assert!` — two or more) routes to no rule and the issue is dropped from this iteration's merge map. This is a deliberate fail-safe: a malformed 2+-source raw issue is routed as "no rule" rather than silently picked by an arbitrary single source id, which is what indexing `source_checks()` directly would do in a release build with `debug_assert!` compiled out. An issue with no matching rule isn't lost from the maze's perspective — the final `qc_engine.run` after the loop recomputes fresh and will surface it again if still present. Group routed issues by rule id into a `HashMap<String, Issue>`: the first issue for a rule seeds the entry, any further issue for the same rule is merged into it via `merge_issue` (in `pipeline.rs`) rather than discarded. `merge_issue` unions sources via `Issue::push_source` (deduplicated) and unions `data` per a per-`IssueData`-variant rule — for `IssueData::InvalidLoops`, a three-step canonical merge (normalize → dedup → remap) that treats a cycle as a set of edges, so the same cycle found by two different checks collapses to one entry in the merged `all` instead of appearing twice; `invalid_sources` (per-cycle check attribution) is unioned by canonical key alongside it. The remap step uses `.get()` on the old→new index map, not direct indexing — an out-of-range `invalid` index from a malformed future `Check` is dropped (debug-asserted, not panicked) rather than crashing the pipeline. `IssueData::RegionsNeedingExpansion` (see `quality_control.md`) merges more simply via `merge_regions_needing_expansion` — no remap needed, since `invalid`'s indices are into the one `maze.analysis.scc(&maze.graph)` cache entry shared by every check in the pass, so the same index already means the same region on both sides; only a plain dedup-union of `invalid` and `invalid_sources` is required. A combination of `IssueData` variants with no defined merge rule is a `debug_assert!`/panic in debug builds — there is no silent "keep one side, drop the other" fallback; that was the old dedup bug this merge replaces. Then filter out `failed` rule ids. Order of the resulting active-issues list is **not specified** (it comes from iterating a `HashMap`).
   - **Rules with no registered strategy still merge their issues** (for attribution) but are filtered out before the fingerprint/dispatch step via `repair_engine.strategy_rule_ids()` (a precomputed `HashSet`, not a per-lookup scan) — same final effect as a kind without a strategy being skipped in the old design, just keyed by rule now.
   - If no active issues: break (all resolved).
   - Progress guard: sort `active` by rule id and compare the full `(rule_id, Issue)` list against the previous iteration's, by value (`Issue` derives `PartialEq`, covering `data`/`source_checks`/`details`). Catches true "no progress" (identical rule set with identical issue content) without false-triggering when two iterations produce the same rule with genuinely different issue content (e.g. different cycles flagged invalid).
   - If equal to previous: break (no progress possible).
   - Run repair on active `(rule_id, Issue)` pairs, passing through `preset_state`.
   - Add `Failed` outcomes' `rule_id` to `failed` set.
7. Final QC: return `(maze, remaining_issues)`.

Two rules producing the same `IssueKind` are fully independent through this loop — each gets its own entry in `check_id_to_rule`, its own slot in the merge map, its own fingerprint entry, and its own `failed` tracking. A failure or no-progress break on one rule does not affect the other's repair dispatch.

**Note:** `generate_maze` must be called **before** `build_maze`. `build_maze` only handles metadata, not graph structure.

## Determinism Contract

A `build_maze` call is fully deterministic if:
1. The same graph structure is provided.
2. The same `seed` is used.
3. The same checks and strategies are registered in the same order.
4. The same `param_overrides` are provided.

`RandomEndpointsStrategy` sorts candidate lists before sampling, making results independent of node insertion order. `FarthestEndpointsStrategy` breaks distance ties by minimum `node_id` for determinism.
