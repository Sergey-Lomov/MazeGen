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

See GitHub issue #113. `RepairStrategy<T>` is now `RepairStrategy<T, I: Issue>` — the concrete
`Issue` type it consumes is a type parameter, not a runtime `handles()` value compared at the
call site. `handles()` is gone entirely: a rule's checks, its strategy, and (through
`ErasedRepairStrategy<T>` — see below) nested-strategy slot validation all agree on `I` by
construction, so the old `debug_assert_eq!(issue.kind, self.handles())` pattern (see the removed
"Debug contract" section) is now a compile error if violated, not a debug-only runtime check.

```rust
pub trait RepairStrategy<T: Tessellation, I: IssueRequirement> {
    /// Strategy id — matches `maze-wasm`'s `StrategyConfig.id` (e.g. `"invalid_loop_random"`).
    fn strategy_id(&self) -> &'static str;
    fn params(&self) -> &'static [StrategyParam] { &[] }
    /// What subset of `I` this strategy needs its producing `Check` to compute — see GitHub
    /// issue #105 and `quality_control.md`'s `IssueRequirement`/`Check::repair_check` sections.
    /// Resolved once by `Rule::new` (not per fixpoint iteration) and threaded into every
    /// `Check::repair_check` call in that rule. Default `I::Requirement::default()` — which
    /// `IssueRequirement`'s contract fixes to mean "compute everything" — so an unmigrated
    /// strategy changes nothing.
    fn requirement(&self, _params: &StrategyParams) -> I::Requirement { I::Requirement::default() }
    /// Whether this strategy is experimental (results/performance may be unpredictable).
    /// Surfaced to the UI as a warning, not enforced by core. Default `false`.
    fn is_experimental(&self) -> bool { false }
    /// Nested-strategy slots this strategy accepts, if any — see "Nested strategies" below.
    /// Default: none.
    fn expected_nested(&self) -> &'static [NestedSlot] { &[] }
    fn apply(
        &self,
        issue: &I,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>);
}

/// Type-erased view of `RepairStrategy<T, I>` for the one place genuine cross-`I` heterogeneity
/// is unavoidable: nested-strategy slots (see "Nested strategies" below), where a parent
/// strategy's own `I` and its nested strategy's `I` are independent. **Not a blanket impl** —
/// `impl<T, I, S: RepairStrategy<T, I>> ErasedRepairStrategy<T> for S` does not compile (the
/// compiler cannot prove `S` implements `RepairStrategy<T, I>` for only one `I`). Every concrete
/// strategy gets its own `impl ErasedRepairStrategy<T> for ConcreteStrategy`, generated once via
/// `impl_erased_repair_strategy!(ConcreteStrategy, ConcreteIssueTy)` (invoked once per strategy,
/// right after its own `impl RepairStrategy<T, ConcreteIssueTy>` block) rather than hand-written.
pub trait ErasedRepairStrategy<T: Tessellation> {
    fn strategy_id(&self) -> &'static str;
    fn handles(&self) -> IssueKind;
    fn params(&self) -> &'static [StrategyParam];
    fn is_experimental(&self) -> bool;
    fn expected_nested(&self) -> &'static [NestedSlot];
    /// Erased form of `RepairStrategy::requirement` — returns `Box<dyn Any>` wrapping the
    /// strategy's own `I::Requirement`. The only caller, `maze-runner`'s `downcast_strategy`,
    /// already knows the concrete `I` (generic over it) and downcasts this back via
    /// `downcast::<I::Requirement>()`. Needed because `requirement()`'s return type is generic
    /// over `I` and can't cross the erased boundary any other way — same rationale as `apply`'s
    /// `&dyn Issue` erasure. **A parent strategy delegating to a nested slot never calls this** —
    /// a nested strategy's issue is synthesized directly by the parent (see "Nested strategies"
    /// below), never produced by a `Check::repair_check` call, so there is no requirement to pass.
    fn requirement_erased(&self, params: &StrategyParams) -> Box<dyn std::any::Any>;
    fn apply(
        &self, issue: &dyn Issue, maze: &Maze<T>,
        rng: &mut dyn RngCore, params: &StrategyParams, preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>);
}
```

