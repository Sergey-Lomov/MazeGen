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
pub trait RepairStrategy<T: Tessellation> {
    /// Strategy id — matches `maze-wasm`'s `StrategyConfig.id` (e.g. `"invalid_loop_random"`).
    fn strategy_id(&self) -> &'static str;
    /// The `IssueKind` this strategy itself expects in `issue.kind` when `apply()` is called.
    fn handles(&self) -> IssueKind;
    fn params(&self) -> &'static [StrategyParam] { &[] }
    /// Whether this strategy is experimental (results/performance may be unpredictable).
    /// Surfaced to the UI as a warning, not enforced by core. Default `false`.
    fn is_experimental(&self) -> bool { false }
    /// Nested-strategy slots this strategy accepts, if any — see "Nested strategies" below.
    /// Default: none.
    fn expected_nested(&self) -> &'static [NestedSlot] { &[] }
    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult;
}
```

`MissingRegionsStrategy` is the only strategy currently marked experimental (`is_experimental() -> true`) — its region reuse/growth heuristics are new (GitHub issue #59) and less predictable in result quality and performance than the other built-in strategies.

`snapshots: &mut SnapshotStack` lets a strategy push/pop `(Graph, MazeMeta)` rollback points around a sequence of mutating actions it wants to be able to undo (see `MissingRegionsStrategy`'s reuse/growth attempts) — opt-in, most strategies never call it. One `SnapshotStack` is constructed per `apply()` call by `RepairEngine::run`/`run_timed`, threaded through unchanged into any nested `apply()` call (see below) — nested calls never get their own stack.

`nested: &[NestedStrategyConfig<T>]` carries this rule's configured nested strategies (empty for every strategy without nested slots — the overwhelming majority, which simply ignore the parameter). See "Nested strategies" below.

- `preset_state` carries the same `PresetState` built before generation (`blocked`, `locked_out`, `locked_in`, `preset_connected`, `preset_edges`). Strategies that mutate edges must not remove a directed edge present in `preset_state.preset_edges` — those are Passage/OneWay connections the user placed explicitly. Strategies that don't touch edges (e.g. the endpoint strategies) ignore this parameter.

- Strategies must never call `Graph::add_edge`/`Graph::remove_edge`/`Graph::add_bidirectional_edge` directly (private to `maze-core`) — all edge mutation goes through the `try_*` helpers in `generation::mod`: `try_add_edge` (base-generation, `ElementsConfig`-driven `one_way_chance` coin flip), `try_remove_edge` (removes one directed edge, refusing if it's in `preset_state.preset_edges`), and `try_add_bidirectional_edge(graph, a, b, preset_state) -> bool` — strict "both directions free, or skip the pair" connect: rejects the pair if either direction is blocked by `preset_state`, otherwise adds whichever direction(s) are still missing (completion-aware — an existing one-way edge gets completed into a full passage rather than duplicated). `MissingLoopsRandomStrategy` and `ExpandRegionPassageStrategy` both use `try_add_bidirectional_edge` for this. The only direct `Graph::add_edge` callers left are `generation::preset_state::build_preset_state` (via the public `Graph::build_initial_edge`) and `maze-wasm`'s post-edit graph construction — both build the initial graph from caller-trusted data before generation/repair starts, not mutating an existing maze.

- `params()` returns the descriptor slice for this strategy's configurable parameters. Default impl returns empty slice.
- Receives `rng` from the caller — must not create its own RNG instances.
- Must be deterministic: given the same `maze` state, `rng` state, and `params`, `apply` must produce the same result.
- Must not depend on external or global state.
- May read `maze.analysis` but must not write to it.
- **Idempotency**: if the relevant meta field is already set, return `Fixed` immediately without modifying state or consuming `rng`. This ensures safe re-invocation.
- May read `issue.data` (see `quality_control.md`) — findings the matching `Check` already computed during detection. Whether `data` is optional (cheap to recompute, so `None` falls back gracefully) or effectively required (the data *is* the expensive result, with no other channel to get it) is a **per-`IssueKind` decision**, documented by each strategy for its own kind — there is no blanket rule across all strategies.

### Nested strategies

See GitHub issue #68. A repair strategy can delegate part of its work to other, nested strategies instead of only handling its own issue directly — e.g. a strategy that picks *which* regions need merging, then hands the actual merge off to a strategy that already knows how to merge two regions (`ReduceSccCountStrategy` delegating to `ExpandRegionPassageStrategy`, see "Built-in Strategies" below). The mechanism is general: it also covers a future strategy that owns *several* nested slots (e.g. picking one of N nested strategies at random, or choosing between a "direct passage" and a "teleport" nested strategy depending on region size).

```rust
/// Describes one nested-strategy slot a parent strategy accepts — what `IssueKind` the
/// synthetic `Issue` the parent builds for it will carry, and how many strategies may fill
/// this slot. A strategy with no nested slots (the overwhelming majority) returns `&[]` from
/// `expected_nested()`.
pub struct NestedSlot {
    pub slot_id: &'static str,
    pub kind: IssueKind,
    pub min: usize,
    /// `None` = no upper bound.
    pub max: Option<usize>,
}

