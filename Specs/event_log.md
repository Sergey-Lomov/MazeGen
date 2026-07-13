# Debug Event Log

Infrastructure for narration-level generation debug logging (GitHub issue #122, part of epic #121). Replaces the old full-snapshot `debug_steps` model with a tree of scopes and events. This spec covers the core tree structure and RAII builder API, plus the Recursive Backtracker pilot instrumentation (issue #123). There is no WASM boundary yet (see issue #124).

Module: `maze-core/src/event_log/`.

## Core Concepts

### DebugEvent

```rust
pub trait DebugEvent {
    fn is_mutating(&self) -> bool;
}
```

Concrete event enums (one per instrumented algorithm/subsystem, e.g. Recursive Backtracker's events in #123) implement this to distinguish:
- **Mutating events** — change reconstructable state (edge added, node removed from frontier, ...). Replayed to reconstruct state at any point in the run.
- **Trace events** — narration only (RNG roll, param comparison, computed distribution, ...). Display-only, never replayed.

`event_log` itself defines no concrete event variants — those live with whatever instruments the algorithm.

### Arena representation

The tree is stored as a single flat `Vec<Node<E>>`, not nested owned `Vec<Node>` trees — chosen so it can later be exposed zero-copy across the WASM boundary (issue #124) without restructuring. Each node carries `parent` / `first_child` / `last_child` / `next_sibling` indices (`u32`, arena-relative) plus its payload (`Scope(name)` or `Event(E)`).

No direct indexing into the arena is exposed outside the owning type (`EventLog`/`DebugTape`) — all access goes through methods/iterators, per #124's encapsulation constraint (keeps a later AoS→SoA layout change internal).

**Linearization invariant:** a new node is always inserted as the last child of the current cursor. This means a node's arena index is always greater than its parent's and greater than every previously-inserted node in the same subtree — so the arena's insertion order (index 0..len) *is* DFS pre-order, and also the mutating-events emission order, by construction. No separate time index or explicit traversal (recursion/stack) is needed; recovering linear order is a single forward scan filtering by `is_mutating()`.

### EventLog — RAII builder

```rust
pub struct EventLog<E> { /* ... */ }
pub struct ScopeGuard<'a, E> { /* ... */ }
```

- `EventLog::enter(name)` opens a scope as the last child of the current cursor and returns a `ScopeGuard`.
- `EventLog::emit(event)` inserts an event as the last child of the current cursor directly (no nested scope).
- While a `ScopeGuard` is alive, it is the *only* way to `emit`/`enter` further — its own `emit`/`enter` methods delegate into the log. This is enforced by the borrow checker: `enter`/`emit` are not available on `EventLog` while a guard borrows it.
- `ScopeGuard::enter(name)` opens a nested scope, **consuming** the parent guard — only one guard is ever alive at a time. This exactly matches the target usage pattern: an algorithm opens sequential sub-scopes under one parent, each closed before the next opens (e.g. Recursive Backtracker's step → roll → compare chain in #123).
- Dropping a `ScopeGuard` restores the log's cursor to the scope that was current before `enter` was called — including when the drop happens during panic unwind, so the cursor is never left pointing at an orphaned scope after a panic.
- `EventLog::finish(self)` consumes the builder and returns a read-only `DebugTape<E>` — no further writes are possible after this, enforced at the type level.

Implementation note: `ScopeGuard::enter` needs to move its `log: &'a mut EventLog<E>` field out of `self`, but `self` implements `Drop` so ordinary field moves aren't allowed. It wraps `self` in `ManuallyDrop` (suppressing the old guard's destructor, which would otherwise stomp the cursor the nested `enter` just set) and reads `log` out via one `unsafe` `ptr::read` — the only `unsafe` in the module.

### DebugTape — read-only result

```rust
pub struct DebugTape<E> { /* ... */ }
```

- `iter()` — all events in DFS pre-order (= insertion order), flattened — scope structure is discarded.
- `mutating_events()` — mutating events only, in linear emission order, independent of tree nesting (requires `E: DebugEvent`).
- `root()` — a [`NodeView`] onto the root scope, the entry point for walking the actual tree shape.

### NodeView — tree structure access

```rust
pub enum NodePayload<'a, E> {
    Scope(&'a str),
    Event(&'a E),
}

pub struct NodeView<'a, E> { /* ... */ }
```

A handle onto one arena node — the structural counterpart to `iter()`'s flat list. No arena index is ever exposed to callers; `NodeView` is the only way to navigate:
- `payload()` — whether this node is a named scope or a leaf event, and its data.
- `parent()` — the enclosing scope, or `None` for the root.
- `children()` — this node's children in emission order (scopes and events interleaved as they were emitted).

This is what a future replay/UI consumer (#125) walks to render the tree (e.g. "step" containing a trace event followed by a "roll" sub-scope) — `iter()`/`mutating_events()` intentionally don't carry this information, since they exist purely for linear replay/inspection.

## Recursive Backtracker Instrumentation (#123)

Module: `maze-core/src/generation/recursive_backtracker.rs`.

Unlike the illustrative narration example in epic #121 (which describes `CustomVertexBased`'s `corridor_chance`/`branching` rolls), Recursive Backtracker is a plain stack-based DFS with no such params — the event set mirrors what the algorithm actually decides, not the epic's example verbatim.

```rust
pub enum RecursiveBacktrackerEvent {
    VertexSelected(NodeId),
    CandidatesComputed(Vec<NodeId>),
    DeadEnd,
    CandidateChosen(NodeId),
    EdgeAdded { from: NodeId, to: NodeId },
    VertexVisited(NodeId),
    VertexPopped(NodeId),
    VertexPushed(NodeId),
}
```

- **Mutating**: `EdgeAdded`, `VertexVisited`, `VertexPopped`, `VertexPushed` — these change reconstructable state.
- **Trace-only**: `VertexSelected`, `CandidatesComputed`, `DeadEnd`, `CandidateChosen` — narration, not replayed.

**Tree shape**: one `"step"` scope per stack-top iteration (one `while let Some(&current) = stack.last()` pass), containing, in emission order:
1. `VertexSelected` — vertex popped off the top of the stack this iteration.
2. `CandidatesComputed` — unvisited, connectable neighbors.
3. Either `DeadEnd` + `VertexPopped` (candidates empty), or `CandidateChosen`, optional `EdgeAdded` (skipped when the preset already connected the pair), `VertexVisited`, `VertexPushed`.

**Threading**: `generate` takes `event_log: Option<&mut EventLog<RecursiveBacktrackerEvent>>` — mirrors the existing `on_step: Option<&mut StepCallback>` pattern already used for the old snapshot debug hook. `None` skips every instrumentation branch (checked via `Option::as_deref_mut()` per iteration), so callers that don't want the tape pay no cost beyond the `Option` check. The dispatcher (`generation::dispatch`) passes `None` for now — wiring a real caller-supplied log through `generate_maze`/`generate_maze_steps` is left for the WASM boundary work (#124), since core-only unit tests call `generation::generate_recursive_backtracker` (re-exported from `generation::recursive_backtracker::generate`) directly with an `EventLog`.

**Not instrumented**: `preset_state`-driven edge suppression (silently skipping `try_add_bidirectional_edge` for already-preset-connected pairs) has no separate trace event — `EdgeAdded`'s absence for a given `CandidateChosen` already tells that story unambiguously.

### Testing approach

`maze-core/tests/generation/recursive_backtracker.rs` has exactly **one** test asserting an exact event sequence (`recursive_backtracker_single_step_emits_exact_event_sequence`, on a 1x2 field — start has a single forced neighbor, no RNG branching to account for). It pins down real payload values and emission order once, for a connecting (non-dead-end) step.

Every other event-log test asserts an **invariant**, not exact payloads, so they survive narration wording changes:
- mutating events (`EdgeAdded`) reconstruct the same edges the graph actually has,
- tree nesting only ever produces `"step"` scopes directly under root, each non-empty,
- `is_mutating()` agrees with the mutating/trace split for every emitted event,
- a `None` log doesn't change generation output (zero-cost opt-out actually holds),
- a dead end always emits `DeadEnd` followed by `VertexPopped`, with no `EdgeAdded`.

This split is deliberate policy for any future `EventLog` instrumentation (Wilson, Kruskal, custom algorithms, QC/repair) — see `CLAUDE.md`'s "Testing debug event logs" section. Don't add a second exact-sequence test per algorithm variant; one forced-path exact test plus invariant tests is the target shape.

## Out of Scope (#123)

- WASM boundary DTO / arena export (#124)
- Intermediate snapshots / checkpointing
- Web-side replay/UI
- Instrumenting Wilson, Kruskal, or custom algorithms
- QC/repair narration-level logging
