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
    // A [min, max] range, e.g. a desired distance band (MissingTeleportsStrategy's
    // desired_length, GitHub issue #212). default_min/default_max seed the UI slider's own
    // starting range; min/max bound what a config override may set either endpoint to.
    Interval { default_min: f64, default_max: f64, min: f64, max: f64 },
}

pub enum StrategyParamValue {
    Float(f64),
    Bool(bool),
    Enum(String),
    Interval(f64, f64),
}

pub type StrategyParams = HashMap<&'static str, StrategyParamValue>;
```

`build_params(descriptors, overrides)` builds a `StrategyParams` map from a descriptor slice and an optional `HashMap<String, String>` of raw string overrides:
- Float: parsed with `str::parse::<f64>`, clamped to `[min, max]`; NaN/infinite/unparseable → default.
- Bool: `"true"` / `"1"` → `true`, `"false"` / `"0"` → `false`; anything else → default.
- Enum: accepted only if the value is in `options`; otherwise → default.
- Interval: raw string is `"min,max"` (matches the web UI's own two-input serialization); each half parsed with `str::parse::<f64>` and clamped to `[min, max]` independently; a non-finite endpoint, a missing comma, or a parsed `lo > hi` all fall back to the whole param's default (`default_min`, `default_max`) — never silently swapped or clamped into a degenerate range.
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
    RemoveNode { node: NodeId }, // mirrors try_remove_node's contract -- never removes a point's last remaining node
    ReplacePointNodes { at: NodeId, nodes: Vec<Vec<SplitNodeEdge>> }, // replaces every node at at's point (slot-0 included) with a brand-new set, atomically
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitNodeEdge {
    pub target: NodeId,   // always an existing graph node -- inter-sibling edges are out of scope
    pub direction: SplitNodeEdgeDirection,
    pub kind: EdgeKind,   // Basic or Teleport -- added GitHub issue #281 for RemoveSplitStrategy's redistribution
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitNodeEdgeDirection { Forward, Backward, Passage }
```

One variant per existing `generation::mod` mutating helper (`try_*`), not lower-level graph primitives — each variant preserves that helper's own all-or-nothing atomicity as a single revalidatable unit (e.g. `AddBidirectionalEdge` is one command, not two independent `AddDirectedEdge`s, since `try_add_bidirectional_edge`'s "both directions free, or skip the pair" guarantee wouldn't survive independent per-direction revalidation). `SetStart`/`SetFinish` have no paired `try_*`/`cmd_*` helper — they mutate `MazeMeta`, not `Graph`, so there's no edge-feasibility check to share.