/// One nested strategy assignment — same shape as a `RepairRuleConfig`'s own strategy binding,
/// minus the `QcRule` (a nested call has no independent QC rule; its `Issue` is synthesized by
/// the parent, never derived from a check).
pub struct NestedStrategyConfig<T: Tessellation> {
    /// Which of the parent's `expected_nested()` slots this fills — the full slot descriptor,
    /// not just its id. Points into the `&'static [NestedSlot]` the parent's
    /// `expected_nested()` returned — never owned/cloned.
    pub slot: &'static NestedSlot,
    pub strategy: Box<dyn RepairStrategy<T>>,
    pub param_overrides: HashMap<String, String>,
    /// Recursive — a nested strategy can itself have nested strategies.
    pub nested: Vec<NestedStrategyConfig<T>>,
}
```

**`slot_id` is part of a strategy's public configuration API**, not an internal detail — `StrategyConfig.slot_id` (config JSON, `maze-runner`), `maze-wasm`'s `NestedSlotDto.slot_id`, and the web store's `path: string[]` addressing all key off this exact string. Once a strategy ships with a given `slot_id`, renaming it is a breaking config-format change (same stability bar as `strategy_id()`/`IssueKind::as_str()`) — never renamed casually. Within `maze-core`, always reference it via the owning strategy's own exported constant, never a repeated string literal. `slot_id` distinguishes multiple slots that share the same `kind` but play different roles for the parent (e.g. a future "direct passage" slot and a separate "teleport" slot, both `REGION_NEEDS_EXPANSION`, not interchangeable alternatives of one "pick any" slot).

**Dispatch**: `RepairEngine::run`/`run_timed` always pass `&cfg.nested` into `apply()`, for every strategy, whether or not it declares any `expected_nested()` slots — the engine itself carries no per-strategy special-casing; a strategy that has nothing to do with nesting simply never reads the parameter.

**Building `nested` (`maze-runner`)**: `maze-runner/src/runner.rs::build_nested` resolves a `StrategyConfig`'s `nested: Vec<StrategyConfig>` against the parent's `expected_nested()` — purely generically over `expected_nested()`/`handles()`, no strategy id ever compared in this validation logic (only the unavoidable id→struct `match` in `build_strategy` mentions ids at all). For each nested `StrategyConfig`: `slot_id` must be present and match one of the parent's declared slots; the resolved strategy's `handles()` must equal that slot's `kind`; and, once every entry is resolved, each slot's filled count must fall within `[slot.min, slot.max]`. A slot's own nested strategies are validated the same way, recursively — depth is unbounded in the data model (a real second-level nested-capable strategy doesn't exist yet, but nothing stops one).

**Synthesized issues never join the shared issue pool.** A parent strategy that delegates to a nested one builds its own `Issue` for the nested call (e.g. `ReduceSccCountStrategy` builds a `RegionsNeedingExpansion` issue naming the regions it picked) — this issue exists only as a local variable inside the parent's `apply()`, is passed straight into the nested strategy's `apply()`, and is discarded afterward. It is never added to `remaining_issues`, never surfaces in `maze-wasm`'s `IssueDto` list, and never reaches the web UI. The user only ever sees the original top-level issue (e.g. `EXCESSIVE_SCC_COUNT`) that the parent strategy itself was dispatched for.

**Rollback stays the mutating strategy's own responsibility.** A nested call does not introduce a second snapshot mechanism or double bookkeeping — the same `&mut SnapshotStack` passed into the parent's `apply()` is passed straight through into the nested call, unchanged. If the nested strategy mutates the graph and then returns `Failed`, the parent does not roll those mutations back on the nested strategy's behalf; that is exactly the same contract every `RepairStrategy` already has today (e.g. `ExpandRegionPassageStrategy` does not snapshot around its own `try_add_bidirectional_edge` calls) — nesting changes nothing about who owns rollback.

**Debug contract**: every `apply()` should start with `debug_assert_eq!(issue.kind, self.handles())` — a caller-side invariant (the `Issue` passed in must match what the strategy declared it handles), checked defensively in debug builds. Not retroactively added to every pre-existing strategy, but expected of new code (see `ReduceSccCountStrategy` for the pattern) and enforced going forward.

### QcRule and rule-based RepairEngine

A **rule** is the unit `RepairEngine` actually dispatches on — not `IssueKind` directly. A rule is a non-empty set of checks producing one `IssueKind`, with at most one strategy. This lets two checks producing the same `IssueKind` (e.g. `min_loop_length` and `max_loop_length`, both `INVALID_LOOP`) be split into independent rules with different strategies, instead of being forced to share the single strategy a kind-keyed engine would allow.

```rust
/// A user-defined QC rule. Caller-supplied configuration (built by the wasm layer from
/// `GenerateConfig.check_rules`, see `quality_control.md`'s `QcRuleConfig`), not generated or
/// interpreted by core. `id` is opaque — core never inspects its content, only uses it as a
/// lookup/dedup key for one `build_maze` call; it is not required to be stable or unique across
/// different `build_maze` calls.
pub struct QcRule {
    pub id: String,
    pub kind: IssueKind,
    /// Rule-scoped composite check-instance ids (`{rule_id}:{local_id}`, see GitHub issue #60),
    /// minted by `maze-wasm/src/runner.rs::composite_check_id` — not check type ids. Opaque to
    /// core: never parsed back apart, only used as a routing/dedup key (same role the old
    /// `CheckId` enum played, before it was widened to a `String` to let two configured
    /// instances of one check type route independently instead of colliding on one enum
    /// variant — issue #60's original multi-instance motivation, since retired for every check
    /// currently in the registry, but the composite-id mechanism itself stays general).
    pub checks: Vec<String>,
}
```

There is no `CheckId` enum anymore — `maze-wasm/src/runner.rs::build_check` dispatches directly
on `CheckInstanceConfig.type_id: &str` (`match type_id.as_str() { "missing_endpoints" => ..., ... }`)
to pick which `Check<T>` struct to construct. That `type_id` string ("what kind of check is
this") is a different thing from the composite routing id in `QcRule.checks` ("which specific
configured instance produced this issue") — do not confuse the two.

`kind` is a **caller-supplied, caller-trusted invariant**: core never reads it for routing or validation logic (only `id`/`checks` are used by `check_id_to_rule`/`run`/`strategy_rule_ids`), and core does not verify that every check in `checks` actually produces `kind`. That check happens entirely on the caller side, before a `QcRule` is ever constructed — `maze-wasm/src/runner.rs::build_qc_and_repair` resolves each check id's kind and rejects a config where they disagree (`"checks in rule {id} produce different issue kinds"`) before building the `QcRule`. `kind` exists on the struct for callers that need to read it back (e.g. `maze-wasm` re-derives it when building `RepairRuleConfig`, and it round-trips into web-side `StrategySlotVM.kind` for UI display) — core just carries it through unread.

```rust
/// One rule's strategy assignment — RepairEngine's caller-supplied configuration unit.
pub struct RepairRuleConfig<F: Field> {
    pub rule: QcRule,
    pub strategy: Box<dyn RepairStrategy<F>>,
    pub param_overrides: HashMap<String, String>,
    /// Nested strategy assignments for `strategy`'s `expected_nested()` slots, if any — empty
    /// for every strategy without nested slots (the overwhelming majority). See "Nested
    /// strategies" above.
    pub nested: Vec<NestedStrategyConfig<F>>,
}

/// Result of running one rule's strategy. Named struct, not a tuple, so `rule_id` (an internal
/// wiring detail repair/pipeline use for failed-tracking) isn't mistaken for a meaningful part
/// of the domain result.
pub struct RepairOutcome {
    pub rule_id: String,
    pub result: RepairResult,
}

### RepairStage

See GitHub issue #65. A **stage** is a named, ordered group of rule ids — `RepairEngine` dispatches one stage at a time, only rules belonging to the current stage, in stage order. This lets a rule needing another rule's fix as a precondition (e.g. a rule reading `maze.meta.start`/`finish`) be placed in a later stage than the rule that sets them, guaranteeing it never dispatches before its precondition holds.

```rust
/// A user-defined, named, ordered group of `QcRule` ids. Caller-supplied configuration (built
/// by `maze-wasm`/`maze-runner` from `GenerateConfig.stages`, see `quality_control.md`'s
/// `StageConfig`), not generated or interpreted by core beyond grouping. `id` is opaque, same
/// role as `QcRule.id`.
pub struct RepairStage {
    pub id: String,
    pub name: String,
    /// Order is significant for UI/serialization round-trip, not for repair dispatch order
    /// within the stage — `RepairEngine::run` resolves rules by id via `HashMap` lookup
    /// regardless of `rule_ids` order. Includes every rule in this stage, strategy or not (same
    /// role `RepairEngine.all_rules` plays for the whole engine) — a rule without a strategy has
    /// no dispatch consequence but still needs a stage for merge/attribution routing.
    pub rule_ids: Vec<String>,
}
```