`handles()` still exists, but only on `ErasedRepairStrategy<T>` — the erased boundary is exactly
where a runtime `IssueKind` comparison is still needed (`maze-runner`'s `build_nested`, matching a
nested `StrategyConfig` against its parent's declared slot `kind`). Everywhere `I` is statically
known (a `Rule<T, I>`'s own checks and strategy), there is nothing to compare at runtime.

`MissingRegionsStrategy` is the only strategy currently marked experimental (`is_experimental() -> true`) — its region reuse/growth heuristics are new (GitHub issue #59) and less predictable in result quality and performance than the other built-in strategies.

**Mutation-command contract (GitHub issue #118).** `maze: &Maze<T>` is an immutable snapshot — a strategy never mutates it directly. Instead, `apply` inspects `maze` and returns `(RepairResult, Vec<MutationCommand>)`: a list of proposed mutations, applied and individually revalidated against the real `Maze` immediately after `apply` returns (see "Where commands are applied and revalidated" below), not a batch the strategy commits itself. This replaces the pre-#118 contract, where `apply` took `maze: &mut Maze<T>` plus `snapshots: &mut SnapshotStack` (push/pop `(Graph, MazeMeta)` rollback points around a mutating sequence it wanted to undo) and mutated the graph in place.

**Why**: the old contract required strategies handling a *batch* of flagged items in one `apply()` call (e.g. many invalid cycles) to mutate the graph as they went — but a mutation for item 1 could invalidate indices/ids item 2's candidate search had already resolved from pre-mutation state, corrupting the batch mid-flight. GitHub issues #98/#99 worked around this by splitting several batched issue kinds into one-issue-per-item, trading a full QC pass per item for correctness. Under the immutable-snapshot contract, every command in a returned batch is built against the *same*, never-mutated snapshot — index/id staleness within one `apply()` call is structurally impossible, since nothing mutates until after the strategy has already finished deciding. This opens the door to reverting #98/#99's split later (a separate, not-yet-done follow-up — see each split issue's own tracking) without reintroducing the original bug.

```rust
pub enum MutationCommand {
    AddDirectedEdge { from: NodeId, to: NodeId },
    AddBidirectionalEdge { a: NodeId, b: NodeId },
    AddDirectedTeleport { from: NodeId, to: NodeId },
    AddBidirectionalTeleport { a: NodeId, b: NodeId },
    RemoveEdge { id: EdgeId },              // mirrors try_remove_edge_by_id's contract
    RemoveEdgeBetween { from: NodeId, to: NodeId }, // mirrors try_remove_edge's contract
    RemoveEdgeWithReverse { id: EdgeId },   // mirrors try_remove_edge_with_reverse's contract
    RemoveTeleportWithReverse { id: EdgeId }, // mirrors try_remove_teleport_with_reverse's contract
    SetStart(NodeId),   // idempotent -- applied only if meta.start is still unset
    SetFinish(NodeId),  // idempotent -- applied only if meta.finish is still unset
}
```

One variant per existing `generation::mod` mutating helper (`try_*`), not lower-level graph primitives — each variant preserves that helper's own all-or-nothing atomicity as a single revalidatable unit (e.g. `AddBidirectionalEdge` is one command, not two independent `AddDirectedEdge`s, since `try_add_bidirectional_edge`'s "both directions free, or skip the pair" guarantee wouldn't survive independent per-direction revalidation). `SetStart`/`SetFinish` have no paired `try_*`/`cmd_*` helper — they mutate `MazeMeta`, not `Graph`, so there's no edge-feasibility check to share.

`RemoveEdgeWithReverse` (GitHub issue #185) is the same atomicity fix applied to loop-cutting: `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy` (built on `apply_cuts`/`cycle_cut_set`) used to cut a bidirectional passage by pushing two independent `RemoveEdge` commands, one per direction — correct end state, but the debug event tape showed two unrelated single-direction removals instead of "one bidirectional passage removed," and each direction was revalidated independently rather than as one atomic cut. `RemoveEdgeWithReverse { id }` removes the edge at `id` and, if the opposite direction between the same node pair also exists (`Graph::edge_between(to, from)`, not kind-filtered — a bidirectional `Basic` passage is always two `Basic` edges), removes that too, via `try_remove_edge_with_reverse`. Unlike `RemoveTeleportWithReverse` (which resolves its reverse via the kind-gated `Graph::teleport_reverse`, since a `Teleport` edge can coexist with a `Basic` edge in the same direction between a pair), `RemoveEdgeWithReverse`'s reverse lookup is a plain `edge_between` — kept as a separate helper/variant from the teleport one rather than generalized into a single kind-agnostic function, since `teleport_reverse` is Teleport-specific machinery the loop-cutting strategies (which only ever cut `Basic` cycle edges) have no need to route through.

**Building commands** (`cmd_*` functions in `generation/mod.rs`, e.g. `cmd_add_bidirectional_edge`, `cmd_remove_edge_by_id`): read-only counterparts of the mutating `try_*` helpers, checking the same feasibility (preset-state locks, shared with `try_*` via a private predicate like `bidirectional_edge_feasible`/`directed_edge_feasible`/`remove_edge_between_feasible`) and, if feasible, returning the equivalent `MutationCommand`(s) instead of mutating. **Maintenance rule**: every new public mutating helper in `generation::mod` must gain its own `MutationCommand` variant and paired `cmd_*` builder in the same commit — a strategy holding only `&Maze` has no other way to reach it. There is no compiler enforcement for this; kept in mind on review. Add-side `cmd_*` builders take no `&Graph` — every `try_add_*` is completion-aware/idempotent (never fails for a structural reason, only a preset one), so there's no structural dry-run worth sharing on that side; `Graph::can_remove_edge(id)` is the one structural dry-run that matters, used by the remove-side `cmd_*` builders (there's no `can_add_edge` counterpart, for the same reason).

**`DraftMaze` (only `MissingRegionsStrategy`)**: a strategy that needs intermediate mutate-and-inspect state before committing to a final command list (region reuse/growth attempts) works against a `Maze::draft()` — a cheap independent working copy (`field`/`graph`/`meta` cloned, `MazeAnalysis` cache always fresh, never inherited) — wrapped in a thin `DraftMaze<T>` that auto-records every mutation as a `MutationCommand` at the moment it happens, via mirrored `try_add_directed_edge`/`try_add_bidirectional_edge`/`try_remove_edge`/`try_remove_edge_by_id` methods that delegate into the real `generation::try_*` helper and push the matching command on success. The strategy keeps calling mutation methods exactly as it would against a plain `Maze`, just through `.maze` on this wrapper, and the command log falls out for free — no manual parallel command list, no post-hoc graph diff.

`DraftMaze` **nests**: a strategy needing per-candidate rollback inside a larger multi-step attempt (`MissingRegionsStrategy::try_reuse`/`try_grow`) takes `DraftMaze::new(outer.maze.draft())` for each candidate, tries it, and on failure simply drops the inner `DraftMaze` — ordinary Rust drop, nothing to undo. On success, `outer.absorb(inner)` extends `outer`'s own command log with `inner.into_commands()` and replaces `outer.maze` with `inner.maze`'s final state, so the next attempt at `outer`'s level sees this one's committed effect. This replaces the old `SnapshotStack`'s per-candidate `snapshot`/`restore` pair with an ordinary owned value that simply goes out of scope on failure.

**Where commands are applied and revalidated** (`apply_commands`, `quality_control::rule`): `Rule::check_and_repair_typed` calls `strategy.apply(issue, maze, ...)` against an immutable borrow, gets back `(result, commands)`, then applies `commands` to the real `&mut Maze<T>` immediately — the Rule-level commit point, not batched across the whole `Stage`:

```rust
pub struct ApplyOutcome { pub proposed: usize, pub applied: usize }

pub fn apply_commands<T: Tessellation>(
    maze: &mut Maze<T>, preset_state: &PresetState, commands: Vec<MutationCommand>,
    event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
) -> ApplyOutcome;
```

Each command is applied via the real `try_*` helper (the single source of truth for "can this be applied right now," structural + preset state both), in `Vec` order. A command that no longer holds by commit time (its structural precondition changed since the strategy read its snapshot, e.g. a preceding command in the same batch already removed the edge it also targeted) is silently dropped — not an error, does not change the strategy's own returned `RepairResult`, and does not block the rest of the batch from applying. This revalidate-and-drop mechanism is what structurally replaces #98/#99's one-issue-per-item split: a batched issue's stale sub-command is simply skipped instead of corrupting state or requiring the whole batch be rejected.

`event_log` (GitHub issue #147, `Specs/quality_control.md`'s "Narration-level debug instrumentation" section) — when `Some`, `apply_commands` emits one `QcEvent` per command, inline in the same per-command loop that applies it: the mutating mirror variant when the command actually applied, the matching `*Declined` trace variant (same fields) when revalidation dropped it. `None` on every non-debug call — zero-cost opt-out, same pattern as every other instrumented pass in this codebase.

**Contract for partially-applied batches**: a strategy must treat any subset of its own commands landing (the rest silently dropped) as an acceptable outcome — it has no way to detect partial application after the fact (`apply_commands` runs after `apply()` already returned) and must not rely on all-or-nothing application across multiple commands. If two mutations must both apply or neither, they must be one `MutationCommand`, not two (see `AddBidirectionalEdge` above) — not something the strategy checks after the fact.

`nested: &[NestedStrategyConfig<T>]` carries this rule's configured nested strategies (empty for every strategy without nested slots — the overwhelming majority, which simply ignore the parameter). See "Nested strategies" below.

- `preset_state` carries the same `PresetState` built before generation (`blocked`, `locked_out`, `locked_in`, `preset_connected`, `preset_edges`). Strategies that mutate edges must not remove a directed edge present in `preset_state.preset_edges` — those are Passage/OneWay connections the user placed explicitly. Strategies that don't touch edges (e.g. the endpoint strategies) ignore this parameter.

- Strategies must never call `Graph::add_edge`/`Graph::remove_edge`/`Graph::add_bidirectional_edge` directly (private to `maze-core`) — all edge mutation goes through the `try_*` helpers in `generation::mod`: `try_add_edge` (base-generation, `ElementsConfig`-driven `one_way_chance` coin flip), `try_remove_edge` (removes one directed edge, refusing if it's in `preset_state.preset_edges`), and `try_add_bidirectional_edge(graph, a, b, preset_state) -> bool` — strict "both directions free, or skip the pair" connect: rejects the pair if either direction is blocked by `preset_state`, otherwise adds whichever direction(s) are still missing (completion-aware — an existing one-way edge gets completed into a full passage rather than duplicated). `MissingLoopsRandomStrategy` and `ExpandRegionPassageStrategy` both use `try_add_bidirectional_edge` for this. The only direct `Graph::add_edge` callers left are `generation::preset_state::build_preset_state` (via the public `Graph::build_initial_edge`) and `maze-wasm`'s post-edit graph construction — both build the initial graph from caller-trusted data before generation/repair starts, not mutating an existing maze.

- `params()` returns the descriptor slice for this strategy's configurable parameters. Default impl returns empty slice.
- Receives `rng` from the caller — must not create its own RNG instances.
- Must be deterministic: given the same `maze` state, `rng` state, and `params`, `apply` must produce the same result.
- Must not depend on external or global state.
- May read `maze.analysis` but must not write to it.
- **Idempotency**: if the relevant meta field is already set, return `Fixed` immediately without modifying state or consuming `rng`. This ensures safe re-invocation.
- May read `issue`'s own fields (see `quality_control.md`) — findings the matching `Check<T, I>` already computed during detection. Whether a given field is effectively required (the data *is* the expensive result, with no other channel to get it) is a **per-concrete-type decision**, documented by each strategy for its own `I` — there is no blanket rule across all strategies. Unlike the pre-#113 `Option<IssueData>`, a concrete type's fields are never optional at the type level — a strategy either receives the fields it needs (by construction, since `I` is fixed) or the field itself models absence (e.g. an empty `Vec`).

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

/// One nested strategy assignment — same shape as a `Rule`'s own strategy binding, minus the
/// rule id (a nested call has no independent QC rule; its `Issue` is synthesized by the parent,
/// never derived from a check). Erased (`Box<dyn ErasedRepairStrategy<T>>`), not `Box<dyn
/// RepairStrategy<T, I>>` — a nested strategy's `I` is independent of its parent's, see
/// `ErasedRepairStrategy`'s doc comment above.
pub struct NestedStrategyConfig<T: Tessellation> {
    /// Which of the parent's `expected_nested()` slots this fills — the full slot descriptor,
    /// not just its id. Points into the `&'static [NestedSlot]` the parent's
    /// `expected_nested()` returned — never owned/cloned.
    pub slot: &'static NestedSlot,
    pub strategy: Box<dyn ErasedRepairStrategy<T>>,
    pub param_overrides: HashMap<String, String>,
    /// Recursive — a nested strategy can itself have nested strategies.
    pub nested: Vec<NestedStrategyConfig<T>>,
}
```

**`slot_id` is part of a strategy's public configuration API**, not an internal detail — `StrategyConfig.slot_id` (config JSON, `maze-runner`), `maze-wasm`'s `NestedSlotDto.slot_id`, and the web store's `path: string[]` addressing all key off this exact string. Once a strategy ships with a given `slot_id`, renaming it is a breaking config-format change (same stability bar as `strategy_id()`/`IssueKind::as_str()`) — never renamed casually. Within `maze-core`, always reference it via the owning strategy's own exported constant, never a repeated string literal. `slot_id` distinguishes multiple slots that share the same `kind` but play different roles for the parent (e.g. a future "direct passage" slot and a separate "teleport" slot, both `REGION_NEEDS_EXPANSION`, not interchangeable alternatives of one "pick any" slot).

**Dispatch**: `Rule::check_and_repair_typed` always passes its own configured `nested` into `apply()`, for every strategy, whether or not it declares any `expected_nested()` slots — no per-strategy special-casing; a strategy that has nothing to do with nesting simply never reads the parameter.

**Building `nested` (`maze-runner`)**: `maze-runner/src/runner.rs::build_nested` resolves a `StrategyConfig`'s `nested: Vec<StrategyConfig>` against the parent's `expected_nested()` — purely generically over `expected_nested()`/`handles()` on the erased `dyn ErasedRepairStrategy<T>` boundary, no strategy id ever compared in this validation logic (only the unavoidable id→struct `match` in `build_strategy_erased` mentions ids at all). For each nested `StrategyConfig`: `slot_id` must be present and match one of the parent's declared slots; the resolved strategy's `handles()` must equal that slot's `kind`; and, once every entry is resolved, each slot's filled count must fall within `[slot.min, slot.max]`. A slot's own nested strategies are validated the same way, recursively — depth is unbounded in the data model (a real second-level nested-capable strategy doesn't exist yet, but nothing stops one).

**Synthesized issues never join the shared issue pool.** A parent strategy that delegates to a nested one builds its own concrete `Issue` value for the nested call (e.g. `ReduceSccCountStrategy` builds a `RegionNeedsExpansionIssue` naming the regions it picked, then passes `&synthetic as &dyn Issue` into the nested `ErasedRepairStrategy::apply` call) — this issue exists only as a local variable inside the parent's `apply()` and is discarded afterward. It is never added to `remaining_issues`, never surfaces in `maze-wasm`'s `IssueDto` list, and never reaches the web UI. The user only ever sees the original top-level issue (e.g. `EXCESSIVE_SCC_COUNT`) that the parent strategy itself was dispatched for.

**Command concatenation order, not rollback.** A nested call needs no rollback mechanism at all under the immutable-snapshot contract — the same never-mutated `&Maze` the parent received is passed straight through into the nested call, unchanged, so there is nothing for the nested strategy to have mutated in the first place. The parent calls the nested `ErasedRepairStrategy::apply` (with a synthetic issue of the slot's `kind`, against that same `&Maze`), gets back `(result, nested_commands)`, and **concatenates**: its own commands accumulated so far, then `nested_commands` (`own_commands_so_far.extend(nested_commands)` — parent, then nested). If the nested strategy returns `Failed`, its returned commands are simply not incorporated into whatever the parent ultimately returns for that path (see `dispatch_weighted` below for the retry-on-`Failed` case) — there is no mutation to undo, only a `Vec` to discard.

### Weighted nested dispatch (`dispatch_weighted`)

See GitHub issue #90. `maze-core/src/repair/nested_dispatch.rs` provides a shared helper for a
parent strategy that wants to pick *which* of several nested strategies filling one slot to
actually run, weighted-randomly, retrying a different one if the chosen one fails —
`WeightedRegionMergeStrategy` (below) is the first user.

```rust
pub struct WeightedCandidate<'a, T: Tessellation> {
    pub config: &'a NestedStrategyConfig<T>,
    pub weight: f64,
}

pub fn dispatch_weighted<T: Tessellation>(
    issue: &dyn Issue,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    candidates: &[WeightedCandidate<T>],
) -> (RepairResult, Vec<MutationCommand>);
```

`dispatch_weighted` operates entirely at the erased boundary — `issue: &dyn Issue`, not a
concrete `I`, since `NestedStrategyConfig`'s candidates are `Box<dyn ErasedRepairStrategy<T>>`
whose own `I` may differ from the caller's.

- **Who resolves weights**: `dispatch_weighted` itself carries no convention for how a weight is
  derived — it only consumes already-resolved `f64` weights via `WeightedCandidate`. Deriving a
  weight (e.g. reading a `"weight"` key out of `NestedStrategyConfig.param_overrides`) is the
  calling dispatcher's own convention; `WeightedRegionMergeStrategy` is the reference
  implementation of one such convention.
- **Weight contract**: every weight must be finite and `> 0.0` — the caller's responsibility,
  `debug_assert!`-checked defensively on entry, never silently substituted. Empty `candidates`
  returns `Failed` immediately without touching `rng`.
- **Who builds `StrategyParams`**: `dispatch_weighted` itself, via `build_params(strategy.params(),
  Some(&config.param_overrides))` for whichever candidate it is about to try — callers pass raw
  `NestedStrategyConfig`s, never pre-built `StrategyParams`.
- **Selection**: without replacement, weighted-random over the remaining pool (cumulative-weight
  pick via `rng`), repeated until a `Fixed` result or the pool is exhausted.
- **No rollback bookkeeping needed** (GitHub issue #118's immutable-snapshot contract): every
  attempt is called against the same immutable `&Maze` — nothing mutates the real graph mid-call,
  so a `Failed` candidate's returned commands are simply discarded (never concatenated); the next
  weighted pick tries again against the identical unmutated snapshot. A `Fixed` candidate's
  commands are returned as-is.
- **Recursion**: each attempt is called with `&config.nested` passed straight through — a
  nested-under-nested chain is not truncated by this helper.
- **Only `Fixed`/`Failed`**: `RepairResult` is a two-variant enum today; the helper's `match` has
  no wildcard arm on purpose, so a future third variant forces a compile error here rather than a
  silently wrong fallthrough.

**Known limitation, not solved here**: `dispatch_weighted` operates on one `Issue` per call. When
an `Issue` bundles several independent sub-problems (e.g. `RegionsNeedingExpansion`'s `invalid:
Vec<usize>` can list many undersized regions at once), a caller that dispatches once on the whole
bundled issue lets a single weighted pick decide the nested mechanism for the *entire* batch —
the configured weight ratio then governs which mechanism handles the whole issue, not each
sub-problem individually, and with few `dispatch_weighted` calls overall (most of a run's items
folded into one or two big-batch issues) the observed mechanism-choice frequency can drift far
from the configured ratio simply from having too few independent picks to sample from. A per-item
dispatch helper was tried and reverted (GitHub issue #90's follow-up) — it broke `region_merge_core
::run_merge_loop`'s single-SCC-snapshot-per-batch invariant, since re-dispatching per region forced
a fresh (and potentially differently-numbered) SCC snapshot after each region's own merge. The
actual fix is to stop bundling multiple sub-problems into one `Issue` in the first place — see
GitHub issues #98–#101 (splitting `InvalidLoops`/`RegionsNeedingExpansion`/`InvalidTeleports`/
`TeleportProximityPairs` into one `Issue` per element) — not to fragment dispatch inside a
strategy that receives an already-bundled issue.

### Rule, Stage, and the unified QualityControlEngine

See GitHub issue #106 (Stage/Rule ownership), GitHub issue #113 (`Rule<T, I>` typing), and GitHub
issue #170 (removing the no-progress guard and, with it, the erased `run_checks`/`dispatch_repair`
call pair — see below). `QualityControlEngine` is the **single orchestrator** for the whole
check+repair process (or check-only, when no repair is requested) — there is no separate
`RepairEngine` anymore. Control mirrors storage: `QualityControlEngine` owns an ordered list of
`Stage<T>`s; each `Stage` owns `Vec<Box<dyn RuleTrait<T>>>` (erased — every concrete `Rule<T, I>`
implements `RuleTrait<T>`, letting a `Stage` group rules of different `I` together); each concrete
`Rule<T, I>` owns and drives its own checks plus its one strategy, all fixed to the same `I`. Each
level calls into the next — `Stage::check_and_dispatch` calls `RuleTrait::check_and_repair` (the
one erased entry point into a rule's whole check→strategy pipeline; internally this delegates to
`Rule<T, I>`'s own `check_and_repair_typed`), `QualityControlEngine::run_full` calls
`Stage::run_repair` — rather than a flat loop reaching into all three levels at once, which is what
the pre-#106 `QualityControlEngine`+`RepairEngine`+`pipeline.rs` split did (a flat `checks:
Vec<Box<dyn Check<T>>>` on `QualityControlEngine`, a separate `QcRule`/`RepairStage` config-only
hierarchy on `RepairEngine`, re-matched every iteration in `pipeline.rs`).

**Since GitHub issue #170, the merged issue never crosses the `Rule`↔`Stage` boundary as a `Box<dyn
Issue>`.** Pre-#170, `Stage`'s fixpoint loop called `RuleTrait::run_checks` to get a `Box<dyn
Issue>`, held onto it across a no-progress snapshot comparison, then passed it into a separate
`RuleTrait::dispatch_repair(issue, ...)` call — two erased entry points, with the issue itself
living in `Stage`-owned storage in between. Once the no-progress guard was removed, nothing in
`Stage` actually needed that intermediate issue value anymore — only whether checking found
something and what repair did about it. `RuleTrait::check_and_repair` now runs both steps in one
call entirely inside `Rule<T, I>` (`I` never erased), returning a `RuleIterationOutcome` describing
the result instead of an issue the caller has to hold and pass back:

```rust
/// What happened when a rule's `check_and_repair`/`check_and_repair_typed` ran for one fixpoint
/// iteration. Replaces the pre-#170 `Option<Box<dyn Issue>>` (from `run_checks`) plus a separate
/// `Option<(RepairResult, ApplyOutcome)>` (from `dispatch_repair`) — one type instead of two,
/// since the issue itself never needs to reach the caller anymore.
pub enum RuleIterationOutcome {
    /// No check in this rule found anything this iteration.
    NoIssue,
    /// A check found an issue, but this rule has no registered strategy ("no_fix").
    NoStrategy,
    /// A check found an issue and this rule's strategy was dispatched against it.
    Repaired(RepairResult, ApplyOutcome),
}
```

**Why there is no separate `RepairEngine` type**: in this model repair is never an independent
operation over an arbitrary issue set — it always happens in the context of one `Rule`, which
already owns both what to check and how to fix it. The pre-#106 split was only justified by checks
and strategy-bearing rules being two independent flat lists the pipeline had to re-match every
iteration; once a `Rule` owns both, that matching is no longer a separate concern, so neither is a
separate engine class for it. `QualityControlEngine` keeps its name because it is still entirely
about quality — detection and repair — never about generation, which runs before it and stays out
of its scope.

```rust
/// A user-defined QC rule: owns its own checks (each with a `local_id`, unique within this
/// rule) and, optionally, one repair strategy, all producing/consuming the same concrete `I`.
/// `None` strategy = "no_fix" — the rule's checks still run and merge for attribution, but
/// nothing is dispatched to fix what they find. No `kind: IssueKind` field — `I` fixes it at
/// the type level (see `IssueKindConst`), eliminating the pre-#113 possibility of a `Rule`
/// whose checks disagree with a separately-supplied `kind`.
pub struct Rule<T: Tessellation, I: Issue + IssueMerge> {
    pub id: String,
    checks: Vec<(String, Box<dyn Check<T, I>>)>,
    strategy: Option<RuleStrategy<T, I>>, // strategy + param_overrides + nested, private
}

impl<T: Tessellation, I: Issue + IssueMerge> Rule<T, I> {
    pub fn new(
        id: String,
        checks: Vec<(String, Box<dyn Check<T, I>>)>,
        strategy: Option<Box<dyn RepairStrategy<T, I>>>,
        param_overrides: HashMap<String, String>,
        nested: Vec<NestedStrategyConfig<T>>,
    ) -> Self;

    /// `(local_id, &dyn Check<T, I>)` pairs, in configured order — the only way anything outside
    /// this module observes this rule's checks.
    pub fn checks(&self) -> impl Iterator<Item = (&str, &dyn Check<T, I>)>;

    pub fn has_strategy(&self) -> bool;

    /// Runs every check in this rule via `Check::repair_check`, folding all raw issues into at
    /// most one merged `I` via `IssueMerge::merge` (moved here from `pipeline.rs` — see
    /// "Pipeline" below) — this is where rule-level issue merging naturally lives now, since a
    /// rule owns its own check dispatch. `None` if no check in this rule found anything this call.
    /// `pub` (not just an internal step of `check_and_repair_typed` below) so tests can exercise
    /// per-rule check-merge behavior directly, without needing a real repair dispatch.
    pub fn run_checks_typed(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Option<I>;

    /// Runs every check via `Check::report_check` instead — one `I` per flagged problem
    /// instance, no merge (see GitHub issue #102). Used by both the final `build_maze` report and
    /// `QualityControlEngine::run_check_only`.
    pub fn report_checks_typed(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Vec<I>;

    /// Runs this rule's checks (`run_checks_typed`) then, if a check found anything and this rule
    /// has a registered strategy, dispatches repair against it immediately — builds
    /// `StrategyParams`, calls `apply` itself (no separate engine involved), then immediately
    /// applies and revalidates the returned commands against the real `maze` via `apply_commands`
    /// (see "Mutation-command contract" above) — the Rule-level commit point, not batched across
    /// the whole `Stage`. Returns a `RuleIterationOutcome` (see above) describing what happened —
    /// the merged issue itself never leaves this call (GitHub issue #170): unlike the pre-#170
    /// `run_checks_typed`/`dispatch_repair_typed` pair, where the caller held the issue between
    /// two separate calls, this is the only entry point, and `I` never crosses back out.
    ///
    /// `per_check`/`per_strategy` are separate timing accumulators (not one shared map) so
    /// `GenerationTiming.per_check`/`per_strategy` stay distinct on the caller side. `qc_ms`/
    /// `repair_ms` accumulate this call's own elapsed time into the caller's stage-level totals
    /// (`GenerationTiming.qc_total_ms`/`repair_total_ms`) — `qc_ms` covers `run_checks_typed`,
    /// `repair_ms` covers `apply`+`apply_commands`.
    pub fn check_and_repair_typed(
        &self, maze: &mut Maze<T>, rng: &mut dyn RngCore, preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        qc_ms: &mut f64, repair_ms: &mut f64,
        now_ms: &dyn Fn() -> f64, event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    ) -> RuleIterationOutcome;
}

/// Type-erased view of `Rule<T, I>` for the one place genuine cross-`I` heterogeneity is
/// unavoidable: `Stage.rules` (a `Stage` deliberately groups rules of different `I` together).
/// The check→strategy pipeline itself never crosses this boundary — `I` stays entirely inside
/// `Rule::check_and_repair_typed`; `check_and_repair` below is the only erased entry point into it.
pub trait RuleTrait<T: Tessellation> {
    fn id(&self) -> &str;
    fn report_checks(&self, maze: &Maze<T>, rng: &mut dyn RngCore, timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64) -> Vec<Box<dyn Issue>>;
    fn check_and_repair(
        &self, maze: &mut Maze<T>, rng: &mut dyn RngCore, preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        qc_ms: &mut f64, repair_ms: &mut f64,
        now_ms: &dyn Fn() -> f64, event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    ) -> RuleIterationOutcome;
}
```

There is no `kind: IssueKind` field on `Rule<T, I>` to independently agree with anymore — the
pre-#113 caller-trusted invariant ("every check in a `Rule` actually produces `kind`", validated
by `maze-runner/src/runner.rs::build_qc_and_repair`'s `"checks in rule {id} produce different
issue kinds"` check) is now a type error at construction: a `Box<dyn Check<T, I>>` for the wrong
concrete type simply cannot be pushed into a `Vec<(String, Box<dyn Check<T, I>>)>`.
`maze-runner`'s factory (`build_rule_for!` macro, one arm per concrete `I`) still runs a runtime
check — but only for turning an untyped `type_id: &str` from JSON into a compile-time-known `I`
choice (a config-parsing concern, not something `Rule<T, I>` itself needs to verify).

```rust
/// Bundles the timing accumulators `Stage::run_repair` threads through one fixpoint loop —
/// `per_check`/`per_strategy` in the `(total_ms, calls)` tuple form the pre-#106 `run_timed`
/// used, `qc_total_ms`/`repair_total_ms` the stage-level totals. The caller
/// (`QualityControlEngine::run_repair_stages`) folds `per_check`/`per_strategy` into
/// `GenerationTiming`'s `TimingEntry` maps once, after every stage has run. Bundled into one
/// struct rather than four separate `&mut` parameters so `run_repair`'s signature doesn't grow
/// every time a new timing dimension is added.
pub(crate) struct TimingSink<'a> {
    pub per_check: &'a mut HashMap<&'static str, (f64, u32)>,
    pub per_strategy: &'a mut HashMap<&'static str, (f64, u32)>,
    pub qc_total_ms: &'a mut f64,
    pub repair_total_ms: &'a mut f64,
}

/// A user-defined, named, ordered group of `Rule`s — drives its own fixpoint repair loop over
/// only its own rules' checks (stage-scoped QC — the pre-#106 stage-agnostic pass, which ran
/// every check across every stage on every iteration regardless of which stage was active, is
/// gone). See GitHub issue #65 for the original stage concept, GitHub issue #113 for why `rules`
/// is `Box<dyn RuleTrait<T>>` (erased) rather than `Rule<T>` (a `Stage` deliberately groups rules
/// of different concrete `Issue` types together).
pub struct Stage<T: Tessellation> {
    pub id: String,
    pub name: String,
    rules: Vec<Box<dyn RuleTrait<T>>>,
}

impl<T: Tessellation> Stage<T> {
    pub fn new(id: String, name: String, rules: Vec<Box<dyn RuleTrait<T>>>) -> Self;
    pub fn rules(&self) -> &[Box<dyn RuleTrait<T>>];

    /// Drives this stage's own fixpoint repair loop until convergence (no active issues) or the
    /// shared `budget` (see `QualityControlEngine` below) is exhausted. Returns `StageOutcome`
    /// describing which — the caller (`QualityControlEngine::run_repair_stages`) decides what
    /// that means for the rest of the stage sequence; a `Stage` never knows whether it is the
    /// last one or not. There is no separate no-progress guard (see GitHub issue #170) — the
    /// pre-#170 value-equality and "commands dropped" guards were unreliable and easily defeated
    /// (e.g. two rules whose issue content genuinely differs every iteration while the graph
    /// never converges), so termination is guaranteed entirely by `budget`, which `RepairLimits`
    /// requires to actually bound the loop (see that type's doc comment below).
    pub(crate) fn run_repair(
        &self, maze: &mut Maze<T>, rng: &mut dyn RngCore, preset_state: &PresetState,
        budget: &mut RepairBudget,
        timing: &mut TimingSink,
        now_ms: impl Fn() -> f64,
        event_log: Option<&mut ScopeGuard<QcEvent>>,
    ) -> StageOutcome;

    /// One report pass over every rule in this stage (`RuleTrait::report_checks` semantics).
    pub(crate) fn run_report(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: impl Fn() -> f64,
    ) -> Vec<Box<dyn Issue>>;
}

pub(crate) enum StageOutcome {
    Done,
    LimitReached(RepairLimitKind),
}
```

Inside `run_repair`, the per-rule `failed` set is a **local variable** — not a field on `Stage` —
living only for the duration of one `run_repair` call, resetting naturally on the next call rather
than needing an explicit reset at a stage boundary. A rule id never crosses a stage boundary (a
rule is configured into exactly one stage), so `failed` never needs to be shared beyond the stage
that owns it either.

`event_log` (GitHub issue #147) — see `Specs/quality_control.md`'s "Narration-level debug
instrumentation" section for the full scope shape (`"stage <id>"` → `"iteration N"` → `"rule
<id>"`) and event catalog this threads through `run_repair`/`check_and_dispatch` down to
`apply_commands`. `None` on every non-debug call.

```rust
/// The single orchestrator for the whole check+repair process, or check-only when no repair is
/// requested. Owns an ordered list of `Stage`s.
pub struct QualityControlEngine<T: Tessellation> {
    stages: Vec<Stage<T>>,
}

impl<T: Tessellation> QualityControlEngine<T> {
    pub fn new(stages: Vec<Stage<T>>) -> Self;

    /// Ordered stages this engine dispatches, in dispatch order.
    pub fn stages(&self) -> &[Stage<T>];

    /// Full check+repair: a fixpoint repair loop per stage (in order, sharing one
    /// `RepairBudget`), then an unconditional final report pass over every stage. Replaces the
    /// combined pre-#106 role of `QualityControlEngine`+`RepairEngine`+`pipeline.rs`'s own loop.
    pub fn run_full(
        &self, maze: &mut Maze<T>, rng: &mut dyn RngCore, preset_state: &PresetState,
        limits: RepairLimits, now_ms: impl Fn() -> f64,
    ) -> (Vec<Box<dyn Issue>>, GenerationTiming);

    /// Check-only mode — no repair, `report_check` semantics everywhere (one issue per flagged
    /// problem instance). Replaces both the pre-#106 final-report pass inside `build_maze` and
    /// `build_analytics_snapshot`'s own QC-only call — issue #106 unifies these into one code
    /// path with one semantics (a deliberate behavior change for the analytics caller, which
    /// previously used `repair_check`-batched semantics — see GitHub issue #106's discussion).
    pub fn run_check_only(&self, maze: &Maze<T>, rng: &mut dyn RngCore, now_ms: impl Fn() -> f64) -> Vec<Box<dyn Issue>>;
}
```

The shared repair budget (`RepairLimits` → `iterations_done`/`start_ms`, plus which limit fired)
is **not** reset per stage — `QualityControlEngine::run_repair_stages` constructs one
`RepairBudget` before the first stage and passes the same `&mut RepairBudget` into every
`stage.run_repair(...)` call in sequence. A stage reporting `StageOutcome::Done` simply advances
to the next stage; `LimitReached` stops the whole sequence (mirrors the pre-#106 pipeline's
`break 'stages'` — a spent budget in one stage means later stages never get a chance to run
against a maze whose current stage never reached a clean state).
No `'stages` label is needed in the new code: the inner fixpoint loop lives entirely inside
`Stage::run_repair`, which simply returns a `StageOutcome` instead of breaking through a label —
`run_repair_stages` sees only one loop level, an ordinary `for` over `self.stages`.

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

Handles `MISSING_ENDPOINTS`. No configurable parameters. Places start and finish at nav-graph nodes chosen to be far apart (distance measured in tile count — edge weight = `path.len() - 1`), via a fast two-Dijkstra sweep — **not** an exhaustive search over all pairs.

**Known limitation (heuristic, not a guaranteed diameter)**: the two-Dijkstra sweep (pick a node, find the farthest node from it, then the farthest node from *that*) is the standard approach for finding a graph's diameter, but it is only exact on trees. On a general graph with cycles — which any maze with loops is — the sweep can converge on a pair that is close to the maximum but not actually it. Confirmed on a real repro (GitHub issue #95, 5x5 QC-only preset graph): the sweep picked a pair at tile-distance 12 while the true maximum over all pairs, found by brute force, was 14. `ScoredEndpointsStrategy` does an exhaustive search instead and is not affected by this; use it when an exact result matters more than speed.

- If both `maze.meta.start` and `maze.meta.finish` are `Some`: returns `Fixed` immediately.
- Empty nav graph: returns `Failed`.
- **Neither set**: picks a random nav node via `rng`. Runs reverse Dijkstra (incoming edges) from that node to find the node farthest *upstream* — candidate `start` (landing in a source SCC). Then runs forward Dijkstra from that candidate to find the farthest reachable node — candidate `finish`. Since the graph is directed, `dist(candidate_start -> candidate_finish)` can differ from `dist(candidate_finish -> candidate_start)` (see GitHub issue #95: the two-Dijkstra sweep only measures the forward direction, and on a directed graph that isn't guaranteed to be the longer one even though it identifies the correct pair of nodes). `orient_farthest_pair` runs a forward Dijkstra in both directions between the candidate pair and swaps `start`/`finish` if the reverse direction turns out longer; falls back to the original orientation if the reverse direction is unreachable. This orientation fix is independent of, and does not solve, the sweep's tree-only-exactness limitation described above.
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
| `teleport_weight` | Float | 5.0 | [0, 100] | Weight applied to number of teleport nav edges crossed on path |

Score formula: `path_tiles * path_weight + junction_count * junction_weight + oneway_count * oneway_weight + teleport_count * teleport_weight`

- Junction: nav node with ≥ 3 distinct neighbors (union of incoming and outgoing).
- One-way edge: nav edge `(u → v)` where no reverse edge `(v → u)` exists.
- Teleport edge: nav edge whose corridor `path` crosses a `Teleport`-kind edge in the underlying maze graph.
- Path cost (for Dijkstra): edge weight = `path.len() - 1` (tile count).

Behavior per case:
- Both set: returns `Fixed` immediately.
- Empty nav graph: returns `Failed`.
- **Neither set**: finds the `(start, finish)` pair with the highest score across all nav node pairs. Runs Dijkstra for each candidate start.
- **Only start set**: fixes start, searches for best finish.
- **Only finish set**: fixes finish, searches for best start.
- No reachable path found: returns `Failed`.

### InvalidLoopRandomStrategy

Handles `INVALID_LOOP`. Breaks each simple cycle flagged invalid by any producing check (`LoopLengthCheck`: shorter/longer than a threshold, depending on `comparison`; future checks may flag cycles invalid for other reasons) by removing one random edge from it (plus its reverse, if present) — a wall placed at a random point along the loop. No configurable parameters. The strategy itself is agnostic to *why* a cycle was flagged invalid — it only consumes `InvalidLoopIssue`.

`InvalidLoopIssue`'s fields are never optional at the type level (unlike the pre-#113 `Option<IssueData>`), but their content depends on `requirement()` (see GitHub issue #105, `quality_control.md`'s `IssueRequirement` section) — the producing check already did the (potentially expensive) bounded cycle search, and there's no other channel for the strategy to learn the check's configured threshold or recompute the same result cheaply. `requirement()` returns `InvalidLoopRequirement::empty()` — `apply` only ever reads `all`/`invalid` through `apply_cuts`, which seeds its pending set from `invalid`'s indices and only ever shrinks it (`discard_cycles_with_edge`'s `retain`), so a valid cycle's entry is never read; `invalid_sources` isn't read at all. A re-indexed `all` containing only the invalid cycles (the base layer, `VALID_CYCLES` unset) produces the identical result — proven by a dedicated test (`apply_result_is_identical_for_full_and_invalid_only_requirement`) that cuts the same seed against both requirement values and asserts the same edges survive.

- `issue: &InvalidLoopIssue` gives `all`/`invalid` directly: cuts the cycles at indices `invalid` into `all`. An empty `invalid` is valid — nothing to break, returns `Fixed` immediately.
- If `data` is missing or the wrong variant: this is a malformed call (should never happen in a normal pipeline run, where the check always attaches data) — returns `Failed`, not "already fixed".
- For each cycle: filters candidates to edges still present in the graph (`Graph::edge(id).is_some()` — an earlier cut in the same `apply` may have already broken a cycle sharing an edge with this one) **and not in `preset_state.preset_edges`** — preset Passage/OneWay connections are never removed, filtered out upfront so the random pick never wastes a sample on a protected edge.
- Picks one random survivor from the filtered candidates and removes it via `try_remove_edge` (which re-checks `preset_state` as a final guard) plus its reverse (`Graph::edge_between(to, from)`, also via `try_remove_edge`), if any. If `try_remove_edge` ever refuses (defensive — shouldn't happen given the upfront filter), the candidate is dropped and another is picked at random; this repeats until either a cut succeeds or no candidates remain for that cycle.
- **Accepted imprecision, not fully solved**: removing an edge can invalidate another cycle in the same batch through subtler graph changes than a shared `EdgeId` (e.g. corridor re-compression). The existence check only catches the shared-edge case; it does not re-validate every remaining cycle entry. Acceptable for a `Random` strategy — a smarter variant that recomputes between cuts is a separate future task if needed.
- **Does not guard connectivity or bridge status**: a cut may disconnect the maze, surfacing as `UnreachableFinish`/`MissingEndpoints` on the next QC pass. Deliberately not handled here — the pipeline's fixpoint loop (`build_maze`, up to `MAX_REPAIR_ITERATIONS`) already exists for exactly this kind of cascading repair, via the already-registered endpoint strategies.
- **No candidate weighting** (segment length, multi-cycle membership, etc.) — the name `Random` is deliberate. `InvalidLoopScoredStrategy` (below) is the weighted alternative on the same issue kind.
- Returns `Fixed { score: None }`.

### InvalidLoopScoredStrategy

`RepairStrategy<T, InvalidLoopIssue>`, same field-shape contract as `InvalidLoopRandomStrategy` above. An alternative to it — registering one or the other for `INVALID_LOOP` is a config choice (each `Rule` binds exactly one strategy), not a replacement.

Instead of picking a random edge from each invalid cycle, scores every still-present, non-preset-protected candidate edge in the cycle being cut and picks the highest-scoring one (ties broken via `rng`). The goal: bias cuts toward edges that simultaneously break several invalid loops at once (fewer total cuts needed to clear the issue) while avoiding edges that would also break a cycle the maze is meant to keep.

Unlike `InvalidLoopRandomStrategy`, `requirement()` returns `InvalidLoopRequirement::VALID_CYCLES` — the `other_overlap` scoring term below walks every valid cycle in `all` to penalize edges shared with a loop the maze must keep, so the `VALID_CYCLES` layer is required by the algorithm itself, not left set out of inertia.

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `short_overlap_weight` | Float | 5.0 | [0, 100] | Weight per other invalid cycle (in `invalid`) sharing this edge |
| `other_overlap_weight` | Float | 6.0 | [0, 100] | Penalty per valid cycle (in `all`, not in `invalid`) sharing this edge |

For a candidate edge, `short_overlap` counts how many cycles in `all` at indices listed in `invalid` (including the cycle currently being cut — a constant offset shared by every candidate in that cycle, so it doesn't affect which one wins) contain that `EdgeId`; `other_overlap` counts how many cycles in `all` *not* in `invalid` contain it. Score: `short_overlap * short_overlap_weight - other_overlap * other_overlap_weight`.

The overlap counts (`edge -> (short_overlap, other_overlap)`) are computed **once** per `apply` call from the full `all` list, before any cut happens, and reused as-is for every cycle in `short` — including cycles processed later in the same `apply` call, after earlier cycles already had an edge cut. They are not recomputed between cuts, so a later cycle's candidate scores can reflect cycles that have already been (partially) broken by an earlier cut in the same call. Same accepted imprecision as `InvalidLoopRandomStrategy` regarding cross-cycle invalidation after a cut — a smarter variant that recomputes overlap between cuts is a separate future task if needed.

Same candidate filtering (existence + preset-protection), same cut mechanics (`try_remove_edge` plus reverse), same connectivity/bridge-status non-guarantee, and same `Fixed { score: None }` return as `InvalidLoopRandomStrategy`.

### InvalidLoopGroupSelectStrategy

Handles `INVALID_LOOP_GROUP` — see GitHub issue #183. `MaxLoopDensityCheck`/`MaxLoopsCountCheck` (`quality_control.md`) both flag their *entire* field-wide cycle set `invalid` at once (no per-check subset selection); this strategy is where the actual "which loops to break, and how many this pass" decision lives. It picks a *sample* of the flagged cycles (sized by `sample_mode`/`sample_size`, ordered by `selection_mode`) and resolves them one at a time by delegating to a nested `RepairStrategy<T, InvalidLoopIssue>` (typically `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy`) filling the `cut_target` nested slot (`kind: INVALID_LOOP`, `min: 1`, `max: Some(1)`).

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `selection_mode` | Enum | `random` | `random`, `shortest`, `longest` | Which flagged cycles enter the sample first, and the tie-break/pick criterion within it |
| `sample_mode` | Enum | `count` | `count`, `percent` | Whether `sample_size` below is an absolute cycle count or a percentage of `issue.invalid.len()` |
| `sample_size` | Float | `1.0` | `[0, 100_000]` | Sample size, interpreted per `sample_mode` |

**Sample sizing**: `count` mode takes `sample_size` cycles literally (rounded up via `ceil`); `percent` mode takes `ceil(sample_size / 100 * issue.invalid.len())`. Either way the result is clamped to `[1, issue.invalid.len()]` — at least 1 (there is always something to do when `issue.invalid` is non-empty, the only case `apply` reaches this far for) and never more than what's actually flagged.

`issue.invalid`'s indices are first reordered by `selection_mode` — `shortest`/`longest` sort by edge count (ties broken by ascending original index, for determinism), `random` does a seeded Fisher-Yates shuffle through the strategy's `rng` — then the first `sample_size` (after sizing) become the sample; the rest of `issue.invalid`, plus all of `issue.valid`, become `valid`-context for every synthetic issue built this call.

**Queue processing**: the sample is a `VecDeque`. Each iteration pops the front cycle as the nested strategy's target and synthesizes an `InvalidLoopIssue` where every *other* still-pending sample cycle is `invalid` context (so the nested strategy's own overlap-scoring, if any, sees the rest of the batch) and every non-sampled cycle is `valid` context — then delegates via the nested strategy's `apply`. After each nested call, `removed_edge_ids` (see `repair::command`) extracts every `EdgeId` the call reported removing, and any remaining queued cycle (in the sample queue or the valid-context list) sharing one of those edges is dropped entirely — it's already broken by the same cut, so it is neither re-offered as a future target nor kept around as context, distinct from a cycle that simply wasn't sampled this round. `removed_edge_ids` only recognizes `RemoveEdge`/`RemoveEdgeWithReverse`/`RemoveTeleportWithReverse` (not `RemoveEdgeBetween`, which addresses by node pair, not `EdgeId`) — this is treated as a heuristic, not a guarantee; a cycle missed by this dedup just gets re-offered to the nested strategy later and discovered already-broken there (e.g. via `candidate_edges`'s own already-removed filtering), never causing incorrect behavior.

The loop ends when the sample queue empties. Returns `Fixed` (with every nested call's commands concatenated, in order — "parent, then nested" per this section's own command-concatenation rule) if **at least one** nested call in the batch succeeded, even if a later cycle in the same batch failed; returns `Failed` (no commands) only if **every** nested call in the batch failed. A mix of successes and failures within one sample is not itself surfaced beyond "at least one worked."

Cannot translate the nested strategy's own `requirement()` into `InvalidLoopGroupRequirement` — `Rule::new` resolves a strategy's `requirement()` from `&self, params` alone, before `nested` is known to it at all, so there is no nested `RepairStrategy` to consult yet at that point. Always requests `InvalidLoopGroupRequirement::all()` ("compute everything") — safe (never wrong, just potentially wasted computation) regardless of what the eventually-configured nested strategy turns out to need.

### region_merge_core (shared, not a strategy)

`maze-core/src/repair/strategies/region_merge_core.rs` — logic shared by every strategy that merges an undersized SCC region into a neighboring region (`ExpandRegionPassageStrategy` and `TeleportRegionMergeStrategy` below), factored out once issue #89 needed the same target-selection/merge-loop bookkeeping a second time with a different candidate-discovery rule (geometric adjacency vs. any node pair). Not itself a `RepairStrategy` — just a module the strategies import from.

- `PARAM_TARGET_MODE` / `MODE_LARGEST` / `MODE_SMALLEST` / `MODE_RANDOM` / `MODE_PREFER_NEEDY` / `MODE_OPTIONS`, `PARAM_PREFER_PARTIALLY_CONNECTED` — the shared param ids/enum values both strategies expose under these exact names.
- `pick_by_mode(pool, scc, mode, needy, rng) -> Option<ComponentId>` — `largest`/`smallest` by `components[i].len()`, `prefer_needy` biased toward flagged neighbors (falls back to the whole pool if none are needy), `random` (or any unrecognized mode) uniform via `rng`. `pool` must already be sorted by the caller for reproducible tie-breaking (component ids are typically collected from a `HashMap`'s randomized-per-process iteration order).
- `narrow_to_partial(pool, partial, prefer_partial) -> &[ComponentId]` — the `prefer_partially_connected` pre-filter: returns `partial` if the flag is on and non-empty, otherwise the full `pool`. Each strategy computes its own `partial` subset (what "partially connected" means is strategy-specific — bridging-pair state for `ExpandRegionPassageStrategy`, any-edge-kind state for `TeleportRegionMergeStrategy`) and passes it in.
- `run_merge_loop(invalid, find_candidate) -> bool` — the shared "merge every flagged region into a chosen neighbor" loop: pops region ids from `invalid` (LIFO), skips ones already absorbed by an earlier merge in the same call (`merged_away`), and calls the caller-supplied `find_candidate(region_idx, needy) -> Option<(neighbor_idx, applied)>` closure for each remaining one. If the chosen neighbor was itself a needy (flagged) region, it's marked `merged_away` so a later iteration doesn't try to expand it again. Returns `true` if at least one region was successfully merged (`applied == true` for at least one call) — callers map this to `Fixed`/`Failed`. `find_candidate` owns everything strategy-specific: candidate discovery, target selection (via `pick_by_mode`/`narrow_to_partial`), and the actual connection.

### ExpandRegionPassageStrategy

Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #51 (passage mode) and issue #88 (`one_way` connection mode). Merges each flagged undersized SCC region into a neighboring region, via either a full bidirectional passage or a pair of one-way edges (`connection_mode`), picked by **geometric adjacency** (`field.neighbors`) — not graph adjacency, since two regions can be neighbors with no existing edge between any of their cell pairs at all.

`invalid` on `RegionNeedsExpansionIssue` (which `maze.analysis.scc(&maze.graph).components` indices are undersized) is the producing check's result — there is no other channel to learn it.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `target_mode` | Enum | `random` | `largest`, `smallest`, `random`, `prefer_needy` | How to pick which neighboring region to merge into |
| `connection_mode` | Enum | `passage` | `passage`, `one_way` | How to bridge the region into its chosen neighbor |
| `prefer_partially_connected` | Bool | `true` | — | Prefer a neighbor that already has a one-way edge to/from the flagged region over one with no connection at all |


- If `invalid` is empty: returns `Fixed` immediately — nothing to expand.
- Processes each flagged region index from `invalid` in turn. For a region already merged away earlier in the same `apply` call (because an earlier merge picked it as the neighbor), it is skipped — the SCC index space is stale for it once a previous merge happened, but no recomputation is needed: skipping is enough since the region's nodes already belong to whatever region absorbed them.
- For a region, candidate neighbors are found by scanning every node in the region, then every `field.neighbors(node)` cell, and looking up that neighbor cell's current SCC component (from `maze.analysis.scc(&maze.graph)`, fetched once at the start of `apply` — the graph hasn't mutated yet at that point). A neighbor cell in the same component is skipped (not a different region).
- A candidate pair is rejected if blocked by preset state — both directions must be free (`blocked`/`locked_out`/`locked_in`), same strict "fully bidirectional or skip" contract `MissingLoopsRandomStrategy` uses. An existing one-way edge between the pair is **not** a blocker by itself — it's just another valid candidate; the strategy only adds whichever direction is still missing.
- **`target_mode == random && connection_mode == passage && !prefer_partially_connected`** (the original, pre-issue-#88 contract, preserved verbatim for determinism parity with existing callers such as `ReduceSccCountStrategy`): returns the first geometrically-adjacent, non-blocked neighbor found while scanning — does not enumerate every neighbor first, never touches `rng`. One representative bridging cell pair (the first found) is used for the passage. Since `prefer_partially_connected` now defaults to `true`, this fast path is only reached with an explicit `prefer_partially_connected: false` override — the default configuration always goes through the full-enumeration path below.
- **Every other combination** enumerates every distinct neighboring component first, collecting *every* bridging cell pair per neighbor (not just one representative — needed for `one_way`'s max-separation placement below) plus whether a directed edge already exists in either direction (via any pair) between the region and that neighbor:
  - If `prefer_partially_connected` is `true` and at least one neighbor has exactly one direction already connected (a "partial" neighbor): the candidate pool is narrowed to just the partial neighbors; `target_mode` then applies within that narrowed pool. If no neighbor is partial, the pool falls back to every neighbor (this priority level is a pre-filter ahead of `target_mode`, not a tie-break within it).
  - `largest` / `smallest`: picks by `components[i].len()`.
  - `prefer_needy`: if any pool member is also in `invalid` (and not already merged away), picks uniformly at random among those via `rng`; otherwise falls back to picking uniformly at random among the whole pool.
  - `random` (only reachable here when `connection_mode == one_way` or `prefer_partially_connected == true`): picks uniformly at random among the whole pool via `rng`.
  - The pool's component ids are collected into a `Vec` and **sorted** before any tie-breaking or `rng`-indexed pick — required for the Determinism Contract, since the ids start out keys of a `HashMap` whose iteration order is randomized per-process.
- **`connection_mode == passage`**: adds a full bidirectional passage across the first bridging cell pair found for the chosen neighbor (completion-aware — an existing one-way edge on that pair is completed into a full passage, not duplicated), via `try_add_bidirectional_edge`.
- **`connection_mode == one_way`**: ensures both a `region -> neighbor` and a `neighbor -> region` directed edge exist between the region and its chosen neighbor, each through its own bridging cell pair — never the same pair for both directions, since that would just be an ordinary passage.
  - If the chosen neighbor already has one direction connected (partial), only the missing direction is added, through whichever of the neighbor's remaining bridging pairs maximizes the *minimum* geometric distance (by the region-side node) to every pair already carrying the existing edge — farthest from the closest occupied pair, not just from one arbitrarily chosen occupied pair, since a partial connection can span more than one bridging pair (e.g. manual preset/post-edit edges predating the repair pass).
  - If neither direction exists yet, the two of the neighbor's bridging pairs that are farthest apart from each other (by `geometric_distance` between their region-side nodes, checked over every pair combination) are picked, one per direction.
  - If the chosen neighbor has only one bridging cell pair (can't support two separated directions), the merge for that neighbor fails and the region as a whole is skipped for this iteration — it is **not** retried against a different neighbor within the same `apply` call (single-candidate selection, same as `passage` mode).
  - Each direction is added via `try_add_directed_edge` (single directed `Basic` edge, preset-checked on the forward direction only).
- If a region has no neighboring region at all (isolated field cell, or every candidate pair preset-blocked): that region is skipped, not a hard failure for the whole call.
- After a successful merge, if the absorbed neighbor's component index was also in `invalid`, it is marked merged-away so a later iteration in the same `apply` call doesn't try to expand it again as a separate region.
- Returns `Fixed` if at least one region was successfully merged; `Failed` if none were (e.g. every flagged region was isolated, fully preset-blocked, or — `one_way` mode only — every candidate neighbor had just one bridging pair).
- **Out of scope** (separate strategy for the same issue kind): teleport expansion — see `TeleportRegionMergeStrategy` below.

### TeleportRegionMergeStrategy

Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #89. Merges each flagged undersized SCC region into a neighboring region via a `Teleport` edge instead of a geometric passage. Unlike `ExpandRegionPassageStrategy`, **any node pair across the two regions is a valid candidate** — teleport endpoints don't need to be geometrically adjacent, so there's no `field.neighbors` scan at all; every other SCC component is an eligible neighbor regardless of geometric position. Shares target-selection (`target_mode`/`prefer_partially_connected`) and merge-loop bookkeeping with `ExpandRegionPassageStrategy` via `region_merge_core` (see above) — only candidate discovery and the actual connection mechanism are specific to this strategy.

Same contract as `ExpandRegionPassageStrategy`: `invalid` on `RegionNeedsExpansionIssue` is the producing check's result — there is no other channel to learn it.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `target_mode` | Enum | `random` | `largest`, `smallest`, `random`, `prefer_needy` | How to pick which neighboring region to merge into (`region_merge_core`) |
| `direction_mode` | Enum | `two_way` | `two_way`, `one_way` | Mechanism used to cover both directions between the region and its chosen neighbor |
| `prefer_partially_connected` | Bool | `true` | — | Prefer a neighbor that already has **any** edge (any `EdgeKind`, not just `Teleport`) to/from the flagged region over one with no connection at all (`region_merge_core`) |
| `min_distance` | Float | `1.0` | `[0, 1000]` | Minimum logical (graph hop-count) distance a freshly-picked endpoint must keep from an already-occupied endpoint in the same region; rounded to the nearest non-negative integer before use |

- If `invalid` is empty: returns `Fixed` immediately.
- Candidate neighbors: every other SCC component (`scc.components`), full stop — no adjacency filter. For each, the graph's edges are scanned once (`O(E)`, not `O(region_size * neighbor_size)` — a region can be tiny while a neighbor is the bulk of the maze) to find one representative existing edge per direction, if any (`outbound`: a `region -> neighbor` edge of any kind; `inbound`: `neighbor -> region`, any kind). A neighbor already fully connected in both directions is still a valid candidate (target-selection may still pick it; `apply` then no-ops for it, see below).
- **Merging always ends up covering both directions** — a region isn't strongly connected to its neighbor with just one directed edge, so `direction_mode` only decides the *mechanism*, never whether both directions get covered:
  - `two_way`: both directions share **one** node pair `(a, b)` — a matched two-way teleport, the same shape as a preset `TeleportDirection::TwoWay` connection (`Specs/preset-connections.md`). Added via `try_add_bidirectional_teleport` (`generation::mod`) — same strict "both directions free by preset state, or mutate nothing" contract as `try_add_bidirectional_edge`, and completion-aware against **any** existing edge kind in a direction (not just `Teleport`) before adding.
    - If the neighbor has no existing edge in either direction: `(a, b)` is picked completely at random (uniform over each region's nodes) — no `min_distance` filtering, since there's no other occupied pair to keep away from yet.
    - If a partial connection already exists (any edge kind, either direction): the new pair is instead chosen `>= min_distance` away from the existing occupied node(s), independently in each region (the region-side node away from the existing region-side node, the neighbor-side node away from the existing neighbor-side node) — even if the existing connection already covers one of the two directions the fresh pair is about to (re-)cover; the existing connection and the new teleport pair are independent and both survive.
  - `one_way`: each direction gets its **own**, distinct node pair — never the same pair for both (that would just be a `two_way` teleport in disguise). Whichever pair(s) still need picking are chosen `>= min_distance` away from whatever pair(s) are already occupied (existing edges and/or a pair just picked earlier in the same call), independently within each region. If the neighbor has zero existing connections, both directions are freshly picked this way (the first pair at random, the second `>= min_distance` away from the first).
  - Added directed edges use `try_add_directed_teleport` (`generation::mod`) — idempotent against **any** existing edge kind in that direction (mirrors the strategy's own any-kind "partial connection" concept), preset-checked on the forward direction only.
- **Endpoint picking with `min_distance`** (`pick_node_away_from`): a node is drawn uniformly at random from the target region, retried up to an internal attempt cap (a circuit breaker, not a tunable parameter) until its logical distance to every "away from" reference node is `>= min_distance`; if every attempt fails, falls back to whichever sampled candidate maximized that minimum distance. Never fails outright (unless the region is empty, which can't happen for a real SCC component) — `min_distance` is a soft preference honored best-effort, not a hard requirement that can abort the merge.
- **Logical distance** (`bfs_min_distance`): `min(dist(a -> b), dist(b -> a))` via directed BFS hop-count within the current graph, in each direction — a region's two directions from a node can have different lengths, so the metric takes whichever is shorter. Purely graph-topological, unrelated to `space::geometric_distance` (which `ExpandRegionPassageStrategy`'s `one_way` mode uses instead, for its geometrically-adjacent candidate pairs).
- If a chosen neighbor is already connected in both directions: `apply` returns `Fixed` immediately for that region without mutating (idempotency), same posture as `ExpandRegionPassageStrategy`'s "already a full passage" completion-aware behavior. **Defensive only, not reachable in practice**: if a directed path exists both `region -> neighbor` and `neighbor -> region` (through any edge), the two are already the same SCC by definition — `REGION_NEEDS_EXPANSION` would never name them as two separate regions to merge in the first place. No real maze state can trigger this branch; it exists purely as a safety net against a stale/inconsistent `scc` snapshot.
- Returns `Fixed` if at least one region was successfully merged; `Failed` if none were (e.g. `invalid`'s region has no other SCC component at all — a single-component maze).

### WeightedRegionMergeStrategy

Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #90. Unlike `ExpandRegionPassageStrategy`/`TeleportRegionMergeStrategy`, which each implement one specific merge mechanism, this strategy picks *which* nested region-merge strategy to actually run: it holds any number of nested strategies under one slot, each with a weight, and delegates to `dispatch_weighted` (see "Weighted nested dispatch" above) — weighted-random selection without replacement, retrying a different nested strategy if the chosen one returns `Failed`, until one succeeds or every candidate has been tried.

The parent issue is passed through to the nested call **unchanged** — unlike `ReduceSccCountStrategy`, which synthesizes a new issue naming which regions to merge, this strategy only picks the merge *mechanism*; which regions need merging is already the incoming `RegionNeedsExpansionIssue.invalid`, untouched (see the `apply()` behavior list below for what this implies for a multi-region batch).

Same contract as `ExpandRegionPassageStrategy`: `invalid` on `RegionNeedsExpansionIssue` is the producing check's result — there is no other channel to learn it.

No configurable parameters of its own — weights live per nested candidate (below), not as a top-level `StrategyParam`.

**Nested slot**: exactly one, `slot_id = "merge_target"` (exported as `SLOT_MERGE_TARGET` — its own constant, deliberately not a reuse of `ReduceSccCountStrategy`'s constant of the same string value, since `slot_id` is part of each strategy's own public API per the "Nested strategies" section above), `kind = REGION_NEEDS_EXPANSION`, `min = 1`, `max = None` — any number of nested strategies (typically `ExpandRegionPassageStrategy` and/or `TeleportRegionMergeStrategy`) may fill it, unlike `ReduceSccCountStrategy`'s single-slot `max: Some(1)`.

**Weight resolution** (`resolve_weight`): each nested candidate's weight is read from its own `NestedStrategyConfig.param_overrides["weight"]` — a string, parsed as `f64`. Missing, unparsable, non-finite, or `<= 0.0` all fall back to `1.0` (one fallback rule, no separate branches for NaN/∞/negative/zero/malformed text). No upper clamp — `weight` isn't a declared `StrategyParam` of the nested strategy (it lives in `param_overrides` as this dispatcher's own convention on top of whatever params the nested strategy already exposes), so there's nothing to clamp against; an arbitrarily large weight simply dominates selection, which is safe and predictable. This fallback guarantees that whenever at least one nested candidate is configured, the pool passed to `dispatch_weighted` always has a strictly positive total weight. A `debug_assert!` rejects any nested candidate that declares its own `StrategyParam` literally named `"weight"` — that would collide with this dispatcher's reserved `param_overrides` key.

- If `invalid` is empty: returns `Fixed` immediately (idempotency), without touching `rng` or `nested`.
- Nested entries are filtered to `slot_id == SLOT_MERGE_TARGET` — a defensive runtime check, not the primary validation (`maze-runner`'s `build_nested` already guarantees this at config-build time); it only guards direct `apply()` calls made outside the runner, same posture `ReduceSccCountStrategy` takes toward its own single slot.
- If no candidate fills the slot after filtering: returns `Failed`.
- Otherwise wraps each filtered candidate in a `WeightedCandidate` (config + resolved weight) and delegates to `dispatch_weighted` with the **original, unmodified** `issue` — one weighted pick decides the merge mechanism for the whole `invalid` batch at once; the chosen nested strategy's own `apply()` is responsible for merging as many regions in the batch as it can (see "Known limitation, not solved here" under "Weighted nested dispatch" above for why this isn't split per-region).

**No `REGION_NEEDS_SHRINK` strategy yet** — see GitHub issue #181 (follow-up to issue #177). `MaxRegionSizeCheck`/`MaxRegionRatioCheck` (`quality_control.md`) produce `RegionNeedsShrinkIssue`, but no `RepairStrategy<T, RegionNeedsShrinkIssue>` is registered — an active rule using these checks with a configured strategy will fail to build (same "unknown strategy" rejection any mismatched-kind config gets), and a rule with `strategy: None` simply never auto-fixes the flagged regions. Splitting a strongly-connected region into two is non-trivial (which internal edges to cut to produce a valid split) and needs its own design pass.

### MissingRegionsStrategy

Handles `MISSING_REGIONS` — see GitHub issue #59. For each `RegionClass` short of its configured minimum (a `-N` entry in the incoming `MissingRegionsIssue.balance_by_class`, see `quality_control.md`), tries to either reuse an existing region or grow a new one and convert it into the target class by adding/removing one-way edges. `+N` entries are not creation targets themselves — they are a **spendable budget** the strategy may draw on, when a candidate region of the matching class is too small, to merge in a geometrically-adjacent same-class region rather than leaving the candidate undersized.

Same contract as `InvalidLoopRandomStrategy`/`ExpandRegionPassageStrategy`: `balance_by_class` on `MissingRegionsIssue` is the producing check's result, there is no other channel to learn it.

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

  Returns failure if `members` isn't coherent to begin with, if any audit removal is preset-blocked, or if no combination of adds lands on `target`. `convert_region` carries no rollback of its own — a failed call may leave audit removals or partial adds recorded in the `DraftMaze` it was given; the caller (`try_reuse`/`try_grow`) is responsible for calling it against its own nested `DraftMaze` (`DraftMaze` wraps `DraftMaze` — see "Mutation-command contract" above) and simply dropping that nested draft on failure, discarding everything recorded in it, and both already do this around the whole candidate (including absorbed neighbors).

**Region growth** (fallback if reuse fails): seeds front-expansion from any node not on the critical path and not already committed this `apply` call (including a node currently classified `Path`, as long as it isn't on the critical path itself — a tree-shaped maze with no cycles has its single SCC classified entirely `Path`, so without this a tree-shaped maze could never grow a Trap/Alternative/Unreachable region from scratch). Up to `MAX_GROW_ATTEMPTS` seeds are tried, prioritized the same way reuse candidates are (border-count with the needed reachability side).

- Front-expansion (`locality`-blended, same directional-continuation behavior as elsewhere) stays within the seed's own SCC component by default. **Cross-component growth**: when the seed's own component is fully absorbed into the growing set before `min_region_size` is reached (the frontier within the component is exhausted), the strategy looks for a geometrically-bordering *different* SCC component whose `RegionClass` still has surplus budget in `balance_by_class` — same budget-debiting rule as reuse's size-driven merge above (`try_open_excess_neighbor`, shared by both paths). If found, that component is folded in wholesale (its full size, not just enough nodes to reach `min_region_size`) and front-expansion continues, now allowed to also reach into the newly-opened component. If no bordering component has budget, growth for this seed fails (`None`) — same as the pre-issue-#59 behavior of failing when the frontier is exhausted, just with one more avenue tried first.
- After growth stops (whether single- or multi-component), every edge between the grown set and the rest of its original parent component(s) is severed (`sever_from_parent`) so the set becomes its own isolated (`Unreachable`) component. No separate post-growth bridging step is needed even when growth crossed into a second component: `try_open_excess_neighbor` already added a real bidirectional edge from `in_region` into the crossed component's entry node at the moment of crossing, before folding it into the frontier — so by the time `sever_from_parent` runs, the grown set is already one coherent SCC and severance only has to cut the *outward*-facing edges to the rest of the original parent component(s), never re-establish internal connectivity.
- Conversion then proceeds identically to the reuse path's audit-based `convert_region` — severance guarantees the grown set starts fully isolated (`Unreachable`), so the audit step's inbound/outbound removal is a no-op here (nothing to remove), and only the add step actually does anything.

**Region Balance Consistency**: the budget map (`excess_budget`, seeded once per `apply` call from `balance_by_class`'s positive entries) is mutated in place as components are absorbed, but every absorption happens inside the same nested-`DraftMaze` unit as its candidate's reuse/growth attempt — a failed attempt (membership-check fails, or every connect candidate is exhausted) drops that nested `DraftMaze` **and** restores a separately-saved copy of the budget map from before the attempt started, so a rolled-back absorption never leaves a debited budget behind. The budget is only ever durably spent by an attempt that reaches a successful, fully committed conversion (`outer.absorb(inner)`).

**Critical path constraint**: nodes on the critical path (the shortest start→finish route) are never used as a reuse candidate's member, a growth seed, or a cross-component absorption target, in either the reuse or growth path — checked the same way `ExpandRegionPassageStrategy` and the other region strategies do.

- If `maze.meta.start`/`finish` is unset: returns `Failed`.
- Returns `Fixed` if at least one shortfall item across all classes was successfully created; `Failed` if none were (including the case where every class's item exhausted `MAX_TOTAL_FAILURES` before succeeding).

### ReduceSccCountStrategy

Handles `EXCESSIVE_SCC_COUNT` — see GitHub issue #68. The first (and so far only) user of the nested-strategy mechanism (see "Nested strategies" above): `SccCountCheck`'s issue carries no specific regions to fix (unlike `REGION_NEEDS_EXPANSION`'s `RegionsNeedingExpansion`), so this strategy picks which regions to merge itself, then delegates the actual merge to a nested strategy.

`max_scc_count` on `ExcessiveSccCountIssue` is the producing check's configured threshold — there is no other channel to learn it.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `merge_priority` | Enum | `smallest` | `smallest`, `largest`, `random` | Which regions to pick for merging first |

**Nested slots**: exactly one, `slot_id = "merge_target"` (exported as `SLOT_MERGE_TARGET`), `kind = REGION_NEEDS_EXPANSION`, `min = 1`, `max = Some(1)` — a single nested strategy, typically `ExpandRegionPassageStrategy`, does the actual merge.

- `scc = maze.analysis.scc(&maze.graph)`; `count = scc.components.len()`. If `count <= max_scc_count`: returns `Fixed { score: None }` immediately (idempotency) without touching `nested` or `rng`.
- Otherwise selects exactly `count - max_scc_count` components to merge, ordered by `merge_priority`: `smallest`/`largest` sort by `(component size, component id)` for deterministic tie-breaking; `random` performs a seeded Fisher-Yates shuffle over component ids via `rng`. Only the first `count - max_scc_count` selected ids are used.
- Builds a synthetic `RegionNeedsExpansionIssue { meta: IssueMeta::default(), invalid: chosen, invalid_sources: Default::default() }`, passed to the nested `ErasedRepairStrategy::apply` call as `&synthetic as &dyn Issue` — never published anywhere outside this `apply` call (see "Nested strategies"' synthesized-issues rule above).
- Looks up the nested strategy filling `merge_target` in the `nested` slice passed into `apply` (defensive `debug_assert!` that at most one entry fills the slot, even though `build_nested` already enforces `max: Some(1)` at config-build time) — if none is present, returns `Failed`.
- Delegates: builds the nested strategy's own `StrategyParams` from its `param_overrides`, then calls its `apply()` with the synthetic issue, the same `maze`/`rng`/`preset_state`, and its own `nested` list (empty for `ExpandRegionPassageStrategy` today, but recursion is supported). Returns whatever `(RepairResult, Vec<MutationCommand>)` the nested call produces, unchanged — the parent has accumulated no commands of its own before delegating, so the nested call's commands are the entire returned batch, already in "parent, then nested" order. A merge failure (e.g. every candidate region has no geometrically-adjacent neighbor, or every candidate pair is preset-blocked) propagates as `Failed` the same way it would for a direct `ExpandRegionPassageStrategy` dispatch.
- **Does not itself guarantee full convergence to `max_scc_count` in one call** — like every other strategy that delegates region selection to `ExpandRegionPassageStrategy`, chosen regions can end up merging into each other rather than into fresh neighbors, so the net component-count reduction from one `apply()` call can be less than the number of regions picked. Full convergence is the pipeline's fixpoint loop's job across iterations, not a single `apply()` call's contract — same accepted imprecision `ExpandRegionPassageStrategy` itself already documents for its own `invalid` set.

### RemoveTeleportStrategy

Handles `INVALID_TELEPORT` — see GitHub issue #74. The single, fixed fix strategy for every per-teleport validation check (`TeleportDuplicatesConnectionCheck`, `TeleportWaypointDistanceCheck`, and any future per-teleport check reusing this kind): remove each flagged teleport edge outright. No configurable parameters, no alternative strategy — unlike `INVALID_LOOP` (which has both `InvalidLoopRandomStrategy` and `InvalidLoopScoredStrategy`), a teleport is a single edge, not a cycle with multiple candidate edges to choose between, so there is nothing to pick.

`invalid` on `InvalidTeleportIssue` is the producing check's result (which specific teleport `EdgeId`s to remove) — there is no other channel to learn them.

- `issue: &InvalidTeleportIssue` gives `invalid` directly: removes each `EdgeId` in `invalid` via `try_remove_teleport_with_reverse` (`generation::mod`) — looks the edge up by its own id rather than by node pair (necessary because `Graph::edge_between(from, to)` can return an arbitrary edge of any kind between a pair, which would risk removing the wrong one when a `Teleport` and a `Basic` edge coexist in the same direction — the exact scenario `TeleportDuplicatesConnectionCheck` flags), and **also removes the opposite-direction `Teleport` edge, if any** (`Graph::teleport_reverse`), so a two-way teleport is never left silently downgraded to one-way just because a check's edge selector (e.g. an `EntryOnly`-style one) only inspected/flagged one direction. An empty `invalid` is valid — nothing to remove, returns `Fixed` immediately.
- **Preset protection is `Basic`-only**: `try_remove_edge_by_id` (used internally by `try_remove_teleport_with_reverse` for each direction) checks `preset_state.preset_edges` only when the edge being removed is itself `EdgeKind::Basic`. A `Teleport` edge can never be a preset connection (only Passage/OneWay presets exist, and both always build `EdgeKind::Basic` edges — see `preset_state.rs`/`Specs/post-edit.md`), so a `Teleport` duplicating a preset-protected `Basic` connection is still removable: the protection belongs to the `Basic` edge, not to the `(from, to)` pair as a whole.
- Returns `Fixed { score: None }` whether or not any edges were actually removed (a preset-protected `Basic` edge is never a candidate here in the first place, since `invalid` only ever contains `Teleport` ids).
- **Route protection (GitHub issue #78) lives entirely on the producing checks, not here.** Each per-teleport check has its own `protect_route` param (default `true`, see `quality_control.md`) and simply never includes a route-critical teleport in `invalid` to begin with — the incoming `InvalidTeleportIssue` never contains an edge this strategy shouldn't remove, so the strategy itself stays a pure "remove everything flagged" executor with no route-awareness of its own.

### TeleportGroupProximityStrategy

Handles `TELEPORT_GROUP_PROXIMITY` — see GitHub issue #75. Distinct from `RemoveTeleportStrategy`: that one removes every flagged teleport edge outright (each edge individually invalid); this one instead resolves a *pair* by removing exactly one of the two teleports it references, since neither edge in a flagged pair is individually invalid on its own.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `priority` | Enum | `problematic` | `random`, `problematic` | Which teleport of a problematic pair to remove |
| `protect_route` | Bool | `true` | — | Prefer the non-route side of a pair instead of removing a route-critical teleport |

- `random` — removes a random teleport from the pair.
- `problematic` — removes whichever teleport in the pair belongs to more *other* problematic pairs (computed once up front over the full pair set the check found, not a running count — so the choice reflects the check's original findings, not whichever edge happens to be processed first).

`pairs` on `TeleportGroupProximityIssue` is the producing check's result (which teleport pairs are too close) — there is no other channel to learn them.

- `issue: &TeleportGroupProximityIssue` gives `pairs` directly: iterates `pairs` in order. Removing a teleport immediately drops every problematic pair that references it — if either side of the current pair was already removed while resolving an earlier pair in the same `apply()` call, that pair is skipped rather than acted on a second time (removal is idempotent by construction, but skipping avoids a pointless removal call and keeps `problematic`'s membership counts meaningful as a static snapshot). An empty `pairs` is valid — nothing to remove, returns `Fixed` immediately.
- **`protect_route` (GitHub issue #78, default `true`)**: when enabled and the side `priority` picked (`to_remove`) lies on the maze's current start→finish route (`graph::route_protection::is_teleport_route_protected` — also true if a two-way teleport's *other* direction is the route hop), the strategy falls back to removing the *other* side of the pair instead — unless that side is also route-critical, in which case neither is removed. Either way the pair still counts as resolved (`Fixed`, not `Failed`) — a route-critical teleport spared by this flag is a deliberate outcome, not an unhandled case. Disabling it reproduces the pre-#78 behavior exactly (`priority`'s pick is always removed, regardless of route).

- Uses `try_remove_teleport_with_reverse` (`generation::mod`) for the actual removal, on whichever side (`to_remove` or the `protect_route` `fallback`) actually gets removed — same preset-protection semantics as `RemoveTeleportStrategy` (`Basic`-only; a `Teleport` edge can never itself be preset-protected), and same reverse-removal guarantee: if the removed side is one direction of a two-way teleport, its opposite direction is removed too. Both `EdgeId`s the call reports removed (own + reverse, when present) are added to the `removed` tracking set, not just the one the loop nominally picked — so a later pair referencing the reverse direction is correctly treated as already resolved instead of attempting (and potentially mis-selecting) a fresh removal.
- Returns `Fixed { score: None }` regardless of how many pairs actually needed a removal.
- **Why this strategy (not just its check) also needs `protect_route`**: unlike the per-edge checks (which simply drop a route-critical candidate from `invalid`), `TeleportGroupProximityCheck` only excludes a *pair* when *both* sides are route-critical (see `quality_control.md`) — a pair with exactly one route-critical side is still reported, because the non-route side remains a legitimate removal target. The strategy is what actually decides *which* side to spare in that mixed case.

## Pipeline

Defined in `maze_core::generation::pipeline`.

```rust
pub const MAX_REPAIR_ITERATIONS: usize = 100;
pub const DEFAULT_REPAIR_TIME_BUDGET_SECS: f64 = 10.0;

/// Caps on the repair fixpoint loop. Both bounds are optional and independent — whichever is hit
/// first stops the loop. At least one bound must be `Some` — enforced once at construction
/// (`RepairLimits::new`), not re-checked every iteration (see GitHub issue #170): there is no
/// no-progress guard anymore, so `RepairLimits` is the only mechanism left that guarantees the
/// fixpoint loop terminates.
pub struct RepairLimits {
    max_iterations: Option<usize>,
    time_budget_secs: Option<f64>,
}

impl RepairLimits {
    /// `Err` if both bounds are `None`.
    pub fn new(max_iterations: Option<usize>, time_budget_secs: Option<f64>) -> Result<Self, String>;
    pub fn max_iterations(&self) -> Option<usize>;
    pub fn time_budget_secs(&self) -> Option<f64>;
}

impl Default for RepairLimits {
    fn default() -> Self {
        RepairLimits {
            max_iterations: Some(MAX_REPAIR_ITERATIONS),
            time_budget_secs: Some(DEFAULT_REPAIR_TIME_BUDGET_SECS),
        }
    }
}

pub fn build_maze<T: Tessellation>(
    field: Field<T>,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<T>,
    preset_state: &PresetState,
    limits: RepairLimits,
    preset_start: Option<NodeId>,
    preset_finish: Option<NodeId>,
    event_log: Option<&mut EventLog<QcEvent>>,
) -> (Maze<T>, Vec<Box<dyn Issue>>, GenerationTiming)
```

`build_maze`, `MAX_REPAIR_ITERATIONS`, and `RepairLimits` are re-exported from `maze_core` root.

**Since GitHub issue #106, `build_maze` is thin plumbing, not the algorithm.** All dispatch logic (the fixpoint repair loop, issue merging, the limit guard, stage sequencing) lives on `QualityControlEngine`/`Stage`/`Rule` (see "Rule, Stage, and the unified QualityControlEngine" above) — `build_maze` itself only constructs the `Maze`, seeds the shared `MazeRng`, seeds `maze.meta.start`/`finish` from `preset_start`/`preset_finish` (before the repair loop runs, so a preset start is honored by the same idempotency check strategies already use — see GitHub issue #86), and delegates to `qc_engine.run_full(...)`:

```rust
pub fn build_maze<T: Tessellation>(
    field: Field<T>, graph: Graph, seed: u64, qc_engine: QualityControlEngine<T>,
    preset_state: &PresetState, limits: RepairLimits,
    preset_start: Option<NodeId>, preset_finish: Option<NodeId>,
    event_log: Option<&mut EventLog<QcEvent>>,
) -> (Maze<T>, Vec<Box<dyn Issue>>, GenerationTiming) {
    let mut maze = Maze::new(field, graph);
    maze.meta.start = preset_start;
    maze.meta.finish = preset_finish;
    let mut rng = MazeRng::seed_from_u64(seed);
    let (issues, timing) = qc_engine.run_full(&mut maze, &mut rng, preset_state, limits, now_ms, event_log);
    (maze, issues, timing)
}
```

`event_log` (GitHub issue #147) — forwarded straight into `qc_engine.run_full`. `None` on every
non-debug call; see `Specs/quality_control.md`'s "Narration-level debug instrumentation" section
for the full scope/event shape this threads through `run_full`/`run_repair_stages`/
`Stage::run_repair`/`check_and_dispatch` down to `apply_commands`.

The second return value is the list of unresolved issues after all repair iterations. An empty vec means all issues were resolved. Callers decide how to handle unresolved issues — the pipeline always returns a maze regardless.

Time is measured via a small internal `now_ms()` helper, not `std::time::Instant` directly — `Instant` panics on `wasm32-unknown-unknown` (no syscall backing it). Native (including `cargo test`) reads a process-lifetime monotonic clock; the `wasm32` target reads `js_sys::Date::now()` instead. Either way, the value is only ever used for measuring elapsed duration within one `build_maze` call.

**Full algorithm** (`QualityControlEngine::run_full` → `run_repair_stages` → `Stage::run_repair` → `check_and_dispatch` → `RuleTrait::check_and_repair`, delegating internally to `Rule<T, I>::check_and_repair_typed`):

1. `run_full` constructs one `GenerationTiming` accumulator for the whole call — every level below only *updates* it (via smaller `(f64, u32)` tuple maps folded in afterward), never creates its own.
2. `run_repair_stages` constructs one `RepairBudget` (wraps `RepairLimits` plus `iterations_done`/`start_ms`, plus whichever limit fired) **before the first stage**, then iterates `self.stages` in order (`for stage in &self.stages`), passing the *same* `&mut RepairBudget` into every `stage.run_repair(...)` call — the budget is shared across all stages, never reset per stage (see below). A stage reporting `StageOutcome::Done` advances to the next; `LimitReached` stops the whole sequence — this mirrors the pre-#106 pipeline's `break 'stages'` exactly, just without needing a loop label, since the inner fixpoint loop is now entirely inside `Stage::run_repair` and simply `return`s a `StageOutcome` instead of breaking through several loop levels.
3. **Inside `Stage::run_repair`** (one stage's own fixpoint loop, `failed` local to this call):
   - Check `budget.exhausted(now_ms)` (max_iterations checked before time_budget) → `Some(kind)` means `LimitReached(kind)`.
   - `budget.iterations_done += 1`.
   - **`check_and_dispatch`: run QC and dispatch repair together — stage-scoped, not stage-agnostic.** For each `Box<dyn RuleTrait<T>>` in `self.rules`, **in `self.rules`' own configured order** (no sorting — see GitHub issue #170: sorting by rule id existed only to give the pre-#170 no-progress guard a stable snapshot to compare across iterations; once that guard was removed, nothing needs a re-derived order, so dispatch simply follows the order the rule config itself specifies), skipping ids already in the local `failed` set, call `rule.check_and_repair(maze, rng, preset_state, ...)` — this only runs **this stage's own** checks, unlike the pre-#106 pipeline, which ran every check across every stage every iteration (explicitly called out as wasteful, see GitHub issue #106), and immediately dispatches repair for that same rule if it found anything and has a strategy — no intermediate `Box<dyn Issue>` list held across a second pass (see GitHub issue #170's "Rule, Stage" section above). **Rule-level merge happens inside `check_and_repair_typed`'s own `run_checks_typed` step**: a rule's own multiple checks fold into at most one issue via `IssueMerge::merge` (moved from `pipeline.rs` to `quality_control/rule.rs`, and from a runtime `merge_issue` function to each concrete type's own `IssueMerge` impl by GitHub issue #113 — same per-type merge rules: `InvalidLoopIssue` via a three-step normalize→dedup→remap canonical merge, `RegionNeedsExpansionIssue`/`InvalidTeleportIssue`/`TeleportGroupProximityIssue` via plain dedup-union, `MissingRegionsIssue` takes the value further from zero per class — see "Rule, Stage, and the unified QualityControlEngine" above and `quality_control.md`'s "Dedup interaction" for the full per-type rules). Each call's `RuleIterationOutcome` decides what happens next: `NoIssue` → nothing; `NoStrategy` → counts toward "this stage isn't converged yet" but nothing to apply; `Repaired(result, outcome)` → `Failed` adds `rule.id()` to the local `failed` set, `Fixed { score: Some(s) }` sets `maze.meta.route_score` if not already set.
   - If no rule in this pass produced `NoIssue` for every rule (i.e. at least one rule returned `NoStrategy` or `Repaired`): loop again. Otherwise (every rule found nothing): `StageOutcome::Done` — this stage is finished.
   - Loop. **No no-progress guard** (see GitHub issue #170) — the loop keeps iterating until no rule finds anything or `budget` is exhausted; there is no separate mechanism that stops it early on a stuck-but-still-changing issue set.
4. Back in `run_repair_stages`: fold each stage's timing tuples into `GenerationTiming`'s `TimingEntry` maps. Return the final `RepairBudget`.
5. `run_full` runs the **unconditional final report pass** (`collect_final_report`, regardless of how the stage sequence ended) — walks `self.stages` again, concatenating `stage.run_report(...)` (i.e. `RuleTrait::report_checks`, `report_check`-based, one issue per flagged instance — see GitHub issue #102) for every rule in every stage. Same effective check set as the pre-#106 stage-agnostic final pass, just reached by walking the same stage/rule hierarchy instead of a flat check list.
6. Pushes a `RepairLimitReachedIssue` synthetic issue (`Box::new(...) as Box<dyn Issue>`) if `budget.limit_reached` is `Some`. Returns `(remaining, timing)`.

Two rules producing the same concrete `Issue` type are fully independent through this — each owns its own checks and strategy, and its own `failed` tracking; there is no shared routing table for either to collide on. A failure on one rule does not affect another rule's repair dispatch, in the same or a different stage. A `LimitReached` break, however, *does* stop every later stage — see above.

### Stages and the repair budget

`RepairLimits` (`max_iterations`/`time_budget_secs`) is shared across every stage in one `run_full` call via the single `RepairBudget` constructed in `run_repair_stages`, not reset per stage — `iterations_done`/`start_ms` are set once, before the first stage, and never reset at a stage boundary. If the budget is exhausted mid-stage, the whole stage sequence stops (not just the current stage) — the same `REPAIR_LIMIT_REACHED` issue construction as before staging existed applies unchanged; it just may now fire while a later stage never even got a chance to start.

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

pub fn build_maze<T: Tessellation>(..., event_log: Option<&mut EventLog<QcEvent>>) -> (Maze<T>, Vec<Box<dyn Issue>>, GenerationTiming)
```

- `initial_build_ms` is left at `0.0` by `build_maze` itself — it only runs the QC/repair fixpoint loop, not the initial `generate_maze` call. `maze-wasm::run_generate` is the only caller that also runs that stage; it times it with the same `now_ms()` clock and fills `timing.initial_build_ms` in after `build_maze` returns.
- `qc_total_ms`/`per_check` cover every check-running step across the whole `run_full` call — every fixpoint iteration's QC pass (`run_repair_stages` → `Stage::check_and_dispatch` → `RuleTrait::check_and_repair`'s internal `run_checks_typed` step) plus the final unconditional report pass (`collect_final_report`, `RuleTrait::report_checks`) that computes `remaining`. Since GitHub issue #106, this is `QualityControlEngine::run_full`'s single accumulator, not a separate timed/untimed method pair — see "Rule, Stage, and the unified QualityControlEngine" above. Since GitHub issue #170, `check_and_repair`/`check_and_repair_typed` take separate `qc_ms`/`repair_ms` (and separate `per_check`/`per_strategy` maps) as explicit out-parameters, so `Stage` can still fold each into the right `GenerationTiming` accumulator despite checking and dispatching happening in one call.
- `repair_total_ms`/`per_strategy` cover every strategy-dispatch step inside `RuleTrait::check_and_repair` (one per fixpoint iteration's rule that found an issue and has a strategy).
- `per_check` is keyed by **check type id** (`Check::check_type_id()`, e.g. `"loop_length"` — the same string as `available_checks()`'s `CheckDescriptor.id`), not by instance id — two active instances of the same type (GitHub issue #60) aggregate into one entry, since the issue calls for per-check-*type* timing, not per-configured-instance.
- `per_strategy` is keyed by **strategy id** (`RepairStrategy::strategy_id()`, e.g. `"invalid_loop_random"` — the same string as `StrategyConfig.id`), not by rule id — two rules backed by the same strategy aggregate into one entry.
- **Nested strategies (see "Nested strategies" above) are not timed separately.** `Rule::check_and_repair_typed` only wraps the top-level `strategy.apply` call in a timer; whatever time a parent strategy spends inside a nested `apply()` call it makes internally is included in the elapsed time attributed to the *parent's* `strategy_id` entry, with no separate entry for the nested strategy's own share — even when that same strategy is also independently registered elsewhere as a top-level strategy. A user reading `per_strategy` cannot distinguish a parent's own work from its nested delegate's.
- `QualityControlEngine::run_full` (timed, drives repair) and `run_check_only` (untimed — check-only callers, e.g. `build_analytics_snapshot`, have no generation to time and pass a throwaway one-off accumulator internally) are the two entry points — there is no separate `run`/`run_timed` method pair anymore; each `Rule`'s own `run_checks_typed`/`report_checks_typed`/`check_and_repair_typed` methods (exposed to `Stage` via the erased `RuleTrait` wrappers) take the timing accumulator(s) and `now_ms` clock as parameters (injected so the same wasm/native-aware clock from `pipeline.rs` is reused) and wrap each `Check::repair_check`/`report_check`/`RepairStrategy::apply` call internally.
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