`RemoveEdgeWithReverse` (GitHub issue #185) is the same atomicity fix applied to loop-cutting: `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy` (built on `apply_cuts`/`cycle_cut_set`) used to cut a bidirectional passage by pushing two independent `RemoveEdge` commands, one per direction — correct end state, but the debug event tape showed two unrelated single-direction removals instead of "one bidirectional passage removed," and each direction was revalidated independently rather than as one atomic cut. `RemoveEdgeWithReverse { id }` removes the edge at `id` and, if the opposite direction between the same node pair also exists (`Graph::edge_between(to, from)`, not kind-filtered — a bidirectional `Basic` passage is always two `Basic` edges), removes that too, via `try_remove_edge_with_reverse`. Unlike `RemoveTeleportWithReverse` (which resolves its reverse via the kind-gated `Graph::teleport_reverse`, since a `Teleport` edge can coexist with a `Basic` edge in the same direction between a pair), `RemoveEdgeWithReverse`'s reverse lookup is a plain `edge_between` — kept as a separate helper/variant from the teleport one rather than generalized into a single kind-agnostic function, since `teleport_reverse` is Teleport-specific machinery the loop-cutting strategies (which only ever cut `Basic` cycle edges) have no need to route through.

`RemoveNode { node }` (GitHub issue #248, part of the split-QC epic #246) removes a split node (`Field::add_node_at`'s minted node, or a point's original slot-0 — GitHub issue #281: no node has special standing here) and every edge incident to it, both directions — mirrors `Maze::remove_node_at`'s atomic field+graph removal, via the preset-aware `generation::try_remove_node(field, graph, node, preset_state)`. Unlike every other `Remove*` variant, this one also touches `Field`, not just `Graph` (removing a node changes which node ids resolve to a point), so its `try_*`/`cmd_*` pair (`node_ops.rs`) is generic over `T: Tessellation`, unlike the `Graph`-only edge-removal helpers in `edge_ops.rs`. Refuses (returns `false`/no command) if `node` is its point's *last remaining* node — a point must always keep at least one node, regardless of which one it is — or if it's preset-protected (`locked_out`/`locked_in`, or an endpoint of a `preset_edges` pair). A strategy wanting to preserve the removed node's connections must propose the replacement `AddDirectedEdge`/`AddBidirectionalEdge`/teleport commands itself, ahead of this one in its own batch — `RemoveNode` only ever deletes, never redirects (see `RemoveSplitNodeStrategy`'s `redistribute` param below).

`ReplacePointNodes { at, nodes }` (GitHub issue #247, part of the split-QC epic #246) replaces every node currently at `at`'s point — slot-0 included, not just extra siblings — with a brand-new set, atomically: either every new node in `nodes` is minted together with all of its edges, or none of them are (all-or-nothing, same as `try_add_bidirectional_edge`'s pairing guarantee). `at` only identifies which point is affected (resolved via `field.point_of(at)`), not a node whose identity survives the command. `nodes` holds one entry per new node (in the order they'll be minted — `nodes[0]` becomes the point's new slot-0, per `Field::add_node_at`'s own minting-order convention), each a list of `SplitNodeEdge { target, direction, kind }` describing that node's own edges to already-existing graph nodes — `target` is always an existing node id; an edge between two new nodes minted in the same command is out of scope (a pattern's `sibling_target` field, see `quality_control.md`'s `AbstractPatternEditorDialog` doc note, is not resolved here). `direction` is `Forward`/`Backward` (one-way, matching `OneWayDirection`) or `Passage` (bidirectional); `kind` is `Basic` or `Teleport` (added GitHub issue #281, needed once `RemoveSplitStrategy` started redistributing Teleport edges through this same command — `AddSplitStrategy`'s own pattern-adaptation edges are always `Basic`). Built via the preset-aware `generation::try_replace_point_nodes(field, graph, ids, at, nodes, preset_state)`/`replace_point_nodes_feasible` pair (`node_ops.rs`, generic over `T: Tessellation` for the same reason `RemoveNode`'s pair is — replacing nodes changes `Field::nodes_at`, not just `Graph`) — feasibility requires `at`'s point to still exist, every node currently at that point to be removable (`node_removal_allowed(..., allow_last_node: true)` — the same preset-lock/edge-endpoint checks `remove_node_feasible` shares, just without the last-node exemption, since the whole point is replaced at once with a guaranteed non-empty set rather than shrunk by one), every new edge's `target` to still structurally exist (a command earlier in the same batch can itself have replaced a node another command's `nodes` still references as a `target` — this is the one command in the crate that can invalidate another command's edge target mid-batch), and every new edge passing the ordinary `preset_state.locked_in`/`locked_out` target-feasibility check — a single infeasible old node, missing target, or new edge fails the whole command, no partial replacement. Deliberately does not special-case a "slot-0 survivor" — no node of a replaced point has special standing (GitHub issue #281) — a caller whose replaced point happened to be `meta.start`/`meta.finish` leaves `meta` pointing at a stale `NodeId`, the same accepted, pre-existing gap `RemoveNode`/`RemoveSplitStrategy` already has.

**Multi-node, not capped at one new node beyond slot-0** — `nodes` deliberately isn't shaped as "slot-0 plus a capped sibling list": `AddSplitStrategy`'s own `max_split_nodes`/pattern `node_count` config can call for any number of new nodes per tile (mirrors `SplitGenerationConfig`'s own `max_split_nodes`), and a command capped at one extra node would silently under-deliver against that config every time a pattern or unconstrained roll asked for more. `try_replace_point_nodes_mints_multiple_nodes_in_one_atomic_call` (`node_ops.rs` test) is the regression guard for this.

**`Field::replace_nodes_at`** (`space/mod.rs`) is the field-layer primitive this command's `try_*` builds on: unlike `remove_node_at`, it has no "keep the last node" restriction, since it replaces a point's whole node list at once rather than shrinking it by one — this is what actually lets `ReplacePointNodes` touch slot-0 at all.

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
/// How a parent strategy picks which of a slot's several nested candidates to actually run —
/// purely descriptive metadata for the UI (which controls/labels to show per candidate), never
/// read by core's own dispatch logic (each dispatcher already has its selection order hard-wired
/// into the strategy that calls it).
pub enum NestedDispatchKind {
    /// No ordering convention — either the slot holds at most one entry (`max: Some(1)`), or
    /// there's exactly one required fixer with nothing to pick between. Default for every slot
    /// that isn't `Weighted`/`Priority`.
    Unordered,
    /// Candidates are picked weighted-randomly, with retry-on-`Failed` — see `dispatch_weighted`
    /// below (GitHub issue #90).
    Weighted,
    /// Candidates are tried strictly in configured list order, falling through to the next on
    /// `Failed` — see `dispatch_priority` below (GitHub issue #259).
    Priority,
}

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
    /// A slot's dispatch convention is never left to an implicit default — every `NestedSlot`
    /// literal sets this explicitly.
    pub dispatch_kind: NestedDispatchKind,
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

### Priority nested dispatch (`dispatch_priority`)

See GitHub issue #259, the priority-fallback companion to `dispatch_weighted` above.
`maze-core/src/repair/nested_dispatch.rs` provides a second shared helper for a parent strategy
that wants to pick *which* of several nested strategies filling one slot to actually run, this
time by a fixed configured order rather than weighted-random — `PriorityRegionMergeStrategy` and
`PriorityMissingLoopsStrategy` (below) are its users.

```rust
pub fn dispatch_priority<T: Tessellation>(
    issue: &dyn Issue,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    candidates: &[&NestedStrategyConfig<T>],
) -> (RepairResult, Vec<MutationCommand>);
```

Same erased-boundary shape as `dispatch_weighted` (`issue: &dyn Issue`, `candidates` borrowed, not
owned), but `candidates` is a plain slice of references in already-configured order — there is no
`WeightedCandidate`-style wrapper, since order alone (index 0, then 1, then 2, ...) *is* the
selection convention. `dispatch_priority` itself carries no notion of priority beyond "try the
next one in the slice" — the caller's `nested: &[NestedStrategyConfig<T>]` order, filtered down to
the slot in question, is what actually encodes priority; the web UI's up/down reorder controls on
a `Priority`-kind slot (`NestedStrategyPanel`) mutate exactly that stored order.

- **Selection**: strictly in the given order, no randomness involved in *which* candidate is tried
  next (unlike `dispatch_weighted`'s cumulative-weight pick). `rng` is still threaded through to
  each candidate's own `apply()` — a candidate strategy may itself be randomized — just never
  consulted by the dispatch loop to choose an order.
- **Who builds `StrategyParams`**: same as `dispatch_weighted` — `dispatch_priority` itself, via
  `build_params(strategy.params(), Some(&config.param_overrides))` for whichever candidate it is
  about to try.
- **No rollback bookkeeping needed**, **recursion**, and **only `Fixed`/`Failed`** — all three
  points from `dispatch_weighted`'s doc comment apply here unchanged; see there for the rationale.
- Empty `candidates` returns `Failed` immediately without touching `rng`, same as
  `dispatch_weighted`.
- **No weight resolution, no `"weight"` `param_overrides` convention** — a `Priority`-kind slot has
  nothing analogous to `WeightedRegionMergeStrategy::resolve_weight`; a candidate's position in the
  configured `nested` list is its entire selection signal.

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

### Naming convention (labels/descriptions)

User-facing strategy `label`s (`maze-web/messages/{en,ru}.json`, `strategy.<id>.label`) are
**nominalized** — an action-as-noun phrase, matching how rules/checks are named — not an
imperative verb phrase. E.g. "Remove teleport", not "Remove the teleport" or "Removes teleport".
Cardinality in the label must match what the strategy actually does: a strategy that can act on
several items in one call (e.g. `InvalidLoopGroupSelectStrategy` sampling multiple cycles) uses a
plural/generic noun ("Loop selection and break"), not a singular one ("...one loop") that
overclaims a 1:1 guarantee.

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
| `split_weight` | Float | 5.0 | [0, 100] | Weight applied to number of split-tile occurrences on path |
| `vertical_passage_weight` | Float | 5.0 | [0, 100] | Weight applied to number of `VerticalPassage`-kind hops crossed on path |
| `elevator_weight` | Float | 5.0 | [0, 100] | Weight applied to number of `Elevator`-kind hops crossed on path |

Score formula: `path_tiles * path_weight + junction_count * junction_weight + oneway_count * oneway_weight + teleport_count * teleport_weight + split_count * split_weight + vertical_passage_count * vertical_passage_weight + elevator_count * elevator_weight`

- Junction: nav node with ≥ 3 distinct neighbors (union of incoming and outgoing).
- One-way edge: nav edge `(u → v)` where no reverse edge `(v → u)` exists.
- Teleport edge: nav edge whose corridor `path` crosses a `Teleport`-kind edge in the underlying maze graph.
- Split: a field point with ≥ 2 nodes (GitHub issue #261). `split_count` sums, per path edge, the number of the edge's own tile nodes (excluding its `from` node, already counted by the previous edge) that sit on a split tile, plus 1 if the route's own start nav node is itself a split tile (mirroring how `junction_count` covers the start node too) — so a route crossing the same split point via two distinct nodes counts both, and a route starting on a split tile is not silently undercounted.
- Vertical passage / elevator (GitHub issue #390): `vertical_passage_count`/`elevator_count` sum, per path edge, the number of hops in the edge's own corridor `path` backed by a `VerticalPassage`/`Elevator`-kind graph edge respectively — looked up per-hop via `Graph::edge_between_kind` (not `edge_between`), since a `Basic` edge may coexist with a `VerticalPassage`/`Elevator` edge in the same direction between the same pair (GitHub issue #197's kind-aware dedup), and the arbitrary-kind lookup could resolve to the wrong one.
- Path cost (for Dijkstra): edge weight = `path.len() - 1` (tile count).

Behavior per case:
- Both set: returns `Fixed` immediately.
- Empty nav graph: returns `Failed`.
- **Neither set**: finds the `(start, finish)` pair with the highest score across all nav node pairs. Runs Dijkstra for each candidate start.
- **Only start set**: fixes start, searches for best finish.
- **Only finish set**: fixes finish, searches for best start.
- No reachable path found: returns `Failed`.

### InvalidLoopRandomStrategy

Handles `INVALID_LOOP`. Breaks each simple cycle flagged invalid by any producing check (`LoopLengthCheck`: shorter/longer than a threshold, depending on `comparison`; future checks may flag cycles invalid for other reasons) by removing one random edge from it (plus its reverse, if present) — a wall placed at a random point along the loop. The strategy itself is agnostic to *why* a cycle was flagged invalid — it only consumes `InvalidLoopIssue`.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `vertical_passage_priority` | Enum | `neutral` | `prioritized`, `neutral`, `protected` | How `VerticalPassage` edges are treated among the cut candidates (see below) |

`InvalidLoopIssue`'s fields are never optional at the type level (unlike the pre-#113 `Option<IssueData>`), but their content depends on `requirement()` (see GitHub issue #105, `quality_control.md`'s `IssueRequirement` section) — the producing check already did the (potentially expensive) bounded cycle search, and there's no other channel for the strategy to learn the check's configured threshold or recompute the same result cheaply. `requirement()` returns `InvalidLoopRequirement::empty()` — `apply` only ever reads `all`/`invalid` through `apply_cuts`, which seeds its pending set from `invalid`'s indices and only ever shrinks it (`discard_cycles_with_edge`'s `retain`), so a valid cycle's entry is never read; `invalid_sources` isn't read at all. A re-indexed `all` containing only the invalid cycles (the base layer, `VALID_CYCLES` unset) produces the identical result — proven by a dedicated test (`apply_result_is_identical_for_full_and_invalid_only_requirement`) that cuts the same seed against both requirement values and asserts the same edges survive.

- `issue: &InvalidLoopIssue` gives `all`/`invalid` directly: cuts the cycles at indices `invalid` into `all`. An empty `invalid` is valid — nothing to break, returns `Fixed` immediately.
- If `data` is missing or the wrong variant: this is a malformed call (should never happen in a normal pipeline run, where the check always attaches data) — returns `Failed`, not "already fixed".
- For each cycle: filters candidates to edges still present in the graph (`Graph::edge(id).is_some()` — an earlier cut in the same `apply` may have already broken a cycle sharing an edge with this one) **and not in `preset_state.preset_edges`** — preset Passage/OneWay connections are never removed, filtered out upfront so the random pick never wastes a sample on a protected edge.
- **`vertical_passage_priority`** (shared with `InvalidLoopScoredStrategy`, implemented once in `cycle_cut_set::apply_vertical_passage_priority` and applied to the candidate pool right after the preset/existence filter above, GitHub issue #392):
  - `prioritized`: if the filtered pool contains at least one `VerticalPassage` edge, narrows the pool to just those (so the pick below is a random `VerticalPassage`); otherwise leaves the pool as-is.
  - `neutral` (default): no narrowing — `VerticalPassage` edges are picked from the same pool as any other kind.
  - `protected`: drops every `VerticalPassage` edge from the pool before picking; can empty the pool if the cycle is made entirely of `VerticalPassage` edges, in which case the cycle is left unbroken.
- Picks one random survivor from the filtered candidates and removes it via `try_remove_edge` (which re-checks `preset_state` as a final guard) plus its reverse (`Graph::edge_between(to, from)`, also via `try_remove_edge`), if any. If `try_remove_edge` ever refuses (defensive — shouldn't happen given the upfront filter), the candidate is dropped and another is picked at random; this repeats until either a cut succeeds or no candidates remain for that cycle.
- **Accepted imprecision, not fully solved**: removing an edge can invalidate another cycle in the same batch through subtler graph changes than a shared `EdgeId` (e.g. corridor re-compression). The existence check only catches the shared-edge case; it does not re-validate every remaining cycle entry. Acceptable for a `Random` strategy — a smarter variant that recomputes between cuts is a separate future task if needed.
- **Does not guard connectivity or bridge status**: a cut may disconnect the maze, surfacing as `UnreachableFinish`/`MissingEndpoints` on the next QC pass. Deliberately not handled here — the pipeline's fixpoint loop (`build_maze`, up to `MAX_REPAIR_ITERATIONS`) already exists for exactly this kind of cascading repair, via the already-registered endpoint strategies.
- **No candidate weighting** (segment length, multi-cycle membership, etc.) — the name `Random` is deliberate. `InvalidLoopScoredStrategy` (below) is the weighted alternative on the same issue kind.
- Returns `Fixed { score: None }`.

### InvalidLoopScoredStrategy

`RepairStrategy<T, InvalidLoopIssue>`, same field-shape contract as `InvalidLoopRandomStrategy` above. An alternative to it — registering one or the other for `INVALID_LOOP` is a config choice (each `Rule` binds exactly one strategy), not a replacement.

Instead of picking a random edge from each invalid cycle, scores every still-present, non-preset-protected candidate edge in the cycle being cut and picks the highest-scoring one (ties broken via `rng`). The goal: bias cuts toward edges that simultaneously break several invalid loops at once (fewer total cuts needed to clear the issue) while avoiding edges that would also break a cycle the maze is meant to keep.

Unlike `InvalidLoopRandomStrategy`, `requirement()` returns `InvalidLoopRequirement::VALID_CYCLES` — the `valid_overlap` scoring term below walks every valid cycle in `all` to penalize edges shared with a loop the maze must keep, so the `VALID_CYCLES` layer is required by the algorithm itself, not left set out of inertia.

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `invalid_overlap_weight` | Float | 5.0 | [0, 100] | Weight per other invalid cycle (in `invalid`) sharing this edge |
| `valid_overlap_weight` | Float | 6.0 | [0, 100] | Penalty per valid cycle (in `all`, not in `invalid`) sharing this edge |
| `vertical_passage_priority` | Enum | `neutral` | `prioritized`, `neutral`, `protected` | Same semantics as `InvalidLoopRandomStrategy`'s parameter of the same name (see above); applied to the candidate pool before scoring, so a `prioritized` narrowing to `VerticalPassage`-only candidates also restricts which edges are scored |

For a candidate edge, `invalid_overlap` counts how many cycles in `all` at indices listed in `invalid` (including the cycle currently being cut — a constant offset shared by every candidate in that cycle, so it doesn't affect which one wins) contain that `EdgeId` — raw, uncorrected: every invalid-cycle intersection is a real win regardless of linear dependence between invalid cycles, since `invalid` already names the concrete cycles that must be broken.

`valid_overlap` — since GitHub issue #284 — counts how many cycles in the GF(2) independent basis of the *valid* subset of `all` (indices not in `invalid`) contain that `EdgeId`, not every valid cycle. A raw valid-cycle count overstates an edge's real cost: if several valid cycles sharing an edge are linearly dependent, cutting that edge cannot reduce the valid subset's independent-cycle count by more than its basis membership implies — a naive raw count would penalize the edge as if breaking `N` valid loops when at most `rank` of them are actually independent. The basis here is a separate, `EdgeId`-domain GF(2) elimination (`valid_cycle_basis_indices`, `invalid_loop_scored.rs`) — not `GraphAnalytics.pure_cycle_basis` (nav-edge-index domain, a different bit universe) — built via a local dense remap (`EdgeId` values are not a dense 0..N index) over `crate::graph::cycles::GF2Basis`, the same elimination core `find_all_simple_cycles` uses internally (see `graph-analytics.md`'s "Independent Cycle Basis" section). No canonical (forward/reverse) edge merging is applied in this domain, unlike the nav-edge basis — a cut here is about concrete `EdgeId`s, not physical corridors, and forward/reverse are already distinct `EdgeId`s with no automatic pairing to merge.

Score: `invalid_overlap * invalid_overlap_weight - valid_overlap * valid_overlap_weight`.

The overlap counts (`edge -> (invalid_overlap, valid_overlap)`) are computed **once** per `apply` call from the full `all` list, before any cut happens, and reused as-is for every cycle in `invalid` — including cycles processed later in the same `apply` call, after earlier cycles already had an edge cut. They are not recomputed between cuts, so a later cycle's candidate scores can reflect cycles that have already been (partially) broken by an earlier cut in the same call. Same accepted imprecision as `InvalidLoopRandomStrategy` regarding cross-cycle invalidation after a cut — a smarter variant that recomputes overlap between cuts is a separate future task if needed.

When scoring a candidate edge, its counts are added to its reverse-direction `EdgeId`'s counts (via `Graph::edge_between`, O(1)) before applying the weights — a bidirectional corridor is two distinct `EdgeId`s (forward and reverse), so two invalid cycles that share the physical corridor but each traverse it in the opposite direction land on different `EdgeId`s in the overlap map; without this, a raw per-id lookup would miss that cutting either leg (which always removes both, via `RemoveEdgeWithReverse`) breaks both cycles at once. After a cut, both the cut edge's id and its reverse (if removed too) are used to drop other pending cycles that are now already broken, for the same reason.

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

### dead_end_priority (shared, not a strategy)

`maze-core/src/repair/strategies/dead_end_priority.rs` — shared by `MissingLoopsRandomStrategy` and `MissingLoopsSplitStrategy` (GitHub issue #254 follow-up, exhaustion bug fixed by issue #278's audit). Both strategies pick a `src` node from a candidate pool, one at a time via `Vec::pop`, before finding it a new geometric neighbor to connect (or split into a bridge).

```rust
pub const PARAM_SRC_MODE: &str = "src_mode";
pub const SRC_MODE_RANDOM: &str = "random";
pub const SRC_MODE_DEAD_END_PRIORITY: &str = "dead_end_priority";
pub static SRC_MODE_OPTIONS: &[&str] = &[SRC_MODE_RANDOM, SRC_MODE_DEAD_END_PRIORITY];

pub fn apply_src_mode<T: Tessellation>(
    maze: &Maze<T>, pool: Vec<NodeId>, src_mode: &str, rng: &mut dyn RngCore,
) -> Vec<NodeId>;
```

A dead end is a node with exactly one distinct graph neighbor (incoming and outgoing edges together, deduplicated by partner `NodeId`) — a single bidirectional passage to one neighbor counts as a dead end just as much as one one-way edge; two one-way edges to two *different* neighbors does not (that's degree 2, a through-node).

`src_mode: dead_end_priority` orders that pool so dead ends are popped first, growing a fix out from the maze's least-connected cells before an arbitrary one. **One combined pool, ordered for `pop`-based consumption** — not a hard filter: partitions the pool into dead ends and the rest, shuffles each half independently (so same-tier ties resolve randomly, not by incidental input order), then returns `[rest..., dead_ends...]` — dead ends at the end, so a caller popping from the back consumes every dead end before ever reaching a non-dead-end candidate. Every other candidate stays in the pool behind them, never dropped, so exhausting the dead ends (all consumed or all failed) falls through to the rest automatically instead of leaving the caller's loop with nothing left to try.

**GitHub issue #278's exhaustion bug**: an earlier version filtered the pool down to dead ends outright (`if dead_ends.is_empty() { pool } else { dead_ends }`), losing every non-dead-end candidate for the rest of the call — once the dead ends in that static pool were exhausted, the caller's `while !pool.is_empty()` loop stopped even if its `target` count wasn't reached and plenty of eligible non-dead-end candidates were never tried. Fixed by switching to the single ordered pool above; both strategies consume it via `pool.pop()` specifically (never a random index), since a random-index pick would destroy the dead-ends-last ordering on the very first iteration. `src_mode` values other than `dead_end_priority` (including the `random` default) return the pool shuffled but otherwise unpartitioned.

Issue #278 also tracks a systematic audit of every other strategy parameter with a similar "priority tier, then fall back to the rest" shape, checking each one independently for the same exhaustion risk and for whether a single combined pool (as here) or two separate pools is the better fit given that strategy's own performance profile — not assumed to generalize from this fix alone.

### MissingLoopsRandomStrategy

Handles `MISSING_LOOPS` — opposite approach from `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy`, which cut edges from existing bad loops. This strategy instead seeds new connections at random between geometrically adjacent node pairs, expecting a follow-up QC pass to discard whichever of them don't end up forming a valid loop. `issue.missing` (how many loops short of the requirement) is mandatory — the producing check (`MinLoopsCountCheck`/`MinLoopDensityCheck`) already computed it; there is no other channel.

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `reserve_percent` | Float | `50.0` | `[0, 500]` | Target connection count is `ceil(missing * (1 + reserve_percent / 100))`, not the strict `missing` value — a buffer against candidates that turn out blocked or already-connected. |
| `loop_one_way_chance` | Float | `0.0` | `[0, 100]` | Chance a seeded connection is added as a single one-way edge (random direction) instead of a full bidirectional passage — see GitHub issue #217's follow-up. |
| `src_mode` | Enum | `random` | `random`, `dead_end_priority` — see `dead_end_priority` above. |

Named `loop_one_way_chance`, not `one_way_chance` — a `StrategyParam::id` is looked up by web i18n as a flat key with no strategy-scoping, and `MissingTeleportsStrategy` already registers its own `one_way_chance` param with a teleport-specific label; a shared id would resolve to whichever strategy's label the web layer happened to look up.

Builds the candidate pool from `maze.field.all_node_ids()`, ordered by `apply_src_mode` per `src_mode`, then pops a `src` node (always via `Vec::pop`, never a random index — see `dead_end_priority`'s ordering contract above) and tries a random geometric neighbor as `dst`, repeating until `target` connections are added or the pool is exhausted. For each candidate pair, per-pair RNG draws mirror `generation::edge_ops::add_edge_kind`'s own sample-consumption contract (a `[0, 100)` chance roll, then — only for the one-way branch — a direction coin flip) so a later param change never reorders draws relative to earlier iterations of this same loop:
- **Chance roll below `loop_one_way_chance`**: rolls a random direction, then adds `MutationCommand::AddDirectedEdge` if `generation::directed_edge_feasible` allows it; otherwise the pair is skipped (another neighbor is tried).
- **Otherwise**: strictly bidirectional — skips the pair unless both directions are unblocked (`generation::bidirectional_edge_feasible`, stricter than `can_connect`'s "at least one direction" contract), then adds `MutationCommand::AddBidirectionalEdge`.

A pair already connected (via `Graph::edge_between` in either direction) or already proposed earlier in the same `apply` call is skipped without consuming the chance/direction rolls. Returns `Failed` if no connection could be added at all; otherwise `Fixed { score: None }` with every proposed command, even if fewer than `target` were actually added.

### MissingLoopsVerticalStrategy

Handles `MISSING_LOOPS` via a `VerticalPassage` edge instead of an ordinary geometric one — see GitHub issue #393. Mirrors `MissingLoopsRandomStrategy`'s own random-seed shape (same `reserve_percent`/one-way-chance/`src_mode` mechanics, "seed and let QC re-check" contract, no attempt to verify the new edge actually closes a cycle), except the candidate pair is resolved through the shared `vertical_target::resolve_vertical_target` (see below), so the second endpoint is always the same `(x, y)` point on an adjacent floor rather than a same-floor geometric neighbor.

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `vertical_reserve_percent` | Float | `0.0` | `[0, 500]` | Target connection count is `ceil(missing * (1 + vertical_reserve_percent / 100))`. Defaults to `0.0`, unlike `MissingLoopsRandomStrategy`'s `50.0` — a vertical connection is a scarcer, more disruptive resource, so callers opt into over-provisioning explicitly rather than getting it by default. |
| `vertical_loop_one_way_chance` | Float | `0.0` | `[0, 100]` | Chance a seeded vertical connection is added as a single one-way edge instead of a full bidirectional passage. Rendered as a percent slider (`PERCENT_SLIDER_PARAM_IDS`). |
| `vertical_direction_balance` | Float | `0.5` | `[0, 1]` | Probability `resolve_vertical_target` picks up rather than down when both are available — see below. Rendered as a percent slider (`PERCENT_FRACTION_SLIDER_PARAM_IDS`). |
| `src_mode` | Enum | `random` | `random`, `dead_end_priority` — see `dead_end_priority` above. |

Named with a `vertical_` prefix (distinct from `MissingLoopsRandomStrategy`'s own `reserve_percent`/`loop_one_way_chance` and `AddVerticalPassageStrategy`'s `direction_balance`) for the same flat-key web-i18n reason `loop_one_way_chance` itself is named distinctly — see `MissingLoopsRandomStrategy` above.

Builds the candidate pool the same way `MissingLoopsRandomStrategy` does (`apply_src_mode` over `maze.field.all_node_ids()`, scoped to the issue's `RepairArea`), pops a `src` node via `Vec::pop`, and resolves its vertical target via `resolve_vertical_target(maze, src, rng, &DirectionConstraint::Either, vertical_direction_balance)` — always `Either`, since this strategy has no rule-level `passage_type` to honor (unlike `AddVerticalPassageStrategy`, it services `MISSING_LOOPS`, not `MISSING_VERTICAL_PASSAGES`). Unlike `AddVerticalPassageStrategy`, a `src` whose target resolution fails, or whose resolved pair turns out already connected/blocked, is not retried in the other direction — the `src` is simply dropped and the next one popped, matching `AddVerticalPassageStrategy`'s own single-candidate-per-src contract. The one-way/bidirectional choice and RNG sample-consumption order otherwise mirror `MissingLoopsRandomStrategy`'s own contract exactly (chance roll below `vertical_loop_one_way_chance` → direction coin flip → `AddDirectedVerticalPassage` gated by `directed_edge_feasible`; otherwise `AddBidirectionalVerticalPassage` gated by `bidirectional_edge_feasible`).

Returns `Failed` if no connection could be added at all (e.g. a single-level field); otherwise `Fixed { score: None }` with every proposed command, even if fewer than `target` were actually added.

### vertical_target (shared, not a strategy)

`maze-core/src/repair/strategies/vertical_target.rs` — `resolve_vertical_target`/`DirectionConstraint`, extracted (GitHub issue #393) from `AddVerticalPassageStrategy` once `MissingLoopsVerticalStrategy` needed the same floor-adjacency resolution. Not itself a `RepairStrategy` — just a module both strategies import from.

```rust
pub enum DirectionConstraint { Either, RequireUp, RequireDown }

pub fn resolve_vertical_target<T: Tessellation>(
    maze: &Maze<T>, src: NodeId, rng: &mut dyn RngCore,
    constraint: &DirectionConstraint, direction_balance: f64,
) -> Option<(NodeId, NodeId)>;
```

Resolves `src`'s `VerticalPassage` target: the node at `src`'s own point on an adjacent floor, mirroring `generation::vertex_based`'s own adjacency resolution. Returns `(from, to)` already oriented `(lower, higher)` for an up edge and `(higher, lower)` for a down edge, so callers building a one-way edge don't need to re-derive orientation. `None` if `src`'s level has no floor in an allowed direction, or no node exists at the same point on that floor (different shape/custom cells between floors).

Direction is picked per `constraint`: `RequireUp`/`RequireDown` (used by `AddVerticalPassageStrategy` when its rule-level `passage_type` is `OneWayUp`/`OneWayDown`) only ever resolve that one direction, `None` if unavailable. `Either` (used by `AddVerticalPassageStrategy` for every other `passage_type`, and unconditionally by `MissingLoopsVerticalStrategy`) rolls `direction_balance` when both up and down exist, falling back to whichever single direction is available on a boundary floor — *unless* `direction_balance` is pinned to exactly `0.0` or `1.0`, in which case it's treated as a hard direction choice rather than a genuine probability and never falls back to the other direction even if the pinned one is unavailable.

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

### PriorityRegionMergeStrategy

Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #259, the priority-fallback companion to
`WeightedRegionMergeStrategy` above. Same role — picks *which* nested region-merge strategy
actually runs — but selection is by configured order rather than weighted-random: it holds any
number of nested strategies under one slot and delegates to `dispatch_priority` (see "Priority
nested dispatch" above), trying them in list order and falling through to the next on `Failed`,
until one succeeds or every candidate has been tried.

No configurable parameters of its own — no weights to configure either, unlike
`WeightedRegionMergeStrategy`; a candidate's position in the nested list is its entire selection
signal.

**Nested slot**: exactly one, `slot_id = "merge_target"` (its own constant, not a reuse of
`WeightedRegionMergeStrategy::SLOT_MERGE_TARGET` — `slot_id` is part of each strategy's own public
API per the "Nested strategies" section above, never shared indirectly even when the string value
happens to coincide), `kind = REGION_NEEDS_EXPANSION`, `min = 1`, `max = None`,
`dispatch_kind = Priority`.

**One dispatch per region, not per `apply()` call** — unlike `WeightedRegionMergeStrategy`, which
passes the whole `invalid` batch through to a single `dispatch_weighted` call, this strategy runs
its own batch loop directly: `issue.invalid` can carry several independent undersized regions, and
folding the whole batch into one dispatch would let the first-in-priority candidate's success or
failure govern every region still left in the batch, not just decide the mechanism once per
region. For each region still pending (processed via `Vec::pop`, skipping any already merged away
by an earlier region's own merge in the same call), a single-region `RegionNeedsExpansionIssue` is
synthesized and passed to its own `dispatch_priority` call against the shared candidate list. A
merged-away neighbor is tracked the same way `WeightedRegionMergeStrategy`/`ExpandRegionPassageStrategy`
do — via each command's endpoints resolved back to their SCC component index, computed once from a
single fixed snapshot at the start of `apply()`.

- If `invalid` is empty: returns `Fixed` immediately (idempotency), without touching `rng` or
  `nested`.
- Nested entries are filtered to `slot_id == SLOT_MERGE_TARGET` — same defensive runtime posture as
  `WeightedRegionMergeStrategy`. If no candidate fills the slot after filtering: returns `Failed`.
- Returns `Fixed` if at least one region in the batch was successfully merged (even if others
  failed); `Failed` only if every region in the batch failed every candidate.

### graph::bisect (shared, not a strategy)

`maze-core/src/graph/bisect.rs` — general-purpose helpers for splitting a node set into two
balanced, connectivity-respecting halves, factored out for `RegionShrinkSplitStrategy` (below) but
deliberately not repair-specific (lives under `graph`, not `repair`) so any future caller needing
the same "group nodes that must stay together, then find a far-apart pair across groups" logic can
reuse it without depending on the `repair` module.

- `group_by_unremovable_edges(graph, nodes, is_unremovable) -> HashMap<NodeId, Vec<NodeId>>` —
  union-find (`crate::dsu::Dsu`) over `nodes`: two nodes end up in the same group iff connected
  through a chain of edges (either direction, present in `graph`) the caller-supplied
  `is_unremovable` predicate flags. A group of size 1 just means that node has no unremovable edge
  to another node in `nodes`. Keyed by each group's own lowest `NodeId` member — deterministic,
  independent of `Dsu`'s internal root choice.
- `farthest_pair_across_groups(graph, groups) -> Option<(NodeId, NodeId)>` — finds two nodes from
  *different* groups that are far apart by hop-count over `graph`'s underlying undirected adjacency
  (both edge directions treated as adjacency), via the standard double-BFS diameter heuristic: BFS
  from an arbitrary node to find its farthest node, then BFS from *that* node's farthest node to find
  its own farthest node outside its own group. Approximate (not exact all-pairs distance, which
  would be quadratic). `None` if `groups` has fewer than 2 keys.

### RegionShrinkSplitStrategy

Handles `REGION_NEEDS_SHRINK` — see GitHub issue #184 (follow-up to issue #181, which left this
kind with no strategy at all — `MaxRegionSizeCheck`/`MaxRegionRatioCheck`, `quality_control.md`,
produce `RegionNeedsShrinkIssue` but nothing consumed it). Splits an oversized SCC region into two
regions, as close to equal size as possible, by cutting the edges that end up crossing a computed
boundary between two grown halves.

`invalid` on `RegionNeedsShrinkIssue` (which `maze.analysis.scc(&maze.graph).components` indices
are oversized) is the producing check's result — there is no other channel to learn it, same
contract as `ExpandRegionPassageStrategy`'s own `invalid`.

**Parameters:** none of its own — `protect_route` (rule-level since GitHub issue #253, see `quality_control.md`'s "Rule-level parameters") never cuts a connection that lies on the maze's current start-finish route.

**Algorithm**, per flagged region (processed independently — a region already merged away or
otherwise gone by the time a later one in the same batch is processed isn't possible for a split,
unlike the expansion strategies' merge-away bookkeeping, so no equivalent skip logic is needed
here):

1. **Group the region's nodes** by every edge that must never be cut — `graph::bisect::group_by_
   unremovable_edges`, with `is_unremovable` flagging an edge as unremovable if it's a preset
   (Basic) connection (`preset_state.preset_edges`) **or** — only when `protect_route` is enabled —
   a hop on the maze's current start->finish route (`graph::route_protection::is_edge_on_route`,
   made `pub` for this caller — previously only `is_teleport_route_protected` was exposed, which is
   `Teleport`-specific). Two nodes joined by such an edge (directly or transitively through a chain
   of them) can never end up on opposite sides of the split — grouping them up front means the
   growth step (next) never has to negotiate a conflict over an uncuttable edge, since it only ever
   moves whole groups. With `protect_route` disabled, only preset connections stay ungroupable, so
   a region whose only internal connectivity is the critical path becomes splittable (at the cost
   of possibly severing that route — the next QC pass's endpoint strategies pick up the pieces, same
   fixpoint-loop posture as every other accepted-imprecision case in this file).
2. If the whole region collapsed into a single group: `Failed` for this region — nothing left to
   split (e.g. every internal edge is preset-protected, or the region's only internal connectivity
   *is* the critical path).
3. **Pick two seed nodes from different groups**, as far apart as possible —
   `graph::bisect::farthest_pair_across_groups`. Seeds are chosen from the *post-grouping* result,
   not before grouping, so the seed pair is guaranteed resolvable to two distinct groups even when
   the true diameter endpoints of the raw region happen to have collapsed into the same group.
4. **Grow two sides from those seeds**, one whole group at a time, via `grow_balanced_sides`: a
   multi-source BFS over the region's group-contraction graph (each unremovable-edges group is one
   contracted vertex; two groups are adjacent if any edge, either direction, connects a member of
   one to a member of the other). At each step, whichever side currently has fewer total nodes
   claims the next reachable group from its own frontier (ties favor the side already being grown,
   i.e. side "a" checked first via `size_a <= size_b`); if that side's frontier is exhausted, the
   other side's frontier is tried instead before giving up. A region that turns out not to be
   fully group-connected (shouldn't happen for a real SCC region, since it's strongly connected by
   definition) falls back to assigning any leftover group to whichever side is currently smaller.
5. **Cut set**: every edge (in either direction) between a node ending up on side "a" and a node on
   side "b" — safe to cut by construction, since any edge that had to stay together was already
   folded into one group in step 1 and step 4 never splits a group across sides. If the boundary
   turns out empty (defensive — shouldn't happen once two seeds from different groups were grown
   into two non-empty sides), the region isn't split (`None` from `split_region`, region skipped).
6. Each surviving cut pair resolves to a real `EdgeId` via `Graph::edge_between` (against the
   still-unmutated snapshot `apply()` was given — never fails to resolve within this loop) and is
   cut via `MutationCommand::RemoveEdgeWithReverse` — one command per direction found, so a
   bidirectional passage crossing the boundary is removed as the same atomic "cut this passage"
   unit `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy` use for cycle-cutting (GitHub issue
   #185), not two independently revalidated single-direction removals. **Redundant commands are
   still possible**: a boundary passage crossing in both directions produces two
   `RemoveEdgeWithReverse` commands (one per direction), each of which already removes the other's
   target — the second is not filtered out here, but is silently dropped later by
   `apply_commands`'s own revalidate-and-drop step (against the real, by-then-mutated `Maze`), the
   same safety net every other multi-command strategy in this file relies on.

Returns `Fixed` if at least one flagged region was successfully split; `Failed` if none were (every
flagged region collapsed to a single unremovable-edges group).

**Does not guarantee the two halves land in `[max_region_size / 2, ...]` bounds, or that the split
resolves the issue in one pass** — `grow_balanced_sides`' balance-greedy assignment tends toward
roughly equal sizes but has no hard balance guarantee (a region with a lopsided group-contraction
graph, e.g. one giant unremovable-edges group plus many singletons, can still end up split
unevenly). Same accepted imprecision class as `ExpandRegionPassageStrategy`'s own "regions can
merge into each other" note — the pipeline's fixpoint loop (`build_maze`, up to
`MAX_REPAIR_ITERATIONS`) re-runs `MaxRegionSizeCheck`/`MaxRegionRatioCheck` and dispatches this
strategy again on whatever remains oversized, rather than this strategy needing to fully converge
in one `apply()` call.

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
- **Route protection (GitHub issue #78) lives entirely on the producing checks, not here.** Each per-teleport check reads the same rule-level `protect_route` (default `true`, since GitHub issue #253 — see `quality_control.md`'s "Rule-level parameters") and simply never includes a route-critical teleport in `invalid` to begin with — the incoming `InvalidTeleportIssue` never contains an edge this strategy shouldn't remove, so the strategy itself stays a pure "remove everything flagged" executor with no route-awareness of its own.

### TeleportGroupSelectStrategy

Handles `TELEPORT_GROUP_PROXIMITY` — see GitHub issue #75, migrated onto the generic group-select mechanics in GitHub issue #209. Distinct from `RemoveTeleportStrategy`: that one removes every flagged teleport edge outright (each edge individually invalid); this one instead resolves a *pair* by removing exactly one of the two teleports it references, since neither edge in a flagged pair is individually invalid on its own. For each problematic pair flagged by `TeleportGroupProximityCheck` (`InvalidTeleportGroupIssue.groups: Vec<(Vec<EdgeId>, u32)>`, one two-element group per pair, `to_remove: 1` — see `quality_control.md`'s `InvalidGroupIssue<K>` doc comment), picks a teleport to remove and delegates the actual removal to a nested `INVALID_TELEPORT` strategy (`RemoveTeleportStrategy`, the only one) filling the `fix_target` slot — same shape as `OneWayGroupSelectStrategy` below, `TeleportGroupKind` in place of `OneWayGroupKind`.

```rust
pub const SLOT_FIX_TARGET: &str = "fix_target";
```

One nested slot, `fix_target`, expecting exactly one `INVALID_TELEPORT`-handling strategy (`min: 1, max: Some(1)`) — `RemoveTeleportStrategy`.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `priority` | Enum | `problematic` | `random`, `problematic` | Which teleport of a problematic pair to remove |

`priority` is `group_select`'s own `PARAM_PRIORITY` (see `GroupSelectStrategy / group_select_apply` above) — `random`/`problematic` mean exactly what they do there: `problematic` visits the highest-membership teleport first, globally across every pair, not per-pair.

`protect_route` is rule-level since GitHub issue #253 (see `quality_control.md`'s "Rule-level parameters"), not a `StrategyParam` of this strategy's own — a teleport lying on the maze's current start→finish route (`graph::route_protection::is_teleport_route_protected`) is excluded from the candidate pool entirely, for every pair, before the visiting order is built — passed to `group_select_apply` as its `element_allowed` closure, same mechanism `OneWayGroupSelectStrategy` uses via `is_edge_on_route`. When exactly one side of a pair is route-critical, the other side remains a legitimate candidate and is picked through the normal `priority` pass — no separate per-pair fallback code, since the protected side was simply never offered as a candidate. When *both* sides of a pair are route-critical, the pair has no allowed candidate at all: `group_select_apply` zeroes its budget up front (see "wholly-protected groups" below) instead of ever offering it to the nested strategy.

**`allow_reverse`** moved onto `RemoveTeleportStrategy`'s own param (GitHub issue #190) — this strategy no longer performs removal itself, so it has no `allow_reverse` of its own; configure it on the nested `fix_target` strategy instead.

**Wholly-protected pairs and the `Fixed`/`Failed` result.** Per `group_select_apply`'s own contract (see below), a pair with no allowed candidate at all doesn't make the overall call `Fixed` by itself — the result is governed entirely by whether *some* nested call across the whole issue actually succeeded. **Behavior change from pre-#209**: previously, a wholly-protected pair was left untouched but still reported `Fixed` (repeatedly, on every future QC iteration, since the check re-detects the same pair from an unchanged maze). Now, if *every* pair in the issue is wholly-protected, the strategy returns `Failed` instead — this permanently skips the rule for the rest of the current repair stage's fixpoint loop (`Stage::check_and_dispatch`'s `failed` set), rather than silently re-"resolving" a no-op every iteration until the repair budget runs out. A *mixed* issue (one wholly-protected pair alongside at least one genuinely fixable pair) is still `Fixed`, from the fixable pair's own progress — the wholly-protected pair is simply left alone, not touched, and doesn't drag the result down.

**Reverse-direction bookkeeping (GitHub issue #171's known gap).** `TeleportGroupSelectStrategy`'s own `element_invalidated` closure (GitHub issue #210 — see `group_select_apply`'s own section above for the general hook) reads a removed edge's opposite-direction `Teleport` counterpart directly from the (pre-mutation) `maze` snapshot via `Graph::teleport_reverse`, in addition to whatever `removed_edge_ids(nested_commands)` reports — needed because `removed_edge_ids` only ever recognizes a `RemoveTeleportWithReverse` command's *primary* id, never the reverse id it also removed. Without this, a pair referencing only the just-removed teleport's reverse direction would never have its own budget retired, and could still offer that (already-gone) reverse id up to the nested strategy for a redundant no-op fix.

### MissingTeleportsStrategy

Handles `MISSING_TELEPORTS` (see GitHub issue #211/#212) by adding the whole computed target count of teleport edges in one `apply()` call — mirrors `MissingLoopsRandomStrategy`'s `reserve_percent` target-count approach, not `MissingOneWaysFromWall`/`PassageStrategy`'s one-fix-per-call shape. `target = ceil(missing * (1 + reserve_percent / 100))`.

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `entry_pick` | Enum (`random`, `farthest_from_random`) | `random` | How a teleport's entry node is chosen — `farthest_from_random` hops from a random node to the farthest node forward-reachable from it (`farthest_reachable::farthest_from`, over the corridor-compressed `NavGraph`), same helper `FarthestEndpointsStrategy` uses. |
| `unreachable_priority` | Float (0–100) | `1.0` | Chance (%) of preferring an exit currently unreachable from entry over one in the desired interval — see the three-set fallback below. |
| `desired_length` | Interval | `0..1000` | Tile-hop distance band (plain BFS over the raw `Graph`, **not** the `NavGraph`) an exit should fall within, measured from entry. |
| `allow_out_of_interval` | Bool | `true` | If neither the desired-interval set nor the unreachable set yields a candidate, allow falling back to a reachable exit outside the interval instead of failing this entry. |
| `one_way_chance` | Float (0–100) | `50.0` | Chance the reverse edge is *not* added, leaving the teleport one-directional. |
| `attempts_limit` | Float (rounded to `usize`, min `1`) | `3.0` | How many entry candidates to try, per teleport slot, before giving up on that one slot and moving to the next (whatever was added so far still stands). |
| `reserve_percent` | Float | `50.0` | Mirrors `MissingLoopsRandomStrategy`'s own param — target count is `ceil(missing * (1 + reserve_percent/100))`, not the strict `missing` value. |

**Entry/exit selection.** For each teleport slot, an entry node is picked per `entry_pick`, then a plain forward BFS (`bfs_distances`, tile-hops, not the `NavGraph`) partitions every other feasible node into three disjoint sets:
1. reachable, outside `[desired_min, desired_max]`
2. reachable, inside `[desired_min, desired_max]`
3. unreachable from entry entirely (e.g. a separate strongly-connected component upstream of entry)

`unreachable_priority` rolls which of sets 2/3 is tried first; the roll's loser is tried if the winner is empty; if both are empty, set 1 is tried only when `allow_out_of_interval` is set — otherwise this entry attempt fails outright. A candidate is feasible if it isn't `entry` itself, has no existing edge from `entry`, wasn't already proposed earlier this `apply()` call, and is `directed_edge_feasible` under `preset_state`. The teleport is always oriented `entry -> exit`, regardless of which set `exit` came from — this is what lets the strategy bridge across SCCs (set 3): even an exit currently unreachable from entry becomes reachable the instant this very teleport lands.

**Reverse-direction feasibility.** `one_way_chance` decides whether the reverse (`exit -> entry`) is also requested, but that request is only honored if `directed_edge_feasible(preset_state, exit, entry)` holds — otherwise the strategy falls back to a directed-only `AddDirectedTeleport`, rather than proposing an `AddBidirectionalTeleport` whose reverse leg `preset_state` would block, which `apply_commands` would then drop as a whole (see the mutation-command contract above) without the strategy's own `added` count reflecting the loss.

**Retry/termination.** Failed entries are evicted from a pool shared across the whole `apply()` call (`pool.swap_remove`), so no node is ever retried as an entry twice in the same call — this guarantees termination. `attempts_limit` bounds how many entries a single teleport slot may burn through before that slot gives up (not the whole call): the outer loop simply moves on to the next slot with the same (now smaller) pool. `apply()` returns `Failed` only if zero teleports were added by the time the pool is exhausted or the target count is reached; otherwise `Fixed { score: None }` with however many were actually added, which may be fewer than `target` if the pool runs dry first.

### RemoveSplitStrategy

Handles `INVALID_SPLIT_TILE` — see GitHub issue #248, split-QC epic #246 (issue #260: the issue's unit of work is a whole tile). Collapses each flagged tile (`InvalidSplitTileIssue.invalid: Vec<SplitTileNodes>`) back into a single, freshly-minted node via one atomic `MutationCommand::ReplacePointNodes` per tile — GitHub issue #281 replaced the original per-node `RemoveNode`/`redistribute` design (which always kept slot-0 specifically as "the node left standing") with this atomic-replace design: slot-0 is no longer special, any node of the tile may end up being the one whose connections the new node inherits, and the whole tile is either replaced or left entirely untouched, never partially collapsed.

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `selection` | Enum (`random` / `least_connected` / `most_connected` / `merge`) | `most_connected` | Which of the tile's nodes' connections the one surviving node ends up with. |

For each flagged tile with 2+ nodes (a tile already at 1 node — collapsed by an earlier command in the same batch, or a stale issue — is skipped, counted as already-fixed, not a failure): collects every incident edge of every node in the tile via `tile_edges`, each resolved to a `SplitNodeEdge` relative to its owning node (a self-loop — an edge whose other end is itself a node of the same tile, i.e. a sibling edge — is dropped, never carried over). Then, per `selection`:
- `random`/`least_connected`/`most_connected`: `pick_survivor` picks one tile node — uniformly at random, or by lowest/highest total incident-edge degree (`node_degree`: a bidirectional pair to the same target *of the same `EdgeKind`* counts once, not twice — a `Basic` and a `Teleport` connection to the same target are still two distinct connections). Ties (including every node having zero edges) resolve by shuffling the candidate list first, so the winner among equals is still random. Only that node's own edges are carried over; every other node's edges are simply dropped.
- `merge`: `merged_edges` unions every node's edges into one list, deduplicated by `(target, EdgeKind)` — if two nodes each had a connection to the same target of the same kind, one entry survives; if one had `Forward` and another `Backward` to the same `(target, kind)`, `union_direction` merges them into a full `Passage` rather than one arbitrarily winning.

The resulting edge list becomes the sole entry of a one-node `ReplacePointNodes { at, nodes: vec![node_edges] }` command (`at` resolved from the tile's own first node — any node of the tile, since they all resolve to the same point). Checked against `replace_point_nodes_feasible` up front, mirroring the command's own all-or-nothing contract, so this strategy's own `Fixed`/`Failed` verdict always agrees with whether `ReplacePointNodes` will actually be applied — same "declined command must not silently count as fixed" rationale as `OneWayToWallStrategy` (GitHub issue #230): without this check, a preset-locked tile would report `Fixed` every iteration despite the command always being declined, spinning the repair fixpoint loop until the iteration/time budget is exhausted instead of failing fast. Unlike the old per-node design, a single preset-locked node anywhere in the tile now blocks the *whole* tile's collapse (`replace_point_nodes_feasible` is all-or-nothing), not just that one node surviving — an accepted trade-off of moving to `ReplacePointNodes`'s atomic contract. Reports `Failed` only if every flagged tile was already collapsed or preset-locked; `Fixed` otherwise.

### RemoveSplitNodeStrategy

Handles `INVALID_SPLIT_NODE` — see GitHub issue #250, epic #246. Removes each flagged *individual* node (`InvalidSplitNodeIssue.invalid: Vec<NodeId>`) entirely (`MutationCommand::RemoveNode`) — unlike `RemoveSplitStrategy` (whole-tile collapse), this strategy's unit of work is one node at a time, and a check producing this issue may legitimately flag slot-0 itself (epic #246's "slot-0 is not otherwise special" rule for checks); the removal step still declines it, same as every other strategy in this epic — `remove_node_feasible` never allows it.

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `redistribute` | Bool | `true` | If `true`, the removed node's connections are reconnected to another remaining node of the same split, picked at random, before removal, instead of simply disappearing with it. |

For each flagged node: checks `remove_node_feasible` up front (never a point's slot-0, not preset-protected), same "declined command must not silently count as fixed" rationale as `RemoveSplitStrategy`. If feasible, resolves its point and every other node still at that point (`Field::nodes_at(point)`, excluding the node being removed) — **further excluding any of those siblings that this same `issue` also flags *and* that itself passes `remove_node_feasible`**, since that sibling gets its own `RemoveNode` command later in this same batch, which would immediately clear any edge just redistributed onto it. A sibling merely flagged but not actually removable (slot-0, or a preset-protected node) is *not* excluded — it's never touched by any `RemoveNode` in this batch, so it stays a safe target. If `redistribute` is set, the removed node's incident edges are grouped by `(neighbor, EdgeKind)` before picking a target — a bidirectional passage (forward + reverse edge to the same neighbor, same kind) draws one shared random target for both directions, not two independently-drawn ones, so a physical two-way connection is never silently split into two one-ways to different siblings (GitHub issue #276). Each group independently picks its own random target among the (filtered) siblings (`rng.next_u32() as usize % siblings.len()`, called fresh per group, not once per node or once per edge) — slot-0 is an equal candidate here, not favored or excluded — then proposes one `AddDirectedEdge`/`AddDirectedTeleport` (matching the original edges' `EdgeKind`) per edge in the group, redirected to/from that group's chosen target. A multi-edge removed node's connections therefore scatter across whichever siblings each group happens to draw, rather than all funneling onto one shared target. An edge that would connect its target to itself (the sibling edge between the removed node and that particular target, if any) is skipped — a self-loop is never proposed. An empty candidate pool simply drops that edge's redistribution instead of picking an unsafe target — slot-0's permanent presence and non-removability makes this practically unreachable, but the code path is handled, not assumed impossible. Each redistribution command is independently revalidated by `apply_commands` same as `RemoveSplitStrategy`'s. Reports `Failed` if no flagged node passed `remove_node_feasible` — same rationale as `RemoveSplitStrategy`/`OneWayToWallStrategy`.

**Redistribute target differs from `RemoveSplitStrategy`'s**: `RemoveSplitStrategy`'s issue is the whole tile, so it always resolves to a *single* surviving node (per its own `selection` param, GitHub issue #281) that every other node's connections either drop against or merge into. `RemoveSplitNodeStrategy` removes one node at a time from a tile that may still have several other nodes left — there is no single "the" node to redistribute onto, so it picks uniformly at random among whatever remains (slot-0 included on equal footing, per the epic's "slot-0 is not otherwise special" rule).

### RemoveSplitNodeConnectionStrategy

Handles `INVALID_SPLIT_NODE_CONNECTION` — see GitHub issue #251, epic #246. The nested-slot target `SplitNodeConnectionGroupSelectStrategy` (below) delegates each candidate connection's removal to, mirroring `OneWayToWallStrategy`'s "remove the edge entirely" role for this kind. `InvalidSplitNodeConnectionIssue.invalid` is always the caller's own single-element list (built fresh per candidate by `SplitNodeConnectionGroupSelectStrategy`'s `build_nested_issue`) — there is no check that produces this kind directly.

Removes every flagged edge **and its reverse direction, if any** via `crate::generation::cmd_remove_edge_with_reverse` (`MutationCommand::RemoveEdgeWithReverse`) — a split node's "connection" to a neighbor is the whole physical passage, not one directed half of it, so a bidirectional connection must be fully severed rather than left as a dangling one-way.

`cmd_remove_edge_with_reverse` itself never checks preset feasibility upfront (unlike `cmd_remove_edge_by_id`, which `OneWayToWallStrategy` uses) — it always proposes the command and defers to `try_remove_edge_with_reverse` at real apply time. `apply()` re-derives the same upfront feasibility check itself (`removal_feasible`: a candidate is feasible if either its forward direction or an existing reverse edge is not preset-blocked) before building any command, because this strategy is independently registered (`strategy_factory.rs`/`strategies_catalog.rs`) and can be assigned directly to a rule's `INVALID_SPLIT_NODE_CONNECTION`, bypassing `SplitNodeConnectionGroupSelectStrategy`'s own upfront filter (below). Reports `Failed` if every flagged edge was declined (preset-protected or already stale), `Fixed` otherwise — same "declined command must not silently count as fixed" rationale as `OneWayToWallStrategy` (GitHub issue #230). No configurable parameters.

### SplitNodeConnectionGroupSelectStrategy

Handles `INVALID_SPLIT_NODE_CONNECTION_GROUP` — see GitHub issue #251, epic #246. For each problematic group flagged by `SplitNodeConnectionPerNeighborCheck`/`SplitNodeConnectionPerFaceCheck` (`InvalidSplitNodeConnectionGroupIssue.groups: Vec<(Vec<EdgeId>, u32)>`), picks connections to cut down to the configured cap and delegates each actual removal to the nested `INVALID_SPLIT_NODE_CONNECTION` strategy (`RemoveSplitNodeConnectionStrategy`) filling `fix_target` — built on the same shared `group_select_apply` mechanics as `OneWayGroupSelectStrategy`, one nested slot expecting exactly one strategy (`min: 1, max: Some(1)`).

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `selection` | Enum(`random`/`most_connected`/`least_connected`) | `random` | Which of a split's own nodes' connections to cut first. |
| `protect_original` | Bool | `true` | When enabled, a candidate whose originating node is the split's slot-0 is never chosen for removal. |
| `protect_route` | Bool | `true` | When enabled, a candidate lying on the maze's current start→finish route is never chosen for removal. |

`PARAM_SELECTION` drives `order_candidates`: candidates are judged by their *originating* node's own total connection degree (both directions, every edge incident to `edge.from`), precomputed once per call (`O(E)`) rather than rescanned per candidate. `random`: every candidate shuffled once, visited in that order. `most_connected`/`least_connected`: shuffled first (so same-degree ties resolve randomly), then stably sorted by the originating node's degree descending/ascending — mirrors `SplitGroupSelectStrategy`'s own `most_connected`/`least_connected` priority options, but judged per-connection (by the edge's own origin node) rather than per-tile.

`PARAM_PROTECT_ORIGINAL`, `PARAM_PROTECT_ROUTE`, and a preset-feasibility check all feed into one `element_allowed` closure passed to `group_select_apply` — a candidate excluded by any reason is simply never offered. `protect_original` extends epic #246's per-strategy removal-eligibility rule (never touch slot-0 itself) to this strategy's own unit of work (a connection, not the node): protecting slot-0's connections keeps the original tile's own wiring untouched, cutting only extra nodes' excess links first. `protect_route` mirrors `OneWayGroupSelectStrategy`'s own route protection (`is_edge_on_route`). The preset-feasibility filter (`removal_feasible`, unconditional — no param toggles it off) excludes a candidate whose removal (forward + reverse, per `RemoveEdgeWithReverse` semantics) is fully blocked by preset edges: without it, `group_select_apply` would "resolve" the group's budget against a candidate that can never actually be removed, so the same excess connection would resurface on the next QC pass and the repair fixpoint would spin until `RepairLimitReached` instead of correctly reporting `Failed` (GitHub issue #251 bug report, fixed alongside the initial implementation).

### SplitNodeGroupSelectStrategy

Handles `INVALID_SPLIT_NODE_GROUP` — see GitHub issue #252, epic #246. For each problematic group flagged by `MaxSplitTileNodeCountCheck` (`InvalidSplitNodeGroupIssue.groups: Vec<(Vec<NodeId>, u32)>`, one group per over-limit split tile), picks nodes to remove down to the configured limit and delegates each actual removal to the nested `INVALID_SPLIT_NODE` strategy (`RemoveSplitNodeStrategy`) filling `fix_target` — built on the same shared `group_select_apply` mechanics as `SplitNodeConnectionGroupSelectStrategy`, one nested slot expecting exactly one strategy (`min: 1, max: Some(1)`).

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `selection` | Enum(`random`/`most_connected`/`least_connected`) | `random` | Which of a tile's own nodes to remove first. |

`PARAM_SELECTION` drives `order_candidates`: candidates are judged by each node's own total incident-edge degree (both directions), precomputed once per call (`O(E)`) rather than rescanned per candidate. `random`: every candidate shuffled once, visited in that order. `most_connected`/`least_connected`: shuffled first (so same-degree ties resolve randomly), then stably sorted by degree descending/ascending — mirrors `SplitNodeConnectionGroupSelectStrategy`'s own `selection` param, judged per-node instead of per-connection.

Unlike `SplitNodeConnectionGroupSelectStrategy`'s `protect_original`, slot-0 exclusion here is **not a configurable toggle** — a tile's slot-0 (`Field::nodes_at(point)`'s first entry) is unconditionally excluded from the candidate pool via `element_allowed`, since epic #246's "never remove slot-0" rule is a hard constraint for this strategy's own unit of work (the node itself), not a preference. `element_allowed` also excludes any candidate `remove_node_feasible` rejects for any other reason (preset-locked) — same "a group must never falsely resolve its budget against an unremovable candidate" rationale as `SplitNodeConnectionGroupSelectStrategy`'s own preset-feasibility filter, so a preset-locked split reports `Failed` instead of spinning the repair fixpoint to `RepairLimitReached`.

### SplitRouteCutStrategy

Handles `INVALID_SPLIT_ROUTE` — see GitHub issue #277, epic #246. For each route flagged by `SplitNodeConnectionTraversalDistanceCheck` (`InvalidSplitRouteIssue.routes: Vec<Vec<SplitRouteEdge>>`, `SplitRouteEdge = (EdgeId, bool)`), picks one edge along the route to cut.

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `edge_scope` | Enum(`split_only`/`other_only`/`any`) | `other_only` | Which edges of a flagged route are eligible to be cut. |
| `priority` | Enum(`random`/`problematic`) | `problematic` | Which eligible edge to cut — the shared `group_select::PARAM_PRIORITY` param. |

`edge_scope` filters a route's own `SplitRouteEdge` list before picking a candidate: `split_only` keeps only edges incident to *this* route's own split tile (`SplitRouteEdge.1 == true` — a sibling route found for a different split tile in the same issue is unaffected by this filter, each route's own flag only ever refers to its own tile), `other_only` (the default) keeps every other edge, `any` keeps the whole route. `other_only` is the default because cutting a route's own split connections changes the split tile's own topology (fewer/weaker connections to the outside world), where cutting some other passage along the way only removes a shortcut unrelated to the split itself — the least invasive fix by default.

`priority` picks among the filtered candidates: `random` uniformly at random; `problematic` (the default) picks the candidate edge shared by the most *other* still-pending routes in the same issue (breaking one such edge is likely to resolve several routes at once), ties broken by ascending `EdgeId` for determinism — mirrors `InvalidLoopScoredStrategy`'s overlap-based scoring.

**No nested strategy.** Every chosen edge, split or not, is cut directly by this strategy via `cmd_remove_edge_with_reverse` — no nested slot, a route's edge (split-incident or not) is a plain graph edge with no split-specific removal semantics to delegate to.

**Shared-edge dedup across routes, same pattern as `InvalidLoopGroupSelectStrategy`.** Routes are processed as a queue (`issue.routes.clone()`, one at a time from the front). After each successful cut, `removed_edge_ids` on the returned commands (plus each removed edge's own reverse direction, resolved off the still-intact graph before mutation — a two-way passage severed by one cut breaks both directions at once) is used to drop every other still-pending route containing that same edge from the queue, rather than offering it a second, redundant cut. This is exactly the "assume a route sharing the cut edge is already fixed by the same cut" rule cycle-breaking strategies use, applied to routes instead of cycles — most relevant here because a single check pass can flag both `a -> b` and `b -> a` as separate routes (GitHub issue #277's own directionality rule), and the two directions often share an edge at their point of divergence.

Reports `Fixed` if at least one route in the batch was actually cut (commands kept even if a later route in the same batch failed — e.g. no eligible candidate under `edge_scope`, or the chosen edge already stale in the graph), `Failed` only if every route failed to produce a command (nothing was fixed at all) — same "a mix of successes and failures within one batch is not itself surfaced beyond at least one worked" contract `InvalidLoopGroupSelectStrategy` uses.

### OneWayToPassageStrategy

Handles `INVALID_ONE_WAY` — see GitHub issue #198. One of two strategies registered against this kind; a rule picks exactly one. Converts every flagged one-way edge into a full bidirectional passage by adding the missing reverse direction: `MutationCommand::AddBidirectionalEdge { a: edge.from, b: edge.to }` per flagged `EdgeId`, resolved from `maze.graph.edge(id)` (a stale id from a prior command in the same batch is silently skipped via `filter_map`, same revalidate-and-drop contract every strategy relies on — see "Mutation-command contract" above). Completion-aware, like every `AddBidirectionalEdge` use — a no-op for whichever direction already exists, so this never duplicates the flagged edge itself.

`invalid` on `InvalidOneWayIssue` is the producing check's result — there is no other channel to learn which edges to convert. An empty `invalid` is valid — nothing to convert, returns `Fixed` immediately. No configurable parameters.

### OneWayToWallStrategy

Handles `INVALID_ONE_WAY` — see GitHub issue #198. The other of the two strategies registered against this kind — see `OneWayToPassageStrategy` above for the "complete into a passage" alternative. Removes every flagged one-way edge entirely (full wall): `MutationCommand::RemoveEdge { id }` per flagged `EdgeId`. Preset protection is the ordinary `Basic`-edge rule `try_remove_edge_by_id` already enforces (checks `preset_state.preset_edges` for a `Basic` edge) — a preset-protected one-way survives removal, same as any other preset-protected `Basic` connection.

`invalid` on `InvalidOneWayIssue` is the producing check's result. An empty `invalid` is valid — nothing to remove, returns `Fixed` immediately. No configurable parameters.

### GroupSelectStrategy / group_select_apply (GitHub issue #208, generalized in #209)

`quality_control::issue_kinds::group_issue::InvalidGroupIssue<K>`'s generic reusable select-strategy mechanics, extracted from `OneWayGroupSelectStrategy` (below), the reference instance. `repair::strategies::group_select::group_select_apply` is a plain generic function, not a `RepairStrategy` impl — every concrete group-select strategy (`OneWayGroupSelectStrategy`, `TeleportGroupSelectStrategy`) stays an ordinary unit struct with its own `strategy_id`/`params`/`expected_nested`/`RepairStrategy<T, InvalidGroupIssue<K>>` impl, resolves its own nested slot from `nested: &[NestedStrategyConfig<T>]`, and calls `group_select_apply` from inside its own `apply()`:

```rust
pub fn group_select_apply<T: Tessellation, K: InvalidGroupIssueKind>(
    issue: &InvalidGroupIssue<K>,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    nested: &NestedStrategyConfig<T>,
    element_allowed: impl Fn(&K::Element) -> bool,
    build_nested_issue: impl Fn(&str, &K::Element, &[K::Element]) -> Box<dyn Issue>,
    element_invalidated: impl Fn(&K::Element, &[MutationCommand], &Maze<T>) -> bool,
    order_candidates: impl Fn(&mut Vec<K::Element>, &HashMap<K::Element, usize>, &mut dyn RngCore),
) -> (RepairResult, Vec<MutationCommand>);
```

`nested` is already resolved by the caller (matched against its own slot id, `expected_nested()`'s `max: Some(1)` guaranteeing at most one match) — this function never looks slots up itself, just uses the single `NestedStrategyConfig` it's handed. `element_allowed` is a plain closure the caller builds from its own params before calling in (e.g. `OneWayGroupSelectStrategy` reads its own `PARAM_PROTECT_ROUTE` and closes over `is_edge_on_route`) — `group_select_apply` only ever calls it, never interprets what "allowed" means.

**GitHub issue #210: `build_nested_issue`/`element_invalidated`/`order_candidates` moved out of `K` (the marker type), into the calling strategy's own closures.** Pre-#210, `InvalidGroupIssueKind` carried `fn nested_issue`/`fn resolved_elements` as trait methods, and candidate ordering was a fixed random/problematic-by-membership scheme baked into this function. Both moved to plain function parameters instead — only the calling strategy has the full picture of what its own nested slot needs and what "prioritized" means for its own element type:

- **`build_nested_issue(check, target, others)`**: builds the synthetic `Issue` delegated to `nested` for one candidate pass, given `target` plus every other still-live candidate (`others`, sorted for determinism — see below) as context. `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy` ignore `others` and build a single-element issue (`InvalidOneWayIssue`/`InvalidTeleportIssue::new_from_check(check, vec![*target])`).
- **`element_invalidated(element, nested_commands, maze)`**: called for every other still-live candidate after a successful nested call, to decide whether it's now moot (and so should retire its own group's budget) — replaces the pre-#210 fixed `resolved_elements` list. `OneWayGroupSelectStrategy`: `element` equals a removed edge id. `TeleportGroupSelectStrategy`: `element` equals a removed edge id, or is that removal's opposite-direction `Teleport` counterpart (read from the pre-mutation `maze` snapshot via `Graph::teleport_reverse`, since `removed_edge_ids` never surfaces a `RemoveTeleportWithReverse` command's reverse id — GitHub issue #171's known gap). The offered `target` itself always counts as invalidated regardless of what this hook says (a nested strategy that converts rather than removes it, e.g. `OneWayToPassageStrategy`, must still retire its own budget).
- **`order_candidates(candidates, membership, rng)`**: reorders the global candidate list in place before the resolution loop visits it. `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy` share `group_select::order_by_priority(params)` (below).

**`order_by_priority`** (`group_select::order_by_priority`, shared by `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy`) reads `PARAM_PRIORITY` (`group_select` module's own — `random` / `problematic`, default `problematic`):
- `random`: every candidate shuffled once, visited in that order.
- `problematic`: every candidate shuffled first (so same-membership ties resolve randomly, not by incidental iteration order), then stably sorted by membership count descending — membership counts are computed once up front over the original unresolved group set (a static snapshot, not a running count that would favor whichever candidate is visited first). The element present in the most groups is tried first, globally across every group, not just within whichever group is scanned first.

**Per-group `to_remove` budget (GitHub issue #202 follow-up)**: earlier revisions assumed one successful fix always resolved a group — true for a 2-edge proximity pair (`to_remove: 1`) but not for a super-hub vertex (needs its whole excess removed) or a maze-wide count/ratio excess (same, and often much larger than 1). Each group tracks its own remaining `to_remove` count; a single call keeps working until every group's budget is exhausted or no candidate is left to try, not just one element total, which is what lets a large group (e.g. an entire maze's excess one-way set) actually converge within a bounded number of `apply()` calls instead of needing one repair iteration per excess element.

**Single global candidate pass, not one scan per group (GitHub issue #202 follow-up review)**: an earlier revision picked one edge per group per loop iteration, rescanning that group's own candidate list every time — for one very large group (the common case here) that was `O(to_remove * group_size)` in a single call, and it also meant `problematic`'s cross-group membership priority only ever applied within whichever group's turn it was, not globally. Instead, a reverse index (`element -> every group index that still lists it as a candidate`) is built once — `element_allowed` rejects never enter it at all — and its keys become one global candidate list, sorted deterministically (`K::Element: Ord`) before `order_candidates` runs — `HashMap::keys()`'s own iteration order is seeded per-instance, not per-process, so two `groups_by_element` instances built from identical input can still iterate in different orders within the same process; sorting first keeps the whole call reproducible for a fixed `rng` seed regardless — then visited exactly once. The `others` list handed to `build_nested_issue` is sorted the same way for the same reason.

**Wholly-protected groups (GitHub issue #209)**: a group none of whose elements pass `element_allowed` never enters the reverse index at all, so the normal candidate pass could never touch it — its own `to_remove` is zeroed out up front instead of being left to carry over forever, since it isn't a real problem to fix: every element implicated in it is individually disallowed, so there is nothing left to act on. This alone does **not** make the overall call `Fixed` — see "Resolution loop"/return value below, which is governed entirely by whether some *other* group actually got fixed.

**Resolution loop**: for each candidate in visiting order, skip it if no group that lists it still has `to_remove > 0` (already fully resolved via other elements). Otherwise calls `build_nested_issue("group_select", &target, &others)` and calls the nested strategy against the result.
- On success, `target` itself plus every other still-live candidate `element_invalidated` flags (given `nested_commands` and the pre-mutation `maze` snapshot) are dropped from the reverse index, and every group that still needed one of them has its `to_remove` decremented by one. A single shared/overlapping element can therefore retire one unit of budget in several groups at once.
- On failure, the candidate is dropped from the reverse index too, globally — the maze doesn't change within one call, so a failed candidate would fail identically on a second try from another group; there is nothing to gain by revisiting it.

A group is resolved once its `to_remove` reaches zero. If the candidate pass runs out (every remaining candidate filtered out or already tried and failed) some groups may still have `to_remove > 0` left — they simply carry over to the next repair iteration's freshly-recomputed issue (unless the group is wholly-protected, see above, in which case there is no future candidate to carry over to begin with). Commands from every successful (and attempted) nested call are concatenated, in order.

Returns `Fixed` if at least one nested call across the whole call succeeded, `Failed` if every nested call failed *or there was no nested call to make at all* (e.g. every group in the issue is wholly-protected). A wholly-protected group's own auto-resolve (above) never counts as "worked" on its own.

**Not used by `InvalidLoopGroupSelectStrategy`** — see that strategy's own section below for why loop-group cutting doesn't fit this per-candidate-per-nested-call contract (GitHub issue #210 explored and reverted the migration).

### OneWayGroupSelectStrategy

Handles `INVALID_ONE_WAY_GROUP` — see GitHub issue #199, generalized in #200 and #202. For each problematic group flagged by `OneWayGroupGeometricProximityCheck`/`OneWayGroupGraphProximityCheck`/`OneWayGroupSuperHubCheck`/`MaxOneWayCountCheck`/`MaxOneWayRatioCheck` (`InvalidOneWayGroupIssue.groups: Vec<(Vec<EdgeId>, u32)>` — see `quality_control.md`'s `InvalidGroupIssue<K>` doc comment), picks edges to fix and delegates each actual fix to a nested `INVALID_ONE_WAY` strategy (`OneWayToPassageStrategy`/`OneWayToWallStrategy`, see GitHub issue #198) filling the `fix_target` slot — mirrors `TeleportGroupSelectStrategy`'s per-pair resolution shape but generalized to any group size and any per-group fix count.

```rust
pub const SLOT_FIX_TARGET: &str = "fix_target";
```

One nested slot, `fix_target`, expecting exactly one `INVALID_ONE_WAY`-handling strategy (`min: 1, max: Some(1)`).

GitHub issue #208: the candidate-pass/budget/nested-delegation mechanics are now `group_select_apply` (above) — this strategy's own remaining responsibility is `OneWayGroupKind` (the `InvalidGroupIssueKind` marker wiring `INVALID_ONE_WAY_GROUP`/`INVALID_ONE_WAY`/`fix_target` back to the generic shape), resolving `SLOT_FIX_TARGET` from `nested`, `PARAM_PROTECT_ROUTE`, and (GitHub issue #210) supplying `build_nested_issue`/`element_invalidated`/`order_by_priority(params)` to `group_select_apply`.

**`PARAM_PROTECT_ROUTE`** (default `true`): a candidate lying on the maze's current start→finish route (`is_edge_on_route`) is excluded from the candidate pool entirely, for every group, before the visiting order is even built — passed to `group_select_apply` as its `element_allowed` closure.

### SplitGroupSelectStrategy

Handles `INVALID_SPLIT_TILE_GROUP` — see GitHub issue #249, epic #246. For each problematic group flagged by `MaxSplitCountCheck`/`MaxSplitDensityCheck`/`SplitGroupGeometricProximityCheck`/`SplitGroupGraphProximityCheck` (`InvalidSplitTileGroupIssue.groups: Vec<(Vec<SplitTileNodes>, u32)>` — see `quality_control.md`), picks whole split tiles to collapse and delegates each actual collapse to a nested `INVALID_SPLIT_TILE` strategy (`RemoveSplitStrategy`) filling the `fix_target` slot. Built on `group_select_apply` (above), same as `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy`, but its candidate `K::Element` is `SplitTileNodes` (a whole tile) rather than a single edge — every fix always collapses one entire tile, never picks nodes across different tiles (GitHub issue #249's regression fix, see `SplitTileNodes`'s own doc comment in `quality_control.md`).

```rust
pub const SLOT_FIX_TARGET: &str = "fix_target";
```

One nested slot, `fix_target`, expecting exactly one `INVALID_SPLIT_TILE`-handling strategy (`min: 1, max: Some(1)`).

There is no route-protection concept here (unlike one-way/teleport groups): a whole tile's collapse feasibility is entirely `RemoveSplitStrategy`'s/`ReplacePointNodes`'s own job at apply time (preset locks block the whole tile, all-or-nothing — GitHub issue #281), so `element_allowed` always returns `true`.

`element_invalidated` always returns `false`: no other still-live candidate tile can ever be invalidated by resolving this one — `RemoveSplitStrategy` collapses exactly one point (`MutationCommand::ReplacePointNodes` keyed by that point's own `at`), and distinct `SplitTileNodes` candidates are always different points' node sets, so they never overlap. `group_select_apply`'s own "target always counts as invalidated" rule already retires this tile's own budget on every successful fix; this hook has nothing left to add.

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `priority` | Enum | `problematic` | `random`, `problematic` (membership-across-groups, shared `group_select::PRIORITY_*` semantics), `most_voluminous`/`least_voluminous` (sorts by `SplitTileNodes.0.len()` — total node count, slot-0 included), `most_connected`/`least_connected` (sorts by total incident edge count across every node in the tile, both directions, slot-0 included). |

`SPLIT_PRIORITY_OPTIONS` is a superset of the shared `PRIORITY_OPTIONS` (`random`/`problematic`, see `group_select.rs`) with four split-specific metrics added — kept local to this strategy rather than widening the shared constant, since `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy` have no equivalent per-candidate size/connectivity notion (an edge has neither). Every metric respects the epic's "slot-0 is not otherwise special" rule (`quality_control.md`): both `_voluminous` and `_connected` sort by the tile's *entire* node list, not just its extra nodes. Ties (equal volume/connectivity/membership) are broken by an unconditional shuffle applied before sorting, same rationale `order_by_priority` uses.

### ElevatorGroupSelectStrategy

Handles `INVALID_ELEVATOR_GROUP` — see GitHub issue #398, epic #344. For the group flagged by `MaxElevatorCountCheck`/`MaxElevatorDensityCheck` (`InvalidElevatorGroupIssue.groups: Vec<(Vec<ElevatorNodes>, u32)>` — see `quality_control.md`), picks whole elevators to remove and delegates each actual removal to a nested `INVALID_ELEVATOR` strategy filling the `fix_target` slot. Built directly on `group_select_apply` (above), same shape as `SplitGroupSelectStrategy` — its `K::Element` is `ElevatorNodes` (a whole elevator's stop-node set), so every fix always removes one entire elevator, never touches individual stop nodes.

```rust
pub const SLOT_FIX_TARGET: &str = "fix_target";
```

One nested slot, `fix_target`, expecting exactly one `INVALID_ELEVATOR`-handling strategy (`min: 1, max: Some(1)`, `dispatch_kind: Unordered`).

Same as `SplitGroupSelectStrategy`: no route-protection concept (`element_allowed` always `true` — an elevator's removal feasibility is the nested strategy's own job at apply time), and `element_invalidated` always returns `false` (distinct `ElevatorNodes` candidates are always disjoint stop-node sets, so resolving one can never invalidate another still-live candidate).

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `priority` | Enum(`random`/`problematic`) | `problematic` | Which eligible elevator to remove first — the shared `group_select::PARAM_PRIORITY` param, no elevator-specific metrics (unlike `SplitGroupSelectStrategy`'s volume/connectivity options). |

### ElevatorStopGroupSelectStrategy

Handles `INVALID_ELEVATOR_STOP_GROUP` — see GitHub issue #399, part of epic #344. For the group flagged by `MaxElevatorStopsCheck`/`MaxElevatorStopsPerFloorCheck` (`InvalidElevatorStopGroupIssue.groups: Vec<(Vec<NodeId>, u32)>` — see `quality_control.md`), picks stop nodes to remove and delegates each actual removal to a nested `INVALID_ELEVATOR_STOP` strategy filling the `fix_target` slot. Built directly on `group_select_apply` (above), mirrors `ElevatorGroupSelectStrategy`'s shape except `K::Element` is a bare `NodeId` (one stop), not a whole `ElevatorNodes` — every fix removes one stop from whichever elevator it belongs to, never the whole elevator.

```rust
pub const SLOT_FIX_TARGET: &str = "fix_target";
```

One nested slot, `fix_target`, expecting exactly one `INVALID_ELEVATOR_STOP`-handling strategy (`min: 1, max: Some(1)`, `dispatch_kind: Unordered`) — `RemoveElevatorStopStrategy`.

No route-protection concept (`element_allowed` always `true`), and `element_invalidated` always returns `false` — removing one stop only touches edges incident to that stop, never another stop's own edges, so no other still-live candidate can ever be invalidated by resolving one.

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `priority` | Enum(`random`/`problematic`) | `problematic` | Which eligible stop to remove first — the shared `group_select::PARAM_PRIORITY` param. |

### RemoveElevatorStopStrategy

Handles `INVALID_ELEVATOR_STOP` — see GitHub issue #399, part of epic #344. Removes each flagged stop node from its own elevator: every `EdgeKind::Elevator` edge between that stop and any of the elevator's other stops, via `elevator_utils::remove_stop_commands`. The rest of the elevator (its remaining stops' own fan) is left untouched — distinct from `RemoveElevatorStrategy`, which removes the whole elevator. A flagged stop no longer part of any current elevator (e.g. an earlier fixpoint iteration already removed it) is simply skipped. No configurable parameters. Always returns `Fixed { score: None }`, mirroring `RemoveElevatorStrategy`'s own "always succeeds, commands may be empty" contract.

### elevator_utils (shared, not a strategy)

`maze-core/src/repair/strategies/elevator_utils.rs` — reusable per-stop/whole-elevator command builders, factored out for GitHub issue #399 so future elevator-editing strategies (e.g. adding a stop, adding a whole elevator across a floor range) have a single place to build from. Currently exposes:

- `find_elevator_by_stop(maze, stop) -> Option<Elevator>` — re-resolves (via `elevator_core::elevator_groups`) which current elevator a bare `NodeId` belongs to. The shared lookup every per-stop operation needs, since a group-select candidate only carries a bare `NodeId`, not the elevator it came from.
- `remove_elevator_commands(maze, stop) -> Option<Vec<MutationCommand>>` — every edge of the whole elevator `stop` belongs to (used by `RemoveElevatorStrategy`'s equivalent inline logic; exists here for reuse, not yet wired into that strategy).
- `remove_stop_commands(maze, stop) -> Option<Vec<MutationCommand>>` — only the edges incident to `stop` within its elevator, used by `RemoveElevatorStopStrategy`.

Adding a stop to an existing elevator, or adding a whole new elevator across a floor range, are not implemented yet — no current check/strategy needs them — but this module is the intended home for them when they're needed.

### split_core (shared, not a strategy)

`maze-core/src/repair/strategies/split_core.rs` — split-tile face-planning logic shared by `AddSplitStrategy` (GitHub issue #247) and `MissingLoopsSplitStrategy` (GitHub issue #254), factored out once the latter needed the same rotation/mirror search and existing-connection bookkeeping with one extra constraint: a specific new node must end up connected to a specific pre-chosen neighbor (a loop-closing bridge), and that same node must carry at least one more connection so it's a through-node, not a dead end.

```rust
pub(crate) struct RequiredConnection { pub neighbor: NodeId, pub direction: SplitNodeEdgeDirection }
pub(crate) type ExcludedTargets<'a> = &'a HashSet<NodeId>;

pub(crate) fn pick_weighted_pattern(patterns: &[SplitPattern], rng: &mut dyn RngCore) -> usize;
pub(crate) fn existing_directions<T: Tessellation>(maze: &Maze<T>, at: NodeId) -> Vec<(NodeId, SplitNodeEdgeDirection)>;
pub(crate) fn plan_unconstrained_split<T: Tessellation>(
    maze: &Maze<T>, at: NodeId, node_count: usize,
    required: Option<&RequiredConnection>, excluded: ExcludedTargets, rng: &mut dyn RngCore,
) -> Option<Vec<Vec<SplitNodeEdge>>>;
pub(crate) fn plan_pattern_split<T: Tessellation>(
    maze: &Maze<T>, at: NodeId, pattern: &SplitPattern,
    required: Option<&RequiredConnection>, excluded: ExcludedTargets, rng: &mut dyn RngCore,
    allow_lose: bool, allow_add: bool,
) -> Option<Vec<Vec<SplitNodeEdge>>>;
```

`required`, when `Some`, must be satisfied by the returned plan: some node of the tile has a `SplitNodeEdge { target: neighbor, direction }` matching `required` **and** at least one other edge (existing or newly added) of its own. `None` reproduces `AddSplitStrategy`'s original, unconstrained behavior exactly — `plan_unconstrained_split`/`plan_pattern_split` are the same functions `AddSplitStrategy` calls (as `core_plan_unconstrained_split`/`core_plan_pattern_split`), just with `required: None` and its own per-call `committed: HashSet<NodeId>` as `excluded`.

**`ExcludedTargets`** — nodes a *new* edge (one not already present in `maze.graph`) must never target: every node belonging to a point another command already committed to replace earlier in the same `apply()` batch. Such a node's id won't exist by apply time (`ReplacePointNodes` mints a fresh id set for its point), so a brand-new `SplitNodeEdge` pointing at it would make the whole proposing command decline outright at apply time — silently, since `replace_point_nodes_feasible` requires every edge `target` to still resolve. An *existing* edge is never affected (its target obviously still exists right now, planning against an immutable snapshot) — only "does this new edge get planned at all" decisions consult this set: `required.neighbor` itself, `plan_unconstrained_split`'s fallback second-edge pick, and every neighbor (existing or new) `try_pattern_adaptation` resolves a pattern face against.

**Bug this fixed (no dedicated issue number, found while implementing #254)**: planning several `ReplacePointNodes` commands in one `apply()` call against neighboring points, with no `excluded` bookkeeping, could have a later command's `SplitNodeEdge::target` point at a node an earlier command in the same batch already replaced — that id no longer resolves by the time `apply_commands` applies it, so the whole later command is silently dropped (all-or-nothing feasibility), instead of minting the split tile it was supposed to. `ExcludedTargets` closes this by rejecting any such target at planning time, so a caller only ever proposes commands survivable at apply time; `MissingLoopsSplitStrategy` tracks its own committed points as `split_points` for this purpose (see below), `AddSplitStrategy` as `committed`.

### RemainingDeficits (shared, not a strategy)

A live, mutable working copy of a deficit issue's `missing: Vec<(RepairArea, u32)>`, shared by every strategy that services a `min_*`/`split_count`/`split_density`-style deficit issue: `MissingLoopsRandomStrategy`, `MissingLoopsSplitStrategy`, `MissingOneWaysFromWallStrategy`, `MissingOneWaysFromPassageStrategy`, `MissingTeleportsStrategy`, `AddSplitStrategy` (all listed below).

**Why this exists** (GitHub issue #369 double-repair follow-up): a `FloorScope::PerFloor` check and a `FloorScope::WholeMaze` check on the *same* rule both contribute entries to one issue's `missing` (e.g. "3 per floor" + "12 whole-maze" on a 3-floor maze) — the whole-maze entry isn't independent of the per-floor entries, it's the *same* underlying requirement measured a different way, so satisfying a per-floor entry must count against the whole-maze entry too. Without this, a strategy that just loops `issue.missing` and adds the full amount for every entry independently massively over-delivers (21 instead of 12 in the example above).

```rust
pub(super) struct RemainingDeficits { /* entries: Vec<(RepairArea, u32)> */ }

impl RemainingDeficits {
    pub(super) fn new(missing: &[(RepairArea, u32)]) -> Self;
    pub(super) fn areas(&self) -> impl Iterator<Item = RepairArea> + '_;
    pub(super) fn live(&self, area: RepairArea) -> u32;
    pub(super) fn consume(&mut self, covered: &[RepairArea]);
    pub(super) fn consume_many(&mut self, area: RepairArea, count: u32);
}
```

`new` sorts every `Level` entry before the (at most one) `WholeMaze` entry, by `LevelId` — a strategy processes floors first and the whole-maze catch-all last, by which point every per-floor need has already been satisfied and reflected in the live whole-maze count via `consume`.

`areas()` gives the processing order for one `apply()` call; `live(area)` gives the up-to-date remaining count for `area`, reflecting every `consume` so far. `consume(covered)` is called once a new entity is actually added, decrementing (saturating) every live entry whose area is in `covered` — always both the entity's own area and `RepairArea::WholeMaze`, since `WholeMaze` represents the same requirement as every floor's own entry, not an independent one; a teleport additionally covers its exit floor if that differs from its entry floor. `consume_many(area, count)` is `consume(&[area, RepairArea::WholeMaze])` called `count` times, for a caller that only learns an aggregate count after the fact (e.g. `missing_one_ways_shared::pick_random_pairs`, which returns one `found: u32` per area rather than notifying per accepted pair).

### AddSplitStrategy

Handles `MISSING_SPLIT_TILES` — see GitHub issue #247, split-QC epic #246. Mints new split tiles at randomly chosen eligible points (`generation::split_is_eligible` — not locked, point not already multi-node) until `issue.missing` is satisfied or `max_attempts` **failed** attempts have been spent (successful attempts don't count against the budget). Every node at the chosen point — slot-0 included — is replaced in one atomic step, via `MutationCommand::ReplacePointNodes` (see above); slot-0 is not special-cased (epic #246's "slot-0 is not special" rule).

```rust
pub struct AddSplitStrategy {
    pub config: SplitGenerationConfig,
}
```

**Construction-time field, not `StrategyParams`.** `config` is an ordinary struct field (a plain `generation::SplitGenerationConfig` — the exact same type generation's own `split_generation` field carries, reused as-is rather than duplicating its `pattern_mode`/`max_split_nodes`/`patterns` shape onto this strategy directly), resolved once when `maze-runner`'s `build_add_split_strategy` (`strategy_factory.rs`) constructs this strategy from its `StrategyConfig.params` — unlike every other registered strategy (all unit structs, purely `StrategyParams`-configured). This is a deliberate exception, not an oversight: `maze-core` has no serde dependency at all (an intentional architectural boundary), so `apply()` can't parse a JSON-serialized pattern list itself the way `StrategyParamValue::Text` would require; only `maze-runner` (which does depend on serde) can decode `config`'s wire JSON, via `parse_split_config_param` — parsing the exact same `SplitGenerationConfigDto` wire shape `GenerateConfig.split_generation` uses, carried under the strategy's own single `split_config` param (a JSON string) rather than three separate params. `build_strategy_erased` is the one registry factory function that takes a `&HashMap<String, String>` alongside the strategy id for exactly this reason — every other id in its match arms ignores that parameter and constructs a plain unit struct.

**Web UI**: `AddSplitStrategy`'s `split_config` param is exposed to the web layer as its own `ParamKindDto::SplitGenerationConfig` variant (`maze-wasm/src/checks_catalog.rs`) — a single settings button opening the exact same dialog body (`SplitGenerationSettingsBody`, `maze-web`) generation's own split settings dialog uses, rather than three separate param controls (a bool switch, an integer input, and a pattern-list button) cluttering the strategy's own param list. `SplitCountCheck`/`SplitDensityCheck`'s own `patterns` param stays a flat `ParamKindDto::PatternList` (no mode switch, no `max_split_nodes` — just a membership filter list), since a check has no unconstrained-mode concept of its own.

**Parameters (ordinary `StrategyParams`):**

| id | type | default | description |
|----|------|---------|-------------|
| `allow_lose_connections` | Bool | `true` | Whether a candidate may drop an existing connection no sibling's face claims (pattern mode only). |
| `allow_add_connections` | Bool | `true` | Whether a candidate may add a connection no sibling previously had (pattern mode only). |
| `max_attempts` | Float | `50` | Failed-attempt budget for the whole `apply()` call (successful attempts don't count). |

`protect_route` (rule-level since GitHub issue #253, see `quality_control.md`'s "Rule-level parameters" — not a `StrategyParam` of this strategy's own, unlike the table above): when enabled (default), excludes every node on the maze's current start->finish route (`graph::route_protection::is_node_on_route`) from the candidate pool — never places a split on a route-critical point.

**Pattern-mode candidate (`patterns` non-empty)**: a candidate point is picked at random, a pattern is picked honoring `SplitPattern::weight` (`pick_weighted_pattern`, via the shared `math::weighted_index` — falls back to a uniform pick only when every candidate pattern's weight is `<= 0`; GitHub issue #275 fixed this strategy from picking uniformly regardless of weight), and a rotation/mirror is picked at random, then every one of the pattern's `node_count` new nodes — **including node 0**, the new slot-0 — has its own faces resolved against the point's actual neighbors (`try_pattern_adaptation`, independent of generation's own `enumerate_adaptations` — there is no frontier/visited state here, every neighbor already belongs to the built maze). Each of the point's existing connections is matched against whichever new node's face points that direction:
- A direction with an existing connection but **no** new node claiming it: dropped if `allow_lose_connections`, otherwise the whole candidate fails.
- A direction with **no** existing connection but a new node's face requires one (Passage/OneWay): added if `allow_add_connections`, otherwise the whole candidate fails.
- A direction with an existing connection matched by one or more new nodes' faces: the connection is preserved onto *every* claiming node — the original neighbor is never itself split, it simply gains one edge per claiming node.

Resolving node 0's own faces the same way as every other node is the actual fix for the bug that motivated this rework: an earlier version left node 0 (slot-0) unresolved entirely, so a pattern-mode split tile's real slot-0 connections never had to agree with what the configured pattern said about them, producing tiles that didn't structurally match the only configured pattern at all.

**Rotation/mirror indices are per-tessellation symmetries, not raw arithmetic** (GitHub issue #275): a `rotation` index picks from `Tessellation::rotation_symmetries()` and a `mirror` index (`Option<usize>`, `None` = no mirror) picks from `Tessellation::mirror_symmetries()` — each an explicit permutation table of `Self::faces()` indices, stated per tessellation rather than derived from a shared formula. This replaced an earlier `(face_index + rotation) % degree` / `(degree - face_index) % degree` arithmetic scheme that silently assumed every tessellation's `faces()` order was angular (true for `HexTessellation`'s `[E, NE, NW, W, SW, SE]`, false for `SquareTessellation`'s `[N, S, E, W]` and `TriTessellation`'s `[Left, Right, Base]`) — applied to the square case, "mirror" ended up swapping `N`/`W` instead of the intended `E`/`W`, producing a pattern-mode split tile that didn't match any configured pattern's real geometry. `space::transform_face_index` (shared by this strategy, generation's own `enumerate_adaptations`/`handle_pattern_split`, and `quality_control::split_pattern_match::split_tile_matches_any`) is now the single implementation applying these tables.

**Resolving a neighboring point that is itself already a split tile**: when a candidate's new node's face points at a point with more than one node (`Field::nodes_at`), `try_pattern_adaptation` prefers whichever of that point's nodes already has a real edge with `at` in that direction, falling back to the neighbor's slot-0 only when none of its nodes are connected yet (mirrors `split_pattern_match::reconstruct_tile_faces`'s own `candidates.iter().any(...)` check). Always picking the neighbor's slot-0 unconditionally was a real bug: adding a split tile next to an already-split neighbor whose actual connection lived on a non-slot-0 node (e.g. slot-1) would silently sever that edge from its real owner and try to wire the new tile to the neighbor's unconnected slot-0 instead.

**Unconstrained candidate (`patterns` empty)**: `max_split_nodes` (at least 2) total nodes; every one of the point's existing connections is reassigned, unchanged (same direction), to one uniformly random node among all `max_split_nodes` new nodes — index 0 (the new slot-0) on equal footing with every other index, no special weighting or reservation. `allow_lose_connections`/`allow_add_connections` don't apply here (no connection is ever lost or invented, only reassigned).

**Own pattern-selection config, independent of the producing check's own `patterns` filter** — see `quality_control.md`'s `SplitCountCheck`/`SplitDensityCheck` section for the shared "known limitation" this implies (a check's `patterns` filter is invisible to this strategy, so a mismatched configuration can spin the repair loop). `SplitPattern` is compared structurally, carries no id — see that same section.

**Retry/termination**: candidates are drawn from a pool of every `split_is_eligible` point not currently on the start->finish route (when `protect_route` is enabled), one at a time (`pool.swap_remove` on every attempt, success or failure) so no point is retried twice in the same call — this guarantees termination independent of `max_attempts`. `apply()` returns `Fixed` if at least one split tile was added (even if `missing` wasn't fully satisfied — the deficit simply carries over to the next repair iteration's freshly-recomputed issue), `Failed` if zero were added by the time `max_attempts` failed attempts are spent or the pool runs dry (including when `protect_route` leaves no eligible candidate at all).

Connectivity (`most_connected`/`least_connected`) is computed via a `HashMap<NodeId, usize>` incoming-degree map built once per `order_candidates` call (a single O(E) pass over `maze.graph.edges()`) rather than re-scanning the whole edge list per node inside the sort comparator — `Graph` has no incoming-edge index of its own, so a naive per-node `graph.edges().filter(|e| e.to == node).count()` would cost `O(candidates * tile_nodes * E)` across one sort.

### MissingLoopsSplitStrategy

Handles `MISSING_LOOPS` — see GitHub issue #254, part of epic #246. Alternative to `MissingLoopsRandomStrategy`'s plain new-edge seeding: instead of connecting a random geometrically-adjacent pair directly with a bare edge, turns one side of the pair into a split tile, so the bridge is carried by one of the tile's own nodes rather than being a new edge on an otherwise-ordinary cell. Same "seed and let QC re-check" contract as `MissingLoopsRandomStrategy` — no attempt to verify the new connection actually closes a cycle.

```rust
pub struct MissingLoopsSplitStrategy {
    pub config: SplitGenerationConfig,
}
```

Same construction-time `config` field as `AddSplitStrategy` (see above) — an ordinary `generation::SplitGenerationConfig`, resolved by `maze-runner`'s `build_missing_loops_split_strategy` the same way `build_add_split_strategy` resolves `AddSplitStrategy`'s own, carried under the strategy's `split_config` wasm param (`ParamKindDto::SplitGenerationConfig`, same convention).

**Parameters (ordinary `StrategyParams`):**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `reserve_percent` | Float | `50.0` | `[0, 500]` | Mirrors `MissingLoopsRandomStrategy`'s own param — target bridge count is `ceil(missing * (1 + reserve_percent/100))`. |
| `protect_route` | Bool | `true` | — | Excludes every node on the maze's current start->finish route from the candidate pool — same gate `AddSplitStrategy` applies. |
| `max_attempts` | Float | `50` | `[1, 10000]` | Failed-attempt budget for the whole `apply()` call. |
| `src_mode` | Enum | `random` | `random`, `dead_end_priority` — see `dead_end_priority` above. |

No `allow_lose_connections`/`allow_add_connections` params, unlike `AddSplitStrategy` — always calls `split_core::plan_pattern_split` with both forced `true`: the whole point of the split is a *new* connection to `dst` (`allow_add: false` would make every candidate fail outright, since the bridge is by definition not a pre-existing connection), and a bridge tile freely redistributing `at`'s other existing connections to fit the chosen pattern/rotation — dropping whichever don't fit, adding whichever new ones do — is exactly the behavior wanted here, not a configurable choice.

**Candidate selection**: candidate pool is every `split_is_eligible` node (not locked, point not already multi-node), filtered by `protect_route` the same way `AddSplitStrategy` is, then ordered by `apply_src_mode(src_mode)` (see `dead_end_priority` above). Pops a `src` node (via `Vec::pop`, preserving `dead_end_priority`'s tail ordering), then tries each of `src`'s geometric neighbors (`maze.field.neighbors`, random order) as `dst` — skipping a pair already connected (either direction) or already attempted this call, and skipping any `dst` whose point was already turned into a split tile earlier in the same `apply()` call (`split_points: HashSet<NodeId>` — the same "don't target an already-committed point" bookkeeping `split_core::ExcludedTargets` formalizes). A candidate pair whose split planning fails is abandoned in favor of a different `dst`, then a different `src` — never retried against the same `(src, dst)`.

**Building the split tile**: `src` is replaced by a split tile (`MutationCommand::ReplacePointNodes`) built via `split_core::plan_unconstrained_split`/`plan_pattern_split` (pattern chosen via `pick_weighted_pattern` when `config.patterns` is non-empty), with `required: Some(RequiredConnection { neighbor: dst, direction: Passage })` and `excluded: &split_points`. One hard constraint on top of `split_core`'s own required-connection contract: whichever new node ends up carrying the bridge to `dst` must have at least one more edge of its own (a through-node, not a dead end) — drawn from `src`'s other existing connections if any land there, otherwise a brand-new edge to any other free geometric neighbor of `src`.

Returns `Failed` if zero split tiles were added by the time `max_attempts` failed attempts are spent or the pool runs dry (including when no split-eligible candidate exists at all); otherwise `Fixed { score: None }` with every proposed command, even if fewer than `target` were actually added.

### PriorityMissingLoopsStrategy

Handles `MISSING_LOOPS` — see GitHub issue #259, the priority-fallback dispatch mechanism applied
to the `MissingLoopsRandomStrategy`/`MissingLoopsSplitStrategy` pair. Picks *which* nested
missing-loops strategy actually runs, trying its nested candidates in configured order
(`dispatch_priority`, see "Priority nested dispatch" above) — the first candidate is attempted,
only on `Failed` does it fall through to the next, until one succeeds or the list is exhausted.

Unlike `PriorityRegionMergeStrategy`/`WeightedRegionMergeStrategy`, `MissingLoopsIssue` isn't a
batch of independently-addressable items — it carries a single scalar `missing: u32` deficit for
the whole maze, not a per-item list — so there is nothing to split per-item here: the incoming
issue is passed through to `dispatch_priority` **unchanged**, one dispatch per `apply()` call.

No configurable parameters of its own.

**Nested slot**: exactly one, `slot_id = "loop_seed_target"` (its own constant, deliberately not a
reuse of any `*GroupSelectStrategy`'s `"fix_target"` — that string already means "exactly one
required fixer", `max: Some(1)`, a different semantic from this slot's "any number of
priority-ordered candidates"), `kind = MISSING_LOOPS`, `min = 1`, `max = None`,
`dispatch_kind = Priority`.

- If `issue.missing == 0`: returns `Fixed` immediately (idempotency), without touching `rng` or
  `nested`.
- Nested entries are filtered to `slot_id == SLOT_LOOP_SEED_TARGET` — same defensive runtime
  posture as `WeightedRegionMergeStrategy`/`PriorityRegionMergeStrategy` toward their own slots. If
  no candidate fills the slot after filtering: returns `Failed`.
- Otherwise delegates directly to `dispatch_priority` with the unmodified `issue`.

### AddVerticalPassageStrategy

Handles `MISSING_VERTICAL_PASSAGES` — see GitHub issue #343. For each missing slot (`issue.missing: Vec<(RepairArea, u32)>`, mandatory — the producing check already computed it, same "no other channel" contract every deficit strategy shares), picks a random node whose adjacent floor (up or down, chosen at random when both exist — a boundary floor has only one direction available) resolves a target node at the same `(x, y)` point (`vertical_target::resolve_vertical_target` — shared module, see below, mirrors `generation::vertex_based`'s own floor-adjacency resolution), then adds a `VerticalPassage` edge between them. Deliberately much simpler than `MissingTeleportsStrategy` — no entry-pick/desired-length/attempts-limit/reserve-percent machinery — since a vertical passage's target is already fully determined by adjacency, unlike a teleport's free choice of any node pair.

**Parameters:**

| id | type | default | range | description |
|----|------|---------|-------|-------------|
| `one_way_balance` | Float | `0.5` | `[0, 1]` | Chance the newly added passage is one-way (direction already rolled by the target resolution) rather than two-way. Rendered in the UI as a percent slider (`PERCENT_FRACTION_SLIDER_PARAM_IDS`). |

For each deficient area (in `issue.missing` order), builds a candidate pool from every node in that area (`RepairArea::WholeMaze` = every field node, `RepairArea::Level(level)` = only that floor's own nodes) and repeatedly pops a random `src` from the pool, resolves its vertical target via `vertical_target::resolve_vertical_target`, and — unless both directions between the pair already exist — rolls `one_way_balance` to decide `AddDirectedVerticalPassage` (single direction, gated by `directed_edge_feasible`) vs. `AddBidirectionalVerticalPassage`. A `src` whose target can't be resolved (no adjacent floor, or no node at the same point on it) is simply skipped, not retried. Each successfully added edge retires that unit of deficit from **every** `RepairArea` it touches (`WholeMaze` and, if resolvable, `src`'s own `Level`) via the shared `RemainingDeficits` bookkeeping (see below) — the same live-deficit-sharing mechanism `MissingLoopsRandomStrategy`/`MissingOneWaysFromWallStrategy`/`AddSplitStrategy` use, so stacking a `WholeMaze`-scoped and a `PerFloor`-scoped instance of these checks in one rule never double-delivers.

Returns `Failed` if nothing was added across every area (e.g. a single-level field, where no node has any vertical target at all); otherwise `Fixed { score: None }` with every proposed command, even if the pool ran dry before every area's own deficit was fully closed.

### RemoveVerticalPassageStrategy

Handles `INVALID_VERTICAL_PASSAGE` — see GitHub issue #343. The single, fixed fix strategy for the mandatory `fix_target` slot `VerticalPassageGroupSelectStrategy` (below) delegates to — mirrors `RemoveTeleportStrategy`'s shape: removes each flagged edge in `issue.invalid` via `MutationCommand::RemoveVerticalPassageWithReverse { id }`, which also removes the opposite-direction `VerticalPassage` edge between the same node pair, if any, so a two-way vertical passage is never left silently downgraded to one-way just because a check's edge selector only inspected/flagged one direction. No configurable parameters — unlike `RemoveTeleportStrategy`'s `allow_reverse`, downgrading to one-way was not requested for this kind. An empty `invalid` is valid — nothing to remove, returns `Fixed { score: None }` immediately.

### VerticalPassageGroupSelectStrategy

Handles `INVALID_VERTICAL_PASSAGE_GROUP` — see GitHub issue #343. Produced by `MaxVerticalPassageCountCheck`/`MaxVerticalPassageRatioCheck` (maze-wide/per-floor excess) and the two proximity checks (`VerticalPassageGroupGeometricProximityCheck`/`VerticalPassageGroupGraphProximityCheck`). Mirrors `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy` exactly: candidate-pass/budget/nested-delegation mechanics live entirely in the shared `group_select::group_select_apply`, `VerticalPassageGroupKind` in place of `OneWayGroupKind`/`TeleportGroupKind`.

```rust
pub const SLOT_FIX_TARGET: &str = "fix_target";
```

One nested slot, `fix_target`, expecting exactly one `INVALID_VERTICAL_PASSAGE`-handling strategy (`min: 1, max: Some(1)`, `dispatch_kind: Unordered`) — `RemoveVerticalPassageStrategy`.

**Parameters:**

| id | type | default | options | description |
|----|------|---------|---------|-------------|
| `priority` | Enum | `problematic` | `random`, `problematic` | Which edge of a flagged group to remove first — `group_select`'s own `PARAM_PRIORITY` (see `GroupSelectStrategy / group_select_apply` above); `problematic` visits the highest-membership edge first, globally across every group. |

No route protection — unlike `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy`, this strategy's `element_allowed` closure always returns `true`; a vertical passage group excess isn't gated by a `protect_route` param in this issue's scope. `element_invalidated` checks `crate::repair::removed_edge_ids(nested_commands).contains(edge)` — no extra reverse-direction bookkeeping beyond that (unlike `TeleportGroupSelectStrategy`'s own gap-workaround for `RemoveTeleportWithReverse`), since `RemoveVerticalPassageWithReverse`'s own reverse removal is likewise not separately surfaced by `removed_edge_ids`, but no strategy-side symptom of that gap has been observed for this kind yet.

Same `Fixed`/`Failed` result contract as `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy`'s "wholly-protected groups" case: with no route protection here, every group always has at least one allowed candidate, so this particular failure mode (every group wholly protected) cannot occur for this strategy — `Failed` is only reached via `group_select_apply`'s own generic "nothing was actually fixed" path (e.g. `issue.groups` non-empty but no nested strategy configured).

### RemoveElevatorStrategy

Handles `INVALID_ELEVATOR` — see GitHub issue #397, part of epic #344. Fully removes each flagged elevator: every `EdgeKind::Elevator` edge among its stops, via `MutationCommand::RemoveEdgeWithReverse`. `issue.invalid` names each elevator by its stop-node set (`ElevatorNodes`), not by a saved edge list (mirrors `RemoveSplitStrategy`'s "whole entity, not a saved edge list" approach) — the current fan of edges between those stops is re-resolved against `maze` at apply time via `elevator_core::elevator_groups` (matched by sorted-stops equality), so a stale issue (an elevator already partially repaired by an earlier fixpoint iteration) still removes whatever of its own edges remain rather than replaying a possibly-stale edge list. A flagged elevator no longer present in the current maze (no matching entry in `elevator_groups`) is simply skipped. No configurable parameters. Returns `Fixed { score: None }` even if every flagged elevator was skipped (mirrors other "always succeeds, commands may be empty" removal strategies) — only `ReplaceElevatorWithPassagesStrategy` distinguishes a genuinely empty result as `Failed`.

### ReplaceElevatorWithPassagesStrategy

Handles `INVALID_ELEVATOR` — see GitHub issue #397, part of epic #344. Replaces each flagged elevator with sequential two-way `VerticalPassage` edges between floor-adjacent stops, then removes the elevator's own `Elevator`-kind fan edges. Elevator resolution and the "flagged elevator no longer present" skip mirror `RemoveElevatorStrategy` above.

**Parameters:**

| id | type | default | description |
|----|------|---------|-------------|
| `adjacent_floors_only` | Bool | `true` | See below. |

For a matched elevator with no fan edges at all (a degenerate single-stop elevator — nothing to remove or replace), the elevator is skipped entirely, not counted as fixed. Otherwise, the elevator's own `Elevator` edges are queued for removal via `MutationCommand::RemoveEdgeWithReverse` **before** any replacement `VerticalPassage` is queued — `MutationCommand::AddBidirectionalVerticalPassage`'s own `edge_between` existence check is not `EdgeKind`-gated, so a still-present `Elevator` edge between a target pair would make the add silently no-op if the order were reversed. The elevator's edges are removed unconditionally once matched, regardless of whether any replacement pair is actually found — the elevator must always vanish, never survive with a passage spanning a gap it was never meant to have.

- **`adjacent_floors_only: true`** (default) — a passage is added only between pairs of the elevator's own stops that are genuinely floor-adjacent (consecutive floor indices via `MultiLevelField::level_index_of`, not merely consecutive entries in the sorted stop list). An elevator whose stops skip a floor (e.g. stops at floors 1 and 5, with no adjacent pair among them at all) produces no passage whatsoever for that gap — never a single passage bridging it.
- **`adjacent_floors_only: false`** — passages are added from the elevator's bottommost to topmost stop, stepping through every floor level in between (`MultiLevelField::levels_ordered`) at the elevator's own `(x, y)` point, including floors the elevator itself never stopped at. A floor where that point has no node (`MultiLevelField::node_at` returns `None`) is skipped — both the passage into it and the passage out of it are dropped; the chain does not reconnect around the gap by bridging directly across it.

Returns `Failed` only if no flagged elevator produced any command at all (none matched, or every match was the single-stop degenerate case); otherwise `Fixed { score: None }`.

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
   - **`check_and_dispatch`: run QC and dispatch repair together — stage-scoped, not stage-agnostic.** For each `Box<dyn RuleTrait<T>>` in `self.rules`, **in `self.rules`' own configured order** (no sorting — see GitHub issue #170: sorting by rule id existed only to give the pre-#170 no-progress guard a stable snapshot to compare across iterations; once that guard was removed, nothing needs a re-derived order, so dispatch simply follows the order the rule config itself specifies), skipping ids already in the local `failed` set, call `rule.check_and_repair(maze, rng, preset_state, ...)` — this only runs **this stage's own** checks, unlike the pre-#106 pipeline, which ran every check across every stage every iteration (explicitly called out as wasteful, see GitHub issue #106), and immediately dispatches repair for that same rule if it found anything and has a strategy — no intermediate `Box<dyn Issue>` list held across a second pass (see GitHub issue #170's "Rule, Stage" section above). **Rule-level merge happens inside `check_and_repair_typed`'s own `run_checks_typed` step**: a rule's own multiple checks fold into at most one issue via `IssueMerge::merge` (moved from `pipeline.rs` to `quality_control/rule.rs`, and from a runtime `merge_issue` function to each concrete type's own `IssueMerge` impl by GitHub issue #113 — same per-type merge rules: `InvalidLoopIssue` via a three-step normalize→dedup→remap canonical merge, `RegionNeedsExpansionIssue`/`InvalidTeleportIssue`/`InvalidTeleportGroupIssue` via plain dedup-union, `MissingRegionsIssue` takes the plain `min` per class (a shortfall always wins over a surplus regardless of magnitude; between two shortfalls or two surpluses, `min` picks the larger shortfall or the smaller surplus respectively) — see "Rule, Stage, and the unified QualityControlEngine" above and `quality_control.md`'s "Dedup interaction" for the full per-type rules). Each call's `RuleIterationOutcome` decides what happens next: `NoIssue` → nothing; `NoStrategy` → counts toward "this stage isn't converged yet" but nothing to apply; `Repaired(result, outcome)` → `Failed` adds `rule.id()` to the local `failed` set, `Fixed { score: Some(s) }` sets `maze.meta.route_score` if not already set.

**`failed` is not a permanent blacklist for the stage run (GitHub issue #280).** `RepairResult::Failed` means only "this strategy could not fix the issue instance it was just given" (see `RepairResult`'s own doc comment above), not "this strategy is broken for the rest of the stage's fixpoint loop" — a later pass's mutation can reshape or remove the very issue that made an earlier rule fail, at which point that rule deserves another try. `check_and_dispatch` captures `maze.graph.version()` before dispatching each rule and compares it after; if the version changed (the same signal `MazeAnalysis` uses to detect stale caches), `failed` is cleared entirely, not just for the rule that just ran — every previously failed rule in this stage gets retried starting the next time it comes up, whether later in the same pass or on the next fixpoint iteration. If no rule's dispatch mutates the graph during a pass, `failed` carries over unchanged, since nothing could have changed for any failed rule's issue.
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

See GitHub issue #56, extended into a hierarchical tree by GitHub issue #285. `build_maze` collects a per-call timing breakdown and returns it as a third tuple element:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TimingEntry {
    pub total_ms: f64,
    pub calls: u32,
}

#[derive(Debug, Clone, Default)]
pub struct TimingNode {
    pub id: String,
    pub entry: TimingEntry,
    pub children: Vec<TimingNode>,
}

#[derive(Debug, Clone, Default)]
pub struct GenerationTiming {
    pub initial_build_ms: f64,
    pub qc: Vec<TimingNode>,
}

pub fn build_maze<T: Tessellation>(..., event_log: Option<&mut EventLog<QcEvent>>) -> (Maze<T>, Vec<Box<dyn Issue>>, GenerationTiming)
```

- `initial_build_ms` is left at `0.0` by `build_maze` itself — it only runs the QC/repair fixpoint loop, not the initial `generate_maze` call. `maze-wasm::run_generate` is the only caller that also runs that stage; it times it with the same `now_ms()` clock and fills `timing.initial_build_ms` in after `build_maze` returns.
- `qc` is a tree: one `TimingNode` per stage that actually dispatched a rule (a stage nothing ever ran against is simply absent, not an empty node — see `stage_node`'s doc comment), each stage node's `children` are its own rules, each rule node's `children` are its checks (keyed by **check type id**, `Check::check_type_id()`, e.g. `"loop_length"` — the same string as `available_checks()`'s `CheckDescriptor.id`) plus, if dispatched, its one strategy (keyed by **strategy id**, `RepairStrategy::strategy_id()`, e.g. `"invalid_loop_random"` — the same string as `StrategyConfig.id`). A stage/rule node's own `entry.total_ms` is the sum of its children's; a stage node's `entry.calls` is the number of repair-dispatching iterations that stage actually ran (see `StageOutcome`'s doc comment: the final convergence pass that finds nothing does **not** increment it — a stage that converges on its very first pass reports `0`, not `1`); a rule node's `entry.calls` is always `0` (a pure time container, never itself "called"); a check/strategy leaf's `entry.calls` is its real dispatch count.
- Both `run_full`'s repair-loop pass (`run_repair_stages` → `Stage::run_repair` → `Stage::check_and_dispatch` → `RuleTrait::check_and_repair`) and its final unconditional report pass (`collect_final_report`, `RuleTrait::report_checks`) fold into the *same* per-stage/per-rule accumulator (`RuleTimingAcc`, keyed by rule id) before it's turned into a `TimingNode` — a rule's leaf entries reflect its total time across both passes, not just one.
- Two active instances of the same check type in different rules (GitHub issue #60) each get their own leaf entry under their own rule — aggregation by type only happens *within* one rule's own accumulator, not across rules.
- **Nested strategies (see "Nested strategies" above) are not timed separately.** `Rule::check_and_repair_typed` only wraps the top-level `strategy.apply` call in a timer; whatever time a parent strategy spends inside a nested `apply()` call it makes internally is included in the elapsed time attributed to the *parent's* `strategy_id` leaf, with no separate leaf for the nested strategy's own share — even when that same strategy is also independently registered elsewhere as a top-level strategy. A user reading the tree cannot distinguish a parent's own work from its nested delegate's.
- `QualityControlEngine::run_full` (timed, drives repair) and `run_check_only` (untimed — check-only callers, e.g. `build_analytics_snapshot`, have no generation to time and pass a throwaway one-off accumulator internally) are the two entry points — there is no separate `run`/`run_timed` method pair. Each `Rule`'s own `run_checks_typed`/`report_checks_typed`/`check_and_repair_typed` methods (exposed to `Stage` via the erased `RuleTrait` wrappers) take the `per_check`/`per_strategy` accumulator(s) and `now_ms` clock as parameters (injected so the same wasm/native-aware clock from `pipeline.rs` is reused) and wrap each `Check::repair_check`/`report_check`/`RepairStrategy::apply` call internally.
- `now_ms()` (`pipeline.rs`) is `pub`, not private, specifically so `maze-wasm::run_generate` can time the initial-build stage with the same clock.

`maze-wasm`'s `GenerationTimingDto`/`TimingNodeDto` (see `analytics-web.md`) is the serialized form, surfaced on `MazeSnapshot.timing` — `Some` only for snapshots from a full generation run (`run_generate`); `None` for analytics-only paths (post-edit, `compute_analytics`) that never call `build_maze`.

## Determinism Contract

A `build_maze` call is fully deterministic if:
1. The same graph structure is provided.
2. The same `seed` is used.
3. The same checks and strategies are registered in the same order.
4. The same `param_overrides` are provided.

`RandomEndpointsStrategy` sorts candidate lists before sampling, making results independent of node insertion order. `FarthestEndpointsStrategy` breaks distance ties by minimum `node_id` for determinism.

This also requires a platform-independent RNG: `crate::random::MazeRng` fixes `rand_xoshiro::Xoshiro256PlusPlus` directly rather than using `rand::rngs::SmallRng`, whose backing algorithm depends on `target_pointer_width` (different on native vs wasm32) and would otherwise make the same seed produce a different maze in-browser than in `cargo test`.