**Unassigned rule = caller-side config error, but only if the rule has a strategy.** A rule with a strategy that doesn't appear in any stage's `rule_ids` is a configuration bug — `maze-wasm/src/runner.rs::build_qc_and_repair` rejects it (`"rule {id} not assigned to any stage"`), the same way it already rejects `"checks in rule {id} produce different issue kinds"`. Core itself (`RepairEngine`/`build_maze`) never validates or recovers this — it is a caller-guaranteed invariant of the `stages` argument to `RepairEngine::new`, same as `rules` being a subset of `all_rules` already was. A rule with **no** strategy has nothing to dispatch, so it has no such requirement — its stage membership (if any) only affects UI/serialization, never `build_maze`'s repair loop. An empty `stages: Vec<RepairStage>` (no stage at all) is a valid degenerate case, not an error, when no rule in the config has a strategy.

```rust
pub struct RepairEngine<F: Field> {
    /// Rules with a registered strategy — these are actually dispatched by `run`.
    rules: Vec<RepairRuleConfig<F>>,
    /// All rules, including ones with no strategy ("no_fix") — kept so `check_id_to_rule` can
    /// route every check id, not just the repaired ones. A rule without a strategy still needs
    /// correct merge/attribution upstream in `build_maze`.
    all_rules: Vec<QcRule>,
    /// Ordered stages — `build_maze` dispatches one stage at a time, in this order.
    stages: Vec<RepairStage>,
}

impl<F: Field> RepairEngine<F> {
    /// `rules` — strategy assignments (only for rules with a strategy). `all_rules` — full rule
    /// list, including rules with no strategy. Every rule in `rules` must also appear in
    /// `all_rules` (by `id`); callers (`maze-wasm/src/runner.rs::build_qc_and_repair`) are
    /// responsible for this invariant. `stages` — every rule in `rules` (i.e. every rule with a
    /// strategy) must appear in exactly one stage's `rule_ids`; a rule with no strategy may or
    /// may not appear in a stage. Callers are responsible for both invariants — core does not
    /// validate them (see "Unassigned rule" above).
    pub fn new(rules: Vec<RepairRuleConfig<F>>, all_rules: Vec<QcRule>, stages: Vec<RepairStage>) -> Self;

    /// All check instance ids (composite routing ids, see `QcRule.checks` above) across every
    /// rule (strategy or not), mapped to their rule id. Used by `build_maze` to route raw issues
    /// to their rule before merging. Stage-agnostic — does not change with staging.
    pub fn check_id_to_rule(&self) -> HashMap<String, String>;

    /// Rule ids with a registered strategy, as a lookup set — precomputed once per call rather
    /// than scanned per lookup, since `build_maze` calls this once per repair-loop iteration and
    /// tests it against every active rule that iteration. Rules without a strategy still merge
    /// issues for attribution but must not enter fingerprint tracking or repair dispatch.
    pub fn strategy_rule_ids(&self) -> HashSet<&str>;

    /// Ordered stages this engine dispatches, in dispatch order.
    pub fn stages(&self) -> &[RepairStage];

    /// Rule ids with a registered strategy, belonging to the given stage — precomputed
    /// intersection of `strategy_rule_ids()` and `stage.rule_ids` (precomputed once in `new`,
    /// same rationale as `strategy_rule_ids()`'s own precomputation — `build_maze` calls this
    /// once per fixpoint-loop iteration, not once per stage). `None` only for a `stage_id`
    /// unknown to this engine (never happens for ids obtained via `self.stages()` in the same
    /// call). A known stage with no dispatchable rules (no-strategy-only, or empty) returns
    /// `Some(&empty_set)` — a legitimate degenerate case, not an error. Callers treat "no
    /// dispatchable rules" and "unknown stage" the same way (e.g. `unwrap_or_default()`), since
    /// both mean "nothing to dispatch this iteration".
    pub fn strategy_rule_ids_for_stage(&self, stage_id: &str) -> Option<&HashSet<String>>;

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
- `run`/`run_timed` are unaware of stages — dispatch is by `rule_id` lookup regardless of which stage owns it. Stage filtering happens entirely in `build_maze`, before `run` is ever called (see "Pipeline" below).

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

### ExpandRegionPassageStrategy

Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #51. Merges each flagged undersized SCC region into a neighboring region by adding a full bidirectional passage (two symmetric directed edges, same as any other passage) across a shared tessellation wall, picked by **geometric adjacency** (`field.neighbors`) — not graph adjacency, since two regions can be neighbors with no existing edge between any of their cell pairs at all.

**`issue.data` is mandatory for this kind**: `invalid` (which `maze.analysis.scc(&maze.graph).components` indices are undersized) is the producing check's result — there is no other channel to learn it.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `target_mode` | Enum | `random` | `largest`, `smallest`, `random`, `prefer_needy` | How to pick which neighboring region to merge into |

- If `issue.data` is missing or the wrong variant: returns `Failed` (malformed call, not "already fixed").
- If `invalid` is empty: returns `Fixed` immediately — nothing to expand.
- Processes each flagged region index from `invalid` in turn. For a region already merged away earlier in the same `apply` call (because an earlier merge picked it as the neighbor), it is skipped — the SCC index space is stale for it once a previous merge happened, but no recomputation is needed: skipping is enough since the region's nodes already belong to whatever region absorbed them.
- For a region, candidate neighbors are found by scanning every node in the region, then every `field.neighbors(node)` cell, and looking up that neighbor cell's current SCC component (from `maze.analysis.scc(&maze.graph)`, fetched once at the start of `apply` — the graph hasn't mutated yet at that point). A neighbor cell in the same component is skipped (not a different region). One representative bridging cell pair is kept per distinct neighboring component.
- A candidate pair is rejected if blocked by preset state — both directions must be free (`blocked`/`locked_out`/`locked_in`), same strict "fully bidirectional or skip" contract `MissingLoopsRandomStrategy` uses. An existing one-way edge between the pair is **not** a blocker and gets **no priority** over a fully-walled pair — it's just another valid candidate; the strategy only adds whichever direction is still missing.
- Target selection by `target_mode`:
  - `random`: returns the first geometrically-adjacent, non-blocked neighbor found while scanning — does not enumerate every neighbor first.
  - `largest` / `smallest`: enumerates every distinct neighboring region first, then picks by `components[i].len()`.
  - `prefer_needy`: enumerates every distinct neighboring region first; if any are also in `invalid` (and not already merged away), picks uniformly at random among those via `rng`; otherwise falls back to picking uniformly at random among all neighbors (same as `random`'s effective pool, just without the early-exit).
  - For every mode except `random`, the distinct neighboring component ids are collected into a `Vec` and **sorted** before any tie-breaking (`largest`/`smallest`) or `rng`-indexed pick (`prefer_needy`) — required for the Determinism Contract below, since the ids start out keys of a `HashMap` whose iteration order is randomized per-process and would otherwise make the same seed pick a different neighbor on different runs.
- If a region has no neighboring region at all (isolated field cell, or every candidate pair preset-blocked): that region is skipped, not a hard failure for the whole call.
- After a successful merge, if the absorbed neighbor's component index was also in `invalid`, it is marked merged-away so a later iteration in the same `apply` call doesn't try to expand it again as a separate region.
- Returns `Fixed` if at least one region was successfully merged; `Failed` if none were (e.g. every flagged region was isolated or fully preset-blocked).
- **Out of scope** (separate follow-up strategies for the same issue kind): one-way-passage expansion, teleport expansion.

### MissingRegionsStrategy

Handles `MISSING_REGIONS` — see GitHub issue #59. For each `RegionClass` short of its configured minimum (a `-N` entry in `issue.data`'s `balance_by_class`, see `quality_control.md`'s `IssueData::MissingRegions`), tries to either reuse an existing region or grow a new one and convert it into the target class by adding/removing one-way edges. `+N` entries are not creation targets themselves — they are a **spendable budget** the strategy may draw on, when a candidate region of the matching class is too small, to merge in a geometrically-adjacent same-class region rather than leaving the candidate undersized.

**`issue.data` is mandatory for this kind**, same contract as `InvalidLoopRandomStrategy`/`ExpandRegionPassageStrategy`: `balance_by_class` is the producing check's result, there is no other channel to learn it.

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `locality` | Float | `0.5` | `0.0`–`1.0` | Growth directionality — `0` uniform frontier choice, `1` directional continuation |
| `min_region_size` | Float | `2.0` | `1.0`–`64.0` | Target node count for a newly grown or merged region (rounded to `usize`, floor `1`) |

**Region Balance**: `balance_by_class`'s sign carries the meaning — `-N` is a shortfall (create/convert `N` regions into this class), `+N` is a surplus above the configured minimum (a class with `N` regions to spare). Only negative entries are processed as creation targets, in `RegionClass::as_str()` order for determinism. A class with no entry, or `balance == 0`, is neither a target nor spendable. `Path` is never a valid creation target — a `Path` shortfall item is skipped entirely (no reuse or growth attempt, no attempt budget consumed) — see "Region conversion" below. Splitting an existing `Path` region into two (carving a new one out of it) is a distinct, not-yet-implemented technique; the current strategy has no path to creating a `Path` region at all.

**Internal attempt-budget caps** (not user-configurable — circuit breakers against an unconvergeable graph/preset combination, not algorithm parameters): `MAX_REUSE_ATTEMPTS = 5`, `MAX_GROW_ATTEMPTS = 3`, `MAX_TOTAL_FAILURES = 10` (global, across all classes in one `apply` call — once hit, remaining classes are abandoned for this call). Region conversion itself (`convert_region`) has no attempt cap of its own — see below.

**Region reuse** (tried first for each shortfall item): scans every SCC component whose current class can legally transition to the target (`Path` is never a valid source or target) and that doesn't touch the critical path or nodes already committed earlier in this `apply` call. Candidates are then **filtered** by geometric border with the reachability side(s) the transition needs (e.g. `Unreachable -> Trap` needs an inbound border; `Unreachable -> Alternative` needs both inbound and outbound) — a candidate with zero border on every side it needs is dropped entirely, since no absorbed neighbor can supply the missing border for it (absorption always converts through the *absorbing* region's own border, never grants one to the absorbed region). For a transition needing both sides (`Unreachable -> Alternative`), a candidate is kept if it has **either** border, not necessarily both — the missing side can still be reached later by absorbing a neighbor that borders it. Cut-transitions (`Trap/Alternative -> Unreachable`, `Alternative -> Trap`) need no new border at all and are never filtered.

- Surviving candidates are then ordered by a **two-level priority**: (1) already at or above `min_region_size` sorts ahead of anything still needing absorption to reach it — a candidate that can convert as-is must not lose its `MAX_REUSE_ATTEMPTS` slot to a smaller one that merely has a bigger border-count, since the smaller one may still fail to absorb enough budget to even reach `min_region_size`. (2) within each size tier, descending total border-count, so the ones needing the least help from absorption are tried first; cut-transition candidates (border irrelevant to them) sort ahead of all border-needing ones within their tier, since their odds never depended on border-count. Ties within either level are broken by a seeded shuffle (deterministic for a fixed seed). Up to `MAX_REUSE_ATTEMPTS` candidates are tried.

- **Size-driven merge (opportunistic, not mandatory, `absorb_until_min_size`)**: if a candidate's component is smaller than `min_region_size`, before conversion the strategy tries to grow it edge by edge. Each round, it collects every field-adjacent `(member_node, neighbor_node)` edge pair across ALL components currently bordering the growing set whose `RegionClass` still has surplus budget remaining in `balance_by_class` — not restricted to the candidate's own class, since the budget bookkeeping is per-class regardless of what the candidate itself converts into — into one shared pool, then draws a random pair and attempts a bidirectional bridge between its two nodes. If `preset_state` blocks it (in either direction — a lone one-way success is rolled back, never left as a dangling edge), only that specific pair is discarded and another is drawn from the pool; a single blocked edge no longer disqualifies its whole bordering component; a different edge into the same (or another) component may still succeed. On the first successful bridge, the component is one SCC, so once any of its nodes joins the growing set via a real edge the rest follow through internal connectivity — the whole component is folded in and its full size is debited from its class's budget entry (`remaining = budget - absorbed_size`; the entry is removed once it reaches `<= 0`). The round then restarts: size and borders are re-scanned (possibly exposing new components the absorption just bordered), continuing until `min_region_size` is reached or the edge pool comes up empty with nothing left to try. This loop is best-effort: `try_reuse` has never required a minimum size on its own (only `try_grow` enforces `min_region_size` as a hard floor for newly grown regions) — a candidate that never reaches `min_region_size` because no budget is available anywhere, or every candidate edge is preset-blocked, is still converted at whatever size it has, exactly as it always was. Because each successful bridge is added immediately (not deferred to a separate step), the growing set is already one SCC by the time absorption stops — no additional bridging pass is needed before conversion.
- **Region conversion** (shared by reuse and growth, `convert_region`) is **audit-based**, not a `source`-class transition table: `target` alone determines what `members` needs on each side — `needs_inbound` (an edge from `reachable_from_start` into `members`) for `Trap`/`Alternative`, `needs_outbound` (an edge from `members` into `reachable_to_finish`) for `Alternative` only. `members`' actual current class is never taken as an input parameter (a caller-captured class can go stale — e.g. `try_reuse`'s absorption step mutates the graph after capturing a class snapshot). `convert_region` assumes `members` is already a single coherent SCC by the time it's called (the caller's absorption/growth-and-bridge step is responsible for that) — it doesn't re-verify this up front, only implicitly via the final membership-check, which fails the same way whether `members` was never coherent to begin with or the audit/add steps simply didn't land on `target`.
  1. **Audit**: for each side `members` does NOT need, remove every existing edge of that kind (e.g. converting to `Trap` removes existing outbound edges into `reachable_to_finish` — a region can hold such edges while still classified `Unreachable`/`Trap`, since nothing could reach them to use them; only edges touching a reachability side are ever audited, an edge into an unrelated `Unreachable` region is left alone). A removal blocked by `preset_state` fails the whole candidate immediately.
  2. **Add**: for each side `members` needs but doesn't have after the audit, add one — inbound first if needed, then outbound if needed. Each side tries every field-adjacent candidate edge (shuffled, **no attempt cap** — every candidate is tried before giving up, unlike the old fixed-budget candidate search), each as its own add + membership-check + undo-if-not-yet-matching unit (a candidate pair already connected before the attempt is never touched, so a pre-existing edge unrelated to this attempt is never destroyed).
  3. Final **membership-check**: every node in `members` must resolve to a single SCC classified as `target`.

  Returns failure if `members` isn't coherent to begin with, if any audit removal is preset-blocked, or if no combination of adds lands on `target`. `convert_region` carries no snapshot/restore of its own — a failed call may leave audit removals or partial adds in the graph; the caller (`try_reuse`/`try_grow`) is responsible for a full snapshot before calling it and a restore on failure, and both already do this around the whole candidate (including absorbed neighbors).

**Region growth** (fallback if reuse fails): seeds front-expansion from any node not on the critical path and not already committed this `apply` call (including a node currently classified `Path`, as long as it isn't on the critical path itself — a tree-shaped maze with no cycles has its single SCC classified entirely `Path`, so without this a tree-shaped maze could never grow a Trap/Alternative/Unreachable region from scratch). Up to `MAX_GROW_ATTEMPTS` seeds are tried, prioritized the same way reuse candidates are (border-count with the needed reachability side).

- Front-expansion (`locality`-blended, same directional-continuation behavior as elsewhere) stays within the seed's own SCC component by default. **Cross-component growth**: when the seed's own component is fully absorbed into the growing set before `min_region_size` is reached (the frontier within the component is exhausted), the strategy looks for a geometrically-bordering *different* SCC component whose `RegionClass` still has surplus budget in `balance_by_class` — same budget-debiting rule as reuse's size-driven merge above (`try_open_excess_neighbor`, shared by both paths). If found, that component is folded in wholesale (its full size, not just enough nodes to reach `min_region_size`) and front-expansion continues, now allowed to also reach into the newly-opened component. If no bordering component has budget, growth for this seed fails (`None`) — same as the pre-issue-#59 behavior of failing when the frontier is exhausted, just with one more avenue tried first.
- After growth stops (whether single- or multi-component), every edge between the grown set and the rest of its original parent component(s) is severed (`sever_from_parent`) so the set becomes its own isolated (`Unreachable`) component. No separate post-growth bridging step is needed even when growth crossed into a second component: `try_open_excess_neighbor` already added a real bidirectional edge from `in_region` into the crossed component's entry node at the moment of crossing, before folding it into the frontier — so by the time `sever_from_parent` runs, the grown set is already one coherent SCC and severance only has to cut the *outward*-facing edges to the rest of the original parent component(s), never re-establish internal connectivity.
- Conversion then proceeds identically to the reuse path's audit-based `convert_region` — severance guarantees the grown set starts fully isolated (`Unreachable`), so the audit step's inbound/outbound removal is a no-op here (nothing to remove), and only the add step actually does anything.

**Region Balance Consistency**: the budget map (`excess_budget`, seeded once per `apply` call from `balance_by_class`'s positive entries) is mutated in place as components are absorbed, but every absorption happens inside the same snapshot/restore unit as its candidate's reuse/growth attempt — a failed attempt (membership-check fails, or every connect candidate is exhausted) restores both the graph snapshot **and** a separately-saved copy of the budget map from before the attempt started, so a rolled-back absorption never leaves a debited budget behind. The budget is only ever durably spent by an attempt that reaches a successful, fully committed conversion.

**Critical path constraint**: nodes on the critical path (the shortest start→finish route) are never used as a reuse candidate's member, a growth seed, or a cross-component absorption target, in either the reuse or growth path — checked the same way `ExpandRegionPassageStrategy` and the other region strategies do.

- If `issue.data` is missing or the wrong variant, or `maze.meta.start`/`finish` is unset: returns `Failed`.
- Returns `Fixed` if at least one shortfall item across all classes was successfully created; `Failed` if none were (including the case where every class's item exhausted `MAX_TOTAL_FAILURES` before succeeding).

### ReduceSccCountStrategy

Handles `EXCESSIVE_SCC_COUNT` — see GitHub issue #68. The first (and so far only) user of the nested-strategy mechanism (see "Nested strategies" above): `SccCountCheck`'s issue carries no specific regions to fix (unlike `REGION_NEEDS_EXPANSION`'s `RegionsNeedingExpansion`), so this strategy picks which regions to merge itself, then delegates the actual merge to a nested strategy.

**`issue.data` is mandatory for this kind**: `IssueData::ExcessiveSccCount { max_scc_count }` is the producing check's configured threshold — there is no other channel to learn it.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `merge_priority` | Enum | `smallest` | `smallest`, `largest`, `random` | Which regions to pick for merging first |

**Nested slots**: exactly one, `slot_id = "merge_target"` (exported as `SLOT_MERGE_TARGET`), `kind = REGION_NEEDS_EXPANSION`, `min = 1`, `max = Some(1)` — a single nested strategy, typically `ExpandRegionPassageStrategy`, does the actual merge.

- `scc = maze.analysis.scc(&maze.graph)`; `count = scc.components.len()`. If `count <= max_scc_count`: returns `Fixed { score: None }` immediately (idempotency) without touching `nested` or `rng`.
- Otherwise selects exactly `count - max_scc_count` components to merge, ordered by `merge_priority`: `smallest`/`largest` sort by `(component size, component id)` for deterministic tie-breaking; `random` performs a seeded Fisher-Yates shuffle over component ids via `rng`. Only the first `count - max_scc_count` selected ids are used.
- Builds a synthetic `Issue::with_data(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid: chosen, invalid_sources: {} })` — never published anywhere outside this `apply` call (see "Nested strategies"' synthesized-issues rule above).
- Looks up the nested strategy filling `merge_target` in the `nested` slice passed into `apply` (defensive `debug_assert!` that at most one entry fills the slot, even though `build_nested` already enforces `max: Some(1)` at config-build time) — if none is present, returns `Failed`.
- Delegates: builds the nested strategy's own `StrategyParams` from its `param_overrides`, then calls its `apply()` with the synthetic issue, the same `maze`/`snapshots`/`rng`/`preset_state`, and its own `nested` list (empty for `ExpandRegionPassageStrategy` today, but recursion is supported). Returns whatever `RepairResult` the nested call produces, unchanged — a merge failure (e.g. every candidate region has no geometrically-adjacent neighbor, or every candidate pair is preset-blocked) propagates as `Failed` the same way it would for a direct `ExpandRegionPassageStrategy` dispatch.
- **Does not itself guarantee full convergence to `max_scc_count` in one call** — like every other strategy that delegates region selection to `ExpandRegionPassageStrategy`, chosen regions can end up merging into each other rather than into fresh neighbors, so the net component-count reduction from one `apply()` call can be less than the number of regions picked. Full convergence is the pipeline's fixpoint loop's job across iterations, not a single `apply()` call's contract — same accepted imprecision `ExpandRegionPassageStrategy` itself already documents for its own `invalid` set.

### RemoveTeleportStrategy

Handles `INVALID_TELEPORT` — see GitHub issue #74. The single, fixed fix strategy for every per-teleport validation check (`TeleportDuplicatesConnectionCheck`, `TeleportWaypointDistanceCheck`, and any future per-teleport check reusing this kind): remove each flagged teleport edge outright. No configurable parameters, no alternative strategy — unlike `INVALID_LOOP` (which has both `InvalidLoopRandomStrategy` and `InvalidLoopScoredStrategy`), a teleport is a single edge, not a cycle with multiple candidate edges to choose between, so there is nothing to pick.

**`issue.data` is mandatory for this kind**: `IssueData::InvalidTeleports { invalid }` is the producing check's result (which specific teleport `EdgeId`s to remove) — there is no other channel to learn them.

- If `issue.data` is `Some(IssueData::InvalidTeleports { invalid })`: removes each `EdgeId` in `invalid` via `try_remove_teleport_with_reverse` (`generation::mod`) — looks the edge up by its own id rather than by node pair (necessary because `Graph::edge_between(from, to)` can return an arbitrary edge of any kind between a pair, which would risk removing the wrong one when a `Teleport` and a `Basic` edge coexist in the same direction — the exact scenario `TeleportDuplicatesConnectionCheck` flags), and **also removes the opposite-direction `Teleport` edge, if any** (`Graph::teleport_reverse`), so a two-way teleport is never left silently downgraded to one-way just because a check's edge selector (e.g. an `EntryOnly`-style one) only inspected/flagged one direction. An empty `invalid` is valid — nothing to remove, returns `Fixed` immediately.
- If `data` is missing or the wrong variant: malformed call (should never happen in a normal pipeline run) — returns `Failed`, not "already fixed".
- **Preset protection is `Basic`-only**: `try_remove_edge_by_id` (used internally by `try_remove_teleport_with_reverse` for each direction) checks `preset_state.preset_edges` only when the edge being removed is itself `EdgeKind::Basic`. A `Teleport` edge can never be a preset connection (only Passage/OneWay presets exist, and both always build `EdgeKind::Basic` edges — see `preset_state.rs`/`Specs/post-edit.md`), so a `Teleport` duplicating a preset-protected `Basic` connection is still removable: the protection belongs to the `Basic` edge, not to the `(from, to)` pair as a whole.
- Returns `Fixed { score: None }` whether or not any edges were actually removed (a preset-protected `Basic` edge is never a candidate here in the first place, since `invalid` only ever contains `Teleport` ids).
- **Route protection (GitHub issue #78) lives entirely on the producing checks, not here.** Each per-teleport check has its own `protect_route` param (default `true`, see `quality_control.md`) and simply never includes a route-critical teleport in `invalid` to begin with — `issue.data` never contains an edge this strategy shouldn't remove, so the strategy itself stays a pure "remove everything flagged" executor with no route-awareness of its own.

### TeleportGroupProximityStrategy

Handles `TELEPORT_GROUP_PROXIMITY` — see GitHub issue #75. Distinct from `RemoveTeleportStrategy`: that one removes every flagged teleport edge outright (each edge individually invalid); this one instead resolves a *pair* by removing exactly one of the two teleports it references, since neither edge in a flagged pair is individually invalid on its own.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `priority` | Enum | `problematic` | `random`, `problematic` | Which teleport of a problematic pair to remove |
| `protect_route` | Bool | `true` | — | Prefer the non-route side of a pair instead of removing a route-critical teleport |

- `random` — removes a random teleport from the pair.
- `problematic` — removes whichever teleport in the pair belongs to more *other* problematic pairs (computed once up front over the full pair set the check found, not a running count — so the choice reflects the check's original findings, not whichever edge happens to be processed first).

**`issue.data` is mandatory for this kind**: `IssueData::TeleportProximityPairs { pairs }` is the producing check's result (which teleport pairs are too close) — there is no other channel to learn them.

- If `issue.data` is `Some(IssueData::TeleportProximityPairs { pairs })`: iterates `pairs` in order. Removing a teleport immediately drops every problematic pair that references it — if either side of the current pair was already removed while resolving an earlier pair in the same `apply()` call, that pair is skipped rather than acted on a second time (removal is idempotent by construction, but skipping avoids a pointless removal call and keeps `problematic`'s membership counts meaningful as a static snapshot). An empty `pairs` is valid — nothing to remove, returns `Fixed` immediately.
- **`protect_route` (GitHub issue #78, default `true`)**: when enabled and the side `priority` picked (`to_remove`) lies on the maze's current start→finish route (`graph::route_protection::is_teleport_route_protected` — also true if a two-way teleport's *other* direction is the route hop), the strategy falls back to removing the *other* side of the pair instead — unless that side is also route-critical, in which case neither is removed. Either way the pair still counts as resolved (`Fixed`, not `Failed`) — a route-critical teleport spared by this flag is a deliberate outcome, not an unhandled case. Disabling it reproduces the pre-#78 behavior exactly (`priority`'s pick is always removed, regardless of route).
- If `data` is missing or the wrong variant: malformed call — returns `Failed`, not "already fixed", same contract as `RemoveTeleportStrategy`.
- Uses `try_remove_teleport_with_reverse` (`generation::mod`) for the actual removal, on whichever side (`to_remove` or the `protect_route` `fallback`) actually gets removed — same preset-protection semantics as `RemoveTeleportStrategy` (`Basic`-only; a `Teleport` edge can never itself be preset-protected), and same reverse-removal guarantee: if the removed side is one direction of a two-way teleport, its opposite direction is removed too. Both `EdgeId`s the call reports removed (own + reverse, when present) are added to the `removed` tracking set, not just the one the loop nominally picked — so a later pair referencing the reverse direction is correctly treated as already resolved instead of attempting (and potentially mis-selecting) a fresh removal.
- Returns `Fixed { score: None }` regardless of how many pairs actually needed a removal.
- **Why this strategy (not just its check) also needs `protect_route`**: unlike the per-edge checks (which simply drop a route-critical candidate from `invalid`), `TeleportGroupProximityCheck` only excludes a *pair* when *both* sides are route-critical (see `quality_control.md`) — a pair with exactly one route-critical side is still reported, because the non-route side remains a legitimate removal target. The strategy is what actually decides *which* side to spare in that mixed case.

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
2. Create `rng = MazeRng::seed_from_u64(seed)`. This single RNG is shared across all repair iterations, across every stage, for cross-iteration determinism.
3. Build `check_id_to_rule: HashMap<String, String>` once via `repair_engine.check_id_to_rule()` — maps every check instance's composite routing id (see `QcRule.checks` above) across every configured rule (strategy or not) to its rule id. Stage-agnostic — built once for the whole call.
4. Track `failed: HashSet<String>` — rule ids whose strategy returned `Failed`. Shared across every stage in this call — a rule that failed in an earlier stage stays excluded when a later stage's fixpoint loop merges its issues too (it never will dispatch again, but see below: it's still routed by `check_id_to_rule` for attribution purposes if some other rule shares its `IssueKind`).
5. Record `start_ms = now_ms()` and `iterations_done = 0` once, before any stage — both shared across every stage (see "Stages and the repair budget" below).
6. **Iterate `repair_engine.stages()` in order** (`'stages: for stage in repair_engine.stages()`). For each stage:
   - Look up `dispatchable = repair_engine.strategy_rule_ids_for_stage(&stage.id).unwrap_or_default()` — the `HashSet` of this stage's rule ids that have a registered strategy. If empty (stage is entirely no-strategy rules, or has no rules at all): skip straight to the next stage — QC for this stage's own rules still happens as part of the *next* stage's iteration's QC pass (QC is stage-agnostic, see below), so nothing is lost; just no repair-loop iteration is spent here.
   - Track `previous_fingerprint: Option<Vec<(String, Issue)>>` **reset to `None` at the start of each stage** — the progress guard (below) only compares within the current stage's own iterations; a fresh stage's differing active-rule set must never look like "no progress" carried over from the previous stage, nor mask genuine no-progress within the new stage.
   - Loop, checking at the top of each iteration (before running QC):
     - If `limits.max_iterations` is `Some(max)` and `iterations_done` already reached `max`: record `limit_reached`, **break out of the stage loop entirely** (not just this stage) — the budget is shared across all stages (see below).
     - If `limits.time_budget_secs` is `Some(budget)` and `now_ms() - start_ms >= budget * 1000.0`: same — record `limit_reached`, break out of the stage loop entirely.
     - `iterations_done += 1`.
     - **Run QC — stage-agnostic.** `qc_engine.run` covers every registered check across every rule in every stage, not just the current stage's — the QC engine itself has no concept of stages at all (it's the same `QualityControlEngine` built once for the whole `build_maze` call).
     - **Merge, not drop, issues sharing a rule — also stage-agnostic.** Multiple checks in the same rule may legitimately produce the same `IssueKind` in one pass (e.g. several reasons a cycle can be invalid; see `quality_control.md`). For each raw issue, route by `issue.single_source_check()` — `Some(check_id)` only when the issue carries exactly one source check, looked up via `check_id_to_rule`; `None` (zero sources, e.g. `CYCLE_ANALYSIS_OVERFLOWED`, or — should never happen for a raw pre-merge issue, guarded by `debug_assert!` — two or more) routes to no rule and the issue is dropped from this iteration's merge map. This is a deliberate fail-safe: a malformed 2+-source raw issue is routed as "no rule" rather than silently picked by an arbitrary single source id, which is what indexing `source_checks()` directly would do in a release build with `debug_assert!` compiled out. An issue with no matching rule isn't lost from the maze's perspective — the final `qc_engine.run` after the loop recomputes fresh and will surface it again if still present. Group routed issues by rule id into a `HashMap<String, Issue>`: the first issue for a rule seeds the entry, any further issue for the same rule is merged into it via `merge_issue` (in `pipeline.rs`) rather than discarded. `merge_issue` unions sources via `Issue::push_source` (deduplicated) and unions `data` per a per-`IssueData`-variant rule — for `IssueData::InvalidLoops`, a three-step canonical merge (normalize → dedup → remap) that treats a cycle as a set of edges, so the same cycle found by two different checks collapses to one entry in the merged `all` instead of appearing twice; `invalid_sources` (per-cycle check attribution) is unioned by canonical key alongside it. The remap step uses `.get()` on the old→new index map, not direct indexing — an out-of-range `invalid` index from a malformed future `Check` is dropped (debug-asserted, not panicked) rather than crashing the pipeline. `IssueData::RegionsNeedingExpansion` (see `quality_control.md`) merges more simply via `merge_regions_needing_expansion` — no remap needed, since `invalid`'s indices are into the one `maze.analysis.scc(&maze.graph)` cache entry shared by every check in the pass, so the same index already means the same region on both sides; only a plain dedup-union of `invalid` and `invalid_sources` is required. `IssueData::MissingRegions` merges via `merge_missing_regions` — folds the incoming `balance_by_class` map into the existing one, entry by entry; a class present in both takes the value **further from zero** (the stricter demand/surplus — not the sum, since both checks describe the same underlying shortfall/surplus against the same threshold), a class present in only one side is carried over unchanged. A shortfall and a surplus on the same class from two different instances in one pass is a configuration conflict the merge can't resolve (`debug_assert!`, not silently picked). In practice this merge rarely runs: GitHub issue #60's multi-instance design is retired, so there is normally exactly one active `MinRegionCountCheck` instance, which already reports every off-target class in one issue. A combination of `IssueData` variants with no defined merge rule is a `debug_assert!`/panic in debug builds — there is no silent "keep one side, drop the other" fallback; that was the old dedup bug this merge replaces. Then filter out `failed` rule ids. Order of the resulting active-issues list is **not specified** (it comes from iterating a `HashMap`).
     - **This is where staging actually applies**: filter the merged `by_rule` map to `dispatchable` (this stage's own `strategy_rule_ids_for_stage` result) — **not** `repair_engine.strategy_rule_ids()` (every stage's dispatchable rules combined). A rule belonging to a *later*, not-yet-reached stage may already have an active issue at this point (QC found it, merge routed it) — it is simply dropped by this filter for this iteration, not cached or deferred; once that rule's own stage is reached, QC recomputes fresh on the then-current graph and the issue (if still present) passes the filter normally. Rules with no registered strategy are excluded by the same filter regardless of stage (they were never in `dispatchable` to begin with) — same final effect as before staging existed, just narrower per iteration now.
     - If `active` (post-filter) is empty: **this stage is done** — advance to the next stage (`continue 'stages`), *not* a break out of the whole loop. This is the only way a stage completes normally.
     - Progress guard: sort `active` by rule id and compare the full `(rule_id, Issue)` list against `previous_fingerprint` (this stage's own, reset at stage start — see above), by value (`Issue` derives `PartialEq`, covering `data`/`source_checks`/`details`). Catches true "no progress" (identical rule set with identical issue content) without false-triggering when two iterations produce the same rule with genuinely different issue content (e.g. different cycles flagged invalid).
     - **If equal to previous: no-progress — break out of the stage loop entirely, not just this stage.** Unlike a normal "active is empty" stage completion, no-progress means the current stage's own issues were never actually resolved through the loop — its state is not fully settled. Continuing to a later stage on top of that would repair-dispatch against a maze whose current stage never reached a clean "done" state, so the whole `build_maze` repair pass stops here instead. (This mirrors the pre-#65 behavior exactly: before stages existed, no-progress always stopped the single loop outright — staging changes *what dispatches when*, not this stopping condition.)
     - Run repair on active `(rule_id, Issue)` pairs, passing through `preset_state`.
     - Add `Failed` outcomes' `rule_id` to the shared `failed` set.
7. Final QC (unconditional, regardless of how the stage loop ended — all stages completed, or a limit/no-progress broke out of it early): return `(maze, remaining_issues)`.

Two rules producing the same `IssueKind` are fully independent through this loop — each gets its own entry in `check_id_to_rule`, its own slot in the merge map, its own fingerprint entry (within whichever stage owns it), and its own `failed` tracking. A failure on one rule does not affect another rule's repair dispatch, in the same or a different stage. A no-progress break, however, *does* stop every later stage — see above.

### Stages and the repair budget

`RepairLimits` (`max_iterations`/`time_budget_secs`) is shared across every stage in one `build_maze` call, not reset per stage — `iterations_done`/`start_ms` are declared once, before the first stage, and never reset at a stage boundary. If the budget is exhausted mid-stage, the whole stage loop stops (not just the current stage) — the same `REPAIR_LIMIT_REACHED` issue construction as before staging existed applies unchanged; it just may now fire while a later stage never even got a chance to start. `QC_NO_PROGRESS` similarly always names whichever stage's rules were stuck when the break happened.

**Note:** `generate_maze` must be called **before** `build_maze`. `build_maze` only handles metadata, not graph structure.

## Timing Instrumentation

See GitHub issue #56. `build_maze` collects a per-call timing breakdown — stage totals plus per-check/per-strategy aggregates (total time and call count) — and returns it as a third tuple element:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TimingEntry {
    pub total_ms: f64,
    pub calls: u32,
}

#[derive(Debug, Clone, Default)]
pub struct GenerationTiming {
    pub initial_build_ms: f64,
    pub qc_total_ms: f64,
    pub repair_total_ms: f64,
    pub per_check: HashMap<&'static str, TimingEntry>,
    pub per_strategy: HashMap<&'static str, TimingEntry>,
}

pub fn build_maze<T: Tessellation>(...) -> (Maze<T>, Vec<Issue>, GenerationTiming)
```

- `initial_build_ms` is left at `0.0` by `build_maze` itself — it only runs the QC/repair fixpoint loop, not the initial `generate_maze`/`generate_maze_steps` call. `maze-wasm::run_generate` is the only caller that also runs that stage; it times it with the same `now_ms()` clock and fills `timing.initial_build_ms` in after `build_maze` returns.
- `qc_total_ms`/`per_check` cover every `QualityControlEngine::run` call across the whole `build_maze` call — every fixpoint iteration's QC pass plus the final post-loop QC pass that computes `remaining`.
- `repair_total_ms`/`per_strategy` cover every `RepairEngine::run` call (one per fixpoint iteration that has active issues).
- `per_check` is keyed by **check type id** (`Check::check_type_id()`, e.g. `"min_loop_length"` — the same string as `available_checks()`'s `CheckDescriptor.id`), not by instance id — two active instances of the same type (GitHub issue #60) aggregate into one entry, since the issue calls for per-check-*type* timing, not per-configured-instance.
- `per_strategy` is keyed by **strategy id** (`RepairStrategy::strategy_id()`, e.g. `"invalid_loop_random"` — the same string as `StrategyConfig.id`), not by rule id — two rules backed by the same strategy aggregate into one entry.
- **Nested strategies (see "Nested strategies" above) are not timed separately.** `RepairEngine::run_timed` only wraps the top-level `cfg.strategy.apply` call in a timer; whatever time a parent strategy spends inside a nested `apply()` call it makes internally is included in the elapsed time attributed to the *parent's* `strategy_id` entry, with no separate entry for the nested strategy's own share — even when that same strategy is also independently registered elsewhere as a top-level strategy. A user reading `per_strategy` cannot distinguish a parent's own work from its nested delegate's.
- `QualityControlEngine::run_timed`/`RepairEngine::run_timed` are the timed variants `build_maze` calls instead of the plain `run` — they take an `&mut HashMap<&'static str, (f64, u32)>` accumulator and a `now_ms: impl Fn() -> f64` clock (injected so the same wasm/native-aware clock from `pipeline.rs` is reused), and wrap each `Check::check`/`RepairStrategy::apply` call. Every other caller of `run` (e.g. `build_analytics_snapshot`'s analytics-only QC pass, which has no generation to time) is unaffected — `run` keeps its original untimed signature.
- `now_ms()` (`pipeline.rs`) is `pub`, not private, specifically so `maze-wasm::run_generate` can time the initial-build stage with the same clock.

`maze-wasm`'s `GenerationTimingDto` (see `analytics-web.md`) is the serialized form, surfaced on `MazeSnapshot.timing` — `Some` only for snapshots from a full generation run (`run_generate`); `None` for analytics-only paths (post-edit, `compute_analytics`) that never call `build_maze`.

## Determinism Contract

A `build_maze` call is fully deterministic if:
1. The same graph structure is provided.
2. The same `seed` is used.
3. The same checks and strategies are registered in the same order.
4. The same `param_overrides` are provided.

`RandomEndpointsStrategy` sorts candidate lists before sampling, making results independent of node insertion order. `FarthestEndpointsStrategy` breaks distance ties by minimum `node_id` for determinism.

This also requires a platform-independent RNG: `crate::random::MazeRng` fixes `rand_xoshiro::Xoshiro256PlusPlus` directly rather than using `rand::rngs::SmallRng`, whose backing algorithm depends on `target_pointer_width` (different on native vs wasm32) and would otherwise make the same seed produce a different maze in-browser than in `cargo test`.
