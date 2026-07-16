# Debug Event Log

Infrastructure for narration-level generation debug logging (GitHub issue #122, part of epic #121). Replaces the old full-snapshot `debug_steps` model with a tree of scopes and events. This spec covers the core tree structure and RAII builder API, the Recursive Backtracker pilot instrumentation (issue #123), and the WASM boundary's zero-copy binary transfer (issue #124).

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
- `ScopeGuard::enter(name)` opens a nested scope, **borrowing** the parent guard (`&mut self`) rather than consuming it — mirrors `EventLog::enter`'s own signature. Only one guard is ever alive at a time (the borrow checker enforces it: the child holds `&mut` on the parent guard, so the parent is unusable until the child drops). Once the child drops, the parent guard is directly usable again — this is what lets a caller reopen/resume a parent scope after a nested scope closes (issue #162), e.g. an algorithm emitting into a parent scope before, between, and after a sequence of sibling child scopes (Wilson's `"walk N"` > `"step M"` shape, issue #145).
- Dropping a `ScopeGuard` restores the log's cursor to the scope that was current before `enter` was called — including when the drop happens during panic unwind, so the cursor is never left pointing at an orphaned scope after a panic.
- `EventLog::finish(self)` consumes the builder and returns a read-only `DebugTape<E>` — no further writes are possible after this, enforced at the type level.

Implementation note: no `unsafe` anywhere in the module. `ScopeGuard::enter`/`enter_numbered` simply reborrow `self.log` and delegate to `EventLog::enter`/`enter_numbered` — no field needs to be moved out of a `Drop`-implementing type. Caveat: because `ScopeGuard` has a non-trivial `Drop`, NLL does not shorten a child guard's borrow to its last use — it lives until the child is actually dropped. A child opened inline in a loop body without its own enclosing block is still considered borrowed at the following statement, so emitting into the parent guard right after opening a child fails to borrow-check unless the child's `enter`/`emit` calls are wrapped in their own block (so the child drops before the parent is used again).

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
    EdgeAdded { from: NodeId, to: NodeId, bidirectional: bool },
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

**Threading**: `generate` takes `event_log: Option<&mut EventLog<RecursiveBacktrackerEvent>>` — mirrors the existing `on_step: Option<&mut StepCallback>` pattern already used for the old snapshot debug hook. `None` skips every instrumentation branch (checked via `Option::as_deref_mut()` per iteration), so callers that don't want the tape pay no cost beyond the `Option` check. The dispatcher (`generation::dispatch`) still passes `None` for RB and is unchanged — real wiring happens through a separate function, `generation::generate_maze_with_events` (see #124's "WASM wiring" section below), which bypasses `dispatch` deliberately rather than adding a concrete `EventLog<E>` type to `dispatch`'s shared signature.

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

## WASM Boundary: Zero-Copy Binary Transfer (#124)

Gets a `DebugTape<E>` across the WASM boundary without a naive recursive-JSON serialization pass (a non-trivial maze run can produce tens of thousands of events). Two flat buffers only — a fixed-stride node table and a single payload byte arena — both exposed to the web client via raw WASM linear memory (`ptr`/`len`), not `serde_wasm_bindgen`.

### Binary format

`DebugTape::encode(&self) -> EncodedTape` (`maze-core/src/event_log/mod.rs`) is the tape's canonical binary encoding — independent of WASM, so any future consumer (CLI, file, tests) can reuse it without a second encoder. `EncodedTape { node_table: Vec<u8>, payload: Vec<u8> }`.

**Node table** — flat array of fixed-size records, `NODE_RECORD_SIZE = 22` bytes each, written/read only via explicit little-endian byte access (`to_le_bytes`/`from_le_bytes`) — never `#[repr(C)]`/`unsafe` transmute, so alignment is a non-issue on both the Rust side and the JS `DataView` side:

```
parent:         u32   // offset  0, NO_NODE (u32::MAX) = no parent
first_child:    u32   // offset  4, NO_NODE = no children
next_sibling:   u32   // offset  8, NO_NODE = no next sibling
tag:            u16   // offset 12, TAG_SCOPE (0) or a stable event_type_id (>=1)
payload_offset: u32   // offset 14, offset into the payload byte arena
payload_len:    u32   // offset 18, length of the payload slice
```

**Payload byte arena** — a single `Vec<u8>` holding both scope names (UTF-8, deduplicated by the encoder — an implementation detail, not a separate format section) and event payloads. `tag == TAG_SCOPE` → the slice is a UTF-8 scope name. `tag == event_type_id` → the slice is that event variant's binary payload, encoded by `EncodeEventPayload::encode_payload`.

`EncodeEventPayload` (separate from `DebugEvent`, which stays purely semantic — `is_mutating()` only) is implemented per instrumented event enum:
```rust
pub trait EncodeEventPayload {
    fn type_id(&self) -> u16;
    fn encode_payload(&self, out: &mut Vec<u8>);
}
```
`type_id()` must return a stable, manually-assigned constant — never `mem::discriminant`/`#[repr(u16)]` on the Rust enum, since variant order/discriminant is not part of the wire format and must stay free to change without shifting already-encoded tapes. `RecursiveBacktrackerEvent`'s tags live in a `wire_tags` module in `recursive_backtracker.rs`. `0`/`TAG_SCOPE` is permanently reserved and must never be returned by any event's `type_id()`.

Encoding conventions used by `RecursiveBacktrackerEvent` (the only instrumented enum so far): a `NodeId` (`u64`) is 8 little-endian bytes; `EdgeAdded { from, to, bidirectional }` is two back-to-back `NodeId`s plus a 1-byte `bidirectional` flag (17 bytes) — added in GitHub issue #135 so replay consumers don't have to assume RB always double-adds an edge; `CandidatesComputed(Vec<NodeId>)` (the only variable-length variant) is a `u32` LE length prefix followed by that many `NodeId`s — the length lives *inside* the payload slice, not as another `NodeRecord`-level offset/len tier; `DeadEnd` (unit variant) is a 0-byte payload.

### WASM wiring

`generation::generate_maze_with_events` (`maze-core/src/generation/mod.rs`) bypasses `dispatch()` deliberately — `dispatch` is shared across all five generation algorithms and must not be tied to one concrete `EventLog<E>` type. It matches `config.algorithm` directly: for `RecursiveBacktracker` it builds a real `EventLog`, calls `recursive_backtracker::generate` with it, and encodes+returns the tape; every other algorithm returns `None` (not instrumented yet — at the time of #124, this meant every algorithm besides RB; Kruskal was added later, see #161 below). It also accepts a `collect_steps: bool` to optionally gather the legacy `GenerationStep` trace (`on_step`) alongside the event tree in the same pass, since `debug` and `debug_events` are independent flags on `GenerateConfig` and may both be set during the migration off the old snapshot tool.

`GenerateConfig.debug_events: bool` (`maze-runner/src/config.rs`) — independent of the existing `debug` flag, so both debug systems can be toggled separately while the web UI migrates off the old one.

`maze-wasm/src/runner.rs::run_generate` reads `config.debug_events`; when set, it calls `generate_maze_with_events`, encodes the resulting tape via `DebugTape::encode()`, and packs the two buffers into `GenerateResult` (`maze-wasm/src/result.rs`) — a `#[wasm_bindgen]` class replacing the plain `JsValue` `generate()` used to return directly:

```rust
#[wasm_bindgen]
pub struct GenerateResult { /* snapshot: JsValue, node_table: Option<Vec<u8>>, payload: Option<Vec<u8>> */ }
```
- `.snapshot()` — the same `MazeSnapshot` shape as before #124, serialized once and cloned (cheap `JsValue` handle clone, not a re-serialization) on each call.
- `.debugTapeNodeTable()` / `.debugTapePayload()` — `Option<js_sys::Uint8Array>`, built via `unsafe { js_sys::Uint8Array::view(...) }` directly over the owned `Vec<u8>` buffers living inside `GenerateResult`. This is a true zero-copy view into WASM linear memory, not a copy — it is invalidated ("detached buffer") by the next call into the WASM module (any `memory.grow`, including a subsequent `generate()`). Callers must read/copy the contents synchronously before making another WASM call.
- One entry point, not two: `generate()`'s signature/contract stays single (`Result<GenerateResult, JsValue>`) rather than adding a parallel `generate_with_debug_events()` — avoids two near-duplicate paths drifting apart over time. The non-debug path pays only the cost of two `None` fields.
- **`GenerateResult` must be `.free()`'d by the JS caller.** Like every `#[wasm_bindgen]` class, its Rust-side allocation (snapshot handle plus, when present, the `node_table`/`payload` buffers) is only released by an explicit `free()` call (or `using` — wasm-bindgen also emits `[Symbol.dispose]()`) — JS garbage collection does not reach into WASM linear memory. `mazeService.ts::generateMaze` calls `result.free()` in a `finally` block after extracting everything it needs; any future direct caller of `generate()` must do the same or leak wasm heap on every call.
- Encoding (`DebugTape::encode()`) happens **after** `initial_build_ms` is captured — it's a WASM-boundary transfer cost, not part of the generation algorithm, and must not inflate the per-stage timing breakdown (issue #56). This branch-selection-and-timing logic (`qc_experiment`/`debug_events`/`debug` dispatch, the timing window, calling `encode()` after it closes) lives in `run_initial_generation`, a helper `run_generate` delegates to — split out specifically so it's testable under plain `cargo test`: `run_generate` itself calls into `JsValue`/`serde_wasm_bindgen`, which panic outside a real WASM runtime and can't be exercised natively, but `run_initial_generation` touches neither and is covered by `maze-wasm/src/runner.rs`'s `run_initial_generation_tests`.

**Web side** (`maze-web/src/wasm/mazeService.ts`): `generateMaze()` calls `.snapshot()` and, if present, eagerly copies `debugTapeNodeTable()`/`debugTapePayload()` via `.slice()` into plain owned `Uint8Array`s (`DebugTape { nodeTable, payload }`) — this is the one point where the "read synchronously" constraint above is discharged; every consumer downstream of `generateMaze` gets safe-to-hold-onto buffers. Calls `result.free()` before returning. Returns `GenerateMazeResult { snapshot, debugTape }`.

### Out of Scope (#124)

- Web-side replay engine/UI consuming the decoded tape (#125+)
- Intermediate snapshots / checkpointing
- Instrumenting Wilson, Kruskal, or custom algorithms
- QC/repair narration-level logging

## Web Replay Engine (#125)

Module: `maze-web/src/debug/eventTape.ts`. Pure logic — no store or UI wiring (that's #126+); turns the two buffers from a `DebugTape` (see above) into "maze state at step N". `generateWithSeed` (`generateConfigBuilder.ts`) never sets `config.debug_events` — this module is exercised only via hand-built fixtures in its own unit tests, independent of a real WASM build.

### Two independent layers

- **Flat layer** (`nodeAt`, `mutatingRbEventsWithIndex`/`mutatingRbEvents`) — a linear forward scan over the node table by index, ignoring `parent`/`firstChild`/`nextSibling` entirely. This is what `applyRecursiveBacktracker` uses.
- **Tree layer** (`nodeView`, mirroring Rust's `NodeView`/`NodePayload`) — walks `parent`/`firstChild`/`nextSibling` to recover the actual scope/event nesting (a future narration UI's entry point, per #126+). Not used by `applyRecursiveBacktracker`.

Both layers read node records through the same `nodeAt(tape, index)` — decodes one fixed-stride (`NODE_RECORD_SIZE = 22`) record, converting the `NO_NODE` sentinel to `null`.

### Recursive Backtracker decoding

`decodeRecursiveBacktrackerEvent(tag, bytes)` decodes one RB event's binary payload into a discriminated union mirroring `RecursiveBacktrackerEvent`; `isMutatingRbEvent` mirrors `DebugEvent::is_mutating`'s split. Contract: only called with `tag >= 1` — callers filter out `TAG_SCOPE` first. Throws (never silently drops or returns `null`) on an unrecognized tag or a `payload_len` mismatch — for fixed-size variants the length must match exactly (8 bytes for single-`NodeId` variants, 16 for `EdgeAdded`, 0 for `DeadEnd`); for `CandidatesComputed` (variable-length) the length must equal `4 + count * 8`, where `count` is read from the payload's own length prefix. A malformed tape means a core/web build mismatch, which must surface immediately rather than silently produce a wrong reconstructed state.

`mutatingRbEventsWithIndex(tape, limit?, startIndex = 0)` is the flat-layer forward scan: skip `TAG_SCOPE` nodes, decode the rest, keep only mutating events, pairing each with the arena node-table index it was decoded from (`MutatingRbEventAt { event, nodeIndex }`). `mutatingRbEvents(tape, limit?, startIndex?)` is a thin wrapper returning just the events, for callers (mainly tests) that don't need the indices. The returned array's position is the `step` unit used everywhere below — but only when `startIndex` is 0; a non-zero `startIndex` returns a sequence whose *step* numbering is relative to whatever position the caller is tracking externally (see `applyRecursiveBacktracker`, the only real caller of a non-zero `startIndex`).

Both `startIndex` and `limit` bound the scan: it starts at arena index `startIndex` and stops once `limit` mutating events have been collected since then. This is what lets `applyRecursiveBacktracker` (below) avoid decoding either the already-known prefix (when resuming via `from`) or the tape's tail past `targetStep` — a real run can produce tens of thousands of events (see the WASM Boundary section above), so scrubbing forward through a large tape one step at a time must not pay the cost of decoding everything before or after the step actually needed.

Wire format constants (`TAG_SCOPE`, `NO_NODE`, `NODE_RECORD_SIZE`, and the RB wire tags `VERTEX_SELECTED=1` … `VERTEX_PUSHED=8`) are exported `const`s in `eventTape.ts` — a manual TS mirror of the Rust constants in `event_log/mod.rs` and `recursive_backtracker.rs`'s `wire_tags` module (no shared codegen; both sides must be updated together on a wire-format change). Tests and any hand-built fixture import these rather than hardcoding raw numbers.

### `step` semantics and `apply`

`targetStep` is the 0-based index, within `mutatingRbEvents`'s flat sequence, of the **last mutating event to apply** — `targetStep=0` means exactly one event (index 0) has been applied. Valid range: `[0, totalMutatingEvents)`. "Zero events applied" (the empty initial state) isn't expressed through a call — callers represent it as `{ edges: [] }` without calling `applyRecursiveBacktracker` at all.

`applyRecursiveBacktracker(tape, targetStep, from?)` → `{ edges: Edge[]; step: number; nodeIndex: number }` (`Edge = { from: bigint; to: bigint }`, `result.step === targetStep` always). `result.nodeIndex` is the arena node-table index of the mutating event at `targetStep` — passing the whole result back in as a later call's `from` (unmodified) is the documented resume contract.

Bounded on both ends: the node-table scan starts at `from.nodeIndex + 1` (or 0 without `from`) via `mutatingRbEventsWithIndex(tape, targetStep - (from?.step ?? -1), scanStart)`, and stops once enough new mutating events have been collected to reach `targetStep`. So neither the already-known prefix (when resuming via `from`) nor the tape's tail past `targetStep` is ever decoded — this is what makes a resumed call's cost independent of how large `targetStep` itself is, not just independent of the tape's total size. Only `EdgeAdded` events from the new (post-`from`) slice are folded into `edges`; `VertexVisited`/`VertexPushed`/`VertexPopped` are walked over (so step indexing lines up) but aren't accumulated into the output, since this minimal state shape carries no visited-set/frontier. A bidirectional `EdgeAdded` (the common case for RB, per its `bidirectional` field — GitHub issue #135) contributes both `{from, to}` and `{to, from}` to `edges`, so the reconstructed passage renders as two-way rather than defaulting to one-way.

An out-of-range `targetStep` is detected by the bounded scan coming up short (fewer new mutating events found than needed to reach `targetStep`), not by comparing against a separately-computed total — computing the true total would require an unbounded scan, defeating the point. A `from` that doesn't actually come from a previous call on the same tape (mismatched `nodeIndex`/`step` pair, or a `nodeIndex` past the end of the node table) is guarded against explicitly: `from.nodeIndex` must be in range and must point at an actual mutating event, checked with one extra record read before the bounded scan starts — otherwise a bogus `from` would resume scanning from a meaningless position and silently produce a wrong result instead of failing loudly.

`start`/`finish` are never part of Recursive Backtracker's own reconstructed state — RB doesn't emit them, they're static config outside this engine's scope. Since #147, `DebugMazeView` (`debugSelectors.ts`) does carry `start`/`finish`, but only ever populated by QC's own contribution (`StartSet`/`FinishSet` mutating events, see the `QcApplyResult` notes further down) — a generation-only tape (no QC source) still has both fields `null` throughout.

`NodeId` (`u64` in core) is read as `bigint` (`DataView.getBigUint64`), never narrowed to `number` inside this module — full precision preserved. Converting to `number` to join against `NodeDto.id` is left to whatever future consumer (#126+) needs that join.

### `from` — nearest-snapshot lookup entry point

`from?: { edges: Edge[]; step: number; nodeIndex: number }` lets a caller resume from an already-known state instead of always replaying from the start — the hook future checkpointing (a separate issue) will plug into without reshaping this API. Since no checkpointing exists yet, the only caller-visible behavior today is: no `from` → replay the flat sequence from arena index 0. The documented usage is to pass a previous `applyRecursiveBacktracker` call's result straight back in as the next call's `from`, unmodified — `nodeIndex` only means something as a pair with `step` from the same result.

- `from.edges` is never mutated — `applyRecursiveBacktracker` always returns a new array.
- `from.step` and `from.nodeIndex` are each validated to be non-negative integers, independently of each other and of `targetStep`.
- `from.step > targetStep` throws — resuming "backwards" past a resume point the caller already advanced beyond is a caller bug; going backward must call `applyRecursiveBacktracker(tape, targetStep)` without `from` (a full replay from scratch — the only correct path until checkpointing exists).
- `from.nodeIndex >= tape.nodeCount`, or `from.nodeIndex` pointing at a scope node or a non-mutating event, throws — this is the guard against a `from` that wasn't actually produced by a previous call on this tape (see above).
- `targetStep`/`from.step`/`from.nodeIndex` must all be integers (`Number.isInteger`), finite, and non-negative — a non-integer, `NaN`, or `Infinity` throws.

### Out of Scope (#125)

- Store integration (`mazeStore.ts`, `generateConfigBuilder.ts` wiring)
- Right-panel debug UI
- Intermediate snapshots / checkpointing (core-side) — added in #128, see below

## Store Wiring (#126)

Module: `maze-web/src/store/`. Replaces the old `debugSnapshot: GenerationStepsSnapshot | null` field (full per-step snapshot array) with `debugArena: DebugArenaHandle | null` (raw arena handle + `debugStep`, see `store.md`'s Debug section) — the store now persists only the raw tape and a step number; reconstructed maze state at that step is never stored, only derived on demand via `selectDebugMazeView` (see #125/#128/#139 above).

`showDebugFrontier` (the old debug-frontier highlight toggle, tied to `MazeTileRenderer`'s `activeNodes`/`current_src` fields) is dropped, not ported forward — the new replay engine has no live producer for "frontier" state (which nodes are currently reachable-but-unvisited mid-DFS), and reimplementing it against the arena/replay model was explicitly out of scope for this issue. `MazeTileRenderer.ts` itself was later deleted (dead code, zero call sites, found during #132's review) since nothing else depended on it either. Frontier highlighting was superseded by the interactive node/edge ref highlighting built in #130 (see below), which highlights on hover rather than showing a persistent frontier set — and later reintroduced as a persistent, non-hover highlight through the generic debug-value mechanism (#131, see below), which replays "frontier" against the arena/replay model this section's `debugArena`/`selectDebugMazeView` design was built for.

`generateConfigBuilder.ts`'s config-building logic (what triggers a debug-mode `generate` call) carried over unchanged in shape — it still decides `debug`/`debug_events` flags per `GenerateConfig` (see #124's WASM wiring above) — but now builds a `DebugArenaHandle` from the WASM response instead of a `GenerationStepsSnapshot`.

`GenerationDebugBar` (the pre-#130 debug UI) kept working unmodified against the new store shape, per this issue's scope — it was replaced by `DebugPanel`/`DebugEventTree` in #130, not by this issue.

## Intermediate Snapshot Checkpointing (#128)

Lets a replay consumer reconstruct state at a late arena node index without replaying every mutating event from the tape's start. Computed once, during generation, in the same pass that builds the event tree — not a separate replay pass afterward.

### `CheckpointLog` — a separate module, not a field on `EventLog`/`DebugTape`

Module: `maze-core/src/event_log/checkpoint.rs` (`pub mod checkpoint` under `event_log`, re-exported from `event_log::mod`). Deliberately independent of `EventLog<E>`/`DebugTape<E>`/`Node<E>` — those types have no notion of what a "snapshot" contains (that's algorithm-specific: for Recursive Backtracker, an edge list), so folding checkpoint storage into them would make `event_log` responsible for a concern it doesn't own. It lives in a file under `event_log/` purely because it mirrors `EncodedTape`'s POD-buffer transport mechanics (same WASM zero-copy story) — not because of a type dependency; nothing in `checkpoint.rs` references `Node<E>` or indexes into the arena.

```rust
pub struct CheckpointLog { /* ... */ }
pub struct EncodedCheckpoints { pub table: Vec<u8>, pub payload: Vec<u8> }
pub const CHECKPOINT_RECORD_SIZE: usize = 12; // 4 (node_index) + 4 (offset) + 4 (len)
```

- `CheckpointLog::push(&mut self, node_index: u32, bytes: &[u8])` — records one opaque snapshot payload tagged with the arena node index of the mutating event it reflects state up to and including. `node_index` is explicit, supplied by the caller — not inferred from any internal cursor, so there's no hidden coupling to `EventLog`'s cursor state.
- **Invariant**: `push` must be called with a strictly increasing `node_index` across calls (holds by construction for a well-behaved caller emitting checkpoints in generation order). `CheckpointLog::encode()` never sorts — a caller violating the invariant hits a `debug_assert!` rather than silently producing a checkpoint table whose binary-search precondition doesn't hold.
- `CheckpointLog::encode(&self) -> EncodedCheckpoints` — flat, fixed-stride table (`CHECKPOINT_RECORD_SIZE`-byte records: `node_index: u32, offset: u32, len: u32`, all little-endian) plus a single payload byte arena, mirroring `EncodedTape`'s two-buffer shape.

### `EventLog::emit` returns the inserted arena index

`EventLog::emit`/`ScopeGuard::emit` changed from returning `()` to returning `u32` — the arena index the event was inserted at. This is an opaque handle (not a way to index into arena data from outside — no `tape.nodes[i]` access is introduced), so it doesn't violate #124's encapsulation constraint. It exists so a caller like Recursive Backtracker can tag a checkpoint with the exact node index of the mutating event that triggered it, rather than reconstructing that index by parallel bookkeeping (fragile — easy to desync from the arena's actual growth on a future refactor).

### Recursive Backtracker wiring

`recursive_backtracker::generate` takes an additional `checkpoint_log: Option<&mut CheckpointLog>` parameter (same `Option<&mut T>` zero-cost-opt-out pattern as `on_step`/`event_log`). A private `CheckpointTracker` (defined in `recursive_backtracker.rs`, not exported) holds the running state:

- `edges: Vec<(NodeId, NodeId)>` — accumulated from every `EdgeAdded` emit (both directions when `bidirectional`), **excluding preset edges**. Preset edges are already in `graph` before `generate` runs (added by `build_preset_state`) and are never emitted as `EdgeAdded` — and the existing `applyRecursiveBacktracker` (web replay engine, #125) already doesn't reconstruct them when replaying from scratch (`edges: []` plus `EdgeAdded`-only accumulation). A snapshot must equal what a from-scratch replay to the same node index would produce, or resuming from a snapshot would silently diverge from a full replay — so the snapshot format deliberately matches this existing (pre-#128) reconstructable-state definition rather than "improving" it to include preset edges.
- `since_last_checkpoint: u32` counter, incremented **only** on the four mutating variants (`EdgeAdded`, `VertexVisited`, `VertexPopped`, `VertexPushed` — the same split `DebugEvent::is_mutating` already encodes), not on trace events.
- Every `CHECKPOINT_INTERVAL = 500` mutating events (a module-level constant in `recursive_backtracker.rs`, not user-facing config — picked empirically per the issue's pilot scope: frequent enough that a replay consumer never walks more than this many events from the nearest checkpoint, sparse enough that the table stays small), the tracker encodes the current `edges` list and calls `checkpoint_log.push(node_index, bytes)`, where `node_index` is the value `emit` returned for the mutating event that crossed the threshold.
- Encoding: `count: u32 LE` followed by that many `(from: u64 LE, to: u64 LE)` pairs — the same length-prefixed shape as `CandidatesComputed`'s wire format. No `EncodeEventPayload`-style trait for this — Recursive Backtracker is the only source, so the encoding is inlined in the tracker rather than introducing a second encoding abstraction.
- Trade-off: each checkpoint encodes the **entire** accumulated edge list, not a diff from the previous checkpoint — O(edges) bytes per checkpoint. Accepted deliberately: checkpoints are infrequent (every 500 mutating events) and the format needs to be self-sufficient per the "nearest snapshot, then apply forward" replay model this is built for. A delta encoding is a possible future optimization, out of scope here.

`generate_maze_with_events` (`maze-core/src/generation/mod.rs`) now returns a named struct, `EventedGenerationResult { tape, event_kind, checkpoints, debug_value_names }` (see #161 below for `tape`'s `EncodedTape` type and `event_kind`'s role), instead of a growing tuple — the function is public API `maze-wasm` calls into, so a third positional tuple element would have hurt readability at both call sites. `checkpoints: Option<CheckpointLog>` is `Some` exactly when `tape` is and the run was Recursive Backtracker (Kruskal produces a tape but no checkpoints yet — see #161); `None` for every other algorithm.

### WASM boundary

`GenerateResult` (`maze-wasm/src/result.rs`) gained a second, independent buffer pair: `snapshot_table: Option<Vec<u8>>` / `snapshot_payload: Option<Vec<u8>>`, attached via a chainable `with_checkpoints(self, table, payload) -> Self` builder method (composes with either `with_debug_tape`/`without_debug_tape`) rather than folding checkpoint parameters into the existing constructors — keeps the two transfer concerns (event tree vs. checkpoints) independently constructible. Exposed as `.debugSnapshotTable()` / `.debugSnapshotPayload()` — `Option<js_sys::Uint8Array>`, the same zero-copy `js_sys::Uint8Array::view` pattern and next-WASM-call invalidation caveat as `.debugTapeNodeTable()`/`.debugTapePayload()` (see #124's section above).

`maze-wasm/src/runner.rs`'s `run_initial_generation` encodes `checkpoints.encode()` alongside `tape.encode()` (same post-timing-window placement as the tape, so it doesn't inflate `initial_build_ms`) — this helper stays a plain tuple (unlike `EventedGenerationResult`) since it's a small internal function, not public API. As of #131 (see below) the tuple is `(Option<EncodedTape>, Option<EncodedCheckpoints>, Vec<String>, f64)` — tape first, checkpoints second, debug-value names third, `initial_build_ms` last.

### Web-side decoding (`maze-web/src/debug/eventTape.ts`)

A third buffer pair, parsed independently of the node table/payload:

```ts
export const CHECKPOINT_RECORD_SIZE = 12;
export interface ParsedCheckpoints { table, payload, tableView, checkpointCount }
export function parseCheckpoints(table: Uint8Array, payload: Uint8Array): ParsedCheckpoints
export interface Checkpoint { nodeIndex: number; edges: Edge[] }
export function checkpointAt(tape: ParsedCheckpoints, index: number): Checkpoint
```

`checkpointAt` decodes one fixed-stride record plus its `edges` payload (same `u32` length-prefix + `(u64, u64)` pairs shape as the Rust encoder). No node-index-keyed lookup is exposed — `applyRecursiveBacktracker` needs a step-keyed lookup instead (see below), and nothing else in the codebase consumes checkpoints by raw `nodeIndex`.

`mazeService.ts`'s `generateMaze()` copies `debugSnapshotTable()`/`debugSnapshotPayload()` into the returned `DebugTape`'s optional `snapshotTable`/`snapshotPayload` fields — but only when both are present; no empty-`Uint8Array` placeholders are created when the core recorded no checkpoints (e.g. a run shorter than `CHECKPOINT_INTERVAL`).

### Wiring into `applyRecursiveBacktracker` (store layer)

`applyRecursiveBacktracker`'s `targetStep`/`ApplyFrom.step` are indices into the flat mutating-event sequence, not arena node indices — so a checkpoint (keyed by `nodeIndex`) can't be handed to it as `from` directly. More functions in `eventTape.ts` bridge this:

```ts
export function resolveCheckpointFroms(tape: ParsedTape, checkpoints: ParsedCheckpoints): ApplyFrom[]
export function nearestCheckpointFromAtOrBefore(checkpointFroms: ApplyFrom[], targetStep: number): ApplyFrom | null
export interface DebugArenaMetadata { totalSteps: number; checkpointFroms: ApplyFrom[] }
export function resolveDebugArenaMetadata(tape: ParsedTape, checkpoints: ParsedCheckpoints): DebugArenaMetadata
```

- `resolveCheckpointFroms` translates every checkpoint's `nodeIndex` into its `step` via one forward scan over the tape, producing ready-to-use `ApplyFrom` values sorted by ascending `step`. Stops scanning once every checkpoint is resolved.
- `nearestCheckpointFromAtOrBefore` binary-searches that (small — one entry per `CHECKPOINT_INTERVAL` mutating events) array by `step`, the same key `targetStep`/`from` use.
- `resolveDebugArenaMetadata` combines `resolveCheckpointFroms`'s scan with computing `totalSteps` (previously `mutatingRbEvents(tape).length`, a separate full-tape decode) into a single forward pass — `generateConfigBuilder.ts` needs both values together, and a large run's node table used to get decoded twice to produce them. Semantically equivalent to calling both separately.

`DebugArenaHandle` (`maze-web/src/store/storeTypes.ts`) carries the resolved `checkpointFroms: ApplyFrom[]` (empty when the run produced no checkpoints). `generateConfigBuilder.ts` builds `totalSteps`/`checkpointFroms` together via `resolveDebugArenaMetadata`, passing an empty `ParsedCheckpoints` when `debugTape.snapshotTable`/`snapshotPayload` aren't both present. `selectDebugMazeView` (`maze-web/src/store/debugSelectors.ts`) looks up the nearest checkpoint at or before `debugStep` and passes it as `from` to `applyRecursiveBacktracker` — bounding replay cost to `CHECKPOINT_INTERVAL` mutating events from the checkpoint rather than to `debugStep` itself. A single-slot memo keyed on `(arena, debugStep)` identity (GitHub issue #139) skips replay entirely when called again for the same pair — e.g. when the store notifies subscribers for an unrelated field change (`hoveredDebugRef` on hover) while `debugStep` hasn't moved — and hands back the same `DebugMazeView` object, so downstream identity-keyed caches (`GenerationRenderer`'s geometry cache) see it as unchanged too.

### Out of Scope (#128)

- Tuning `CHECKPOINT_INTERVAL` beyond picking a reasonable initial default
- Delta/diff encoding between successive checkpoints (see the trade-off note above)
- Right-panel UI changes beyond the existing debug slider (no new controls added)

## Interactive Node/Edge/Cycle/Region Refs (#130)

Turns the debug event tree's plain-text narration into a tokenized `Token[]` so node/edge
mentions render as inline interactive bubbles — hovering one highlights the referenced element(s)
on the maze canvas. Web-only; no core changes (core stays typed-events-only, per #121's
typed-event principle — no narration text or presentation language crosses the WASM boundary).

### Web-side tokenization (`maze-web/src/components/DebugEventTree.tsx`)

`narrationTokensFor(event: RecursiveBacktrackerEvent): Token[]` replaces the old
`narrationFor(): string`. `Token` is a discriminated union:

```ts
type Token =
  | { kind: "text"; text: string }
  | { kind: "node"; id: bigint }
  | { kind: "edge"; from: bigint; to: bigint }
  | { kind: "cycle"; edges: [bigint, bigint][] }      // not emitted by RB — modeled for future QC/repair narration
  | { kind: "region"; nodes: bigint[] };               // same
```

`kind` values match `HoveredDebugRef.kind` (`maze-web/src/store/storeTypes.ts`) verbatim — a
bubble's hover payload is its own token passed straight through, no field renaming between the
two unions (`edge`/`cycle`'s `Token`/`HoveredDebugRef` shapes both carry `bidirectional` on the
edge entries, sourced from `RecursiveBacktrackerEvent::EdgeAdded.bidirectional`, so the bubble's
own arrow reflects the real edge directionality rather than assuming bidirectional). Narration
text around a bubble is wordless (e.g. "Edge added", not "Edge added: 3:18 -> 3:19") —
coordinates render only inside the bubble itself, formatted `x:y` (no parens/comma) via
`bubbleLabel`; an edge bubble's separator is ASCII `->` / `<->` by `bidirectional` (not a Unicode
arrow — those rendered poorly in the bubble's monospace font). Per explicit user decision, the
canvas highlight makes inline coordinates in prose redundant. The `debug.tree.*` paraglide
messages lost their `{x}`/`{y}`/`{fx}`/... coordinate interpolations accordingly.

Pilot scope mirrors #123 (Recursive Backtracker only): only `node`/`edge` tokens are actually
emitted; `cycle`/`region` exist in the type only, for QC/repair narration landing later.

### `DebugRefBubble` (`maze-web/src/components/DebugRefBubble.tsx`)

Hover-only — no click/modal, unlike `IssueBubble` (Analytics' equivalent for issue loop/region
highlighting). `onMouseEnter`/`onMouseLeave` write/clear `hoveredDebugRef` in the store;
`onClick` calls `stopPropagation()` only, so a click on the bubble doesn't bubble into the
enclosing row's own `onClick` (step-jump / expand-collapse toggle in `DebugEventTree.tsx`) — the
bubble itself does nothing on click.

### Store (`maze-web/src/store/storeTypes.ts`, `generationSlice.ts`)

```ts
type HoveredDebugRef =
  | { kind: "node"; id: bigint }
  | { kind: "edge"; from: bigint; to: bigint }
  | { kind: "cycle"; edges: [bigint, bigint][] }
  | { kind: "region"; nodes: bigint[] };

hoveredDebugRef: HoveredDebugRef | null;
setHoveredDebugRef: (ref: HoveredDebugRef | null) => void;
```

One discriminated union, not two independent arrays (edges/nodes) — a flat array pair can't
distinguish "one edge" from "a cycle of edges", or "a single node" from "a region's node list",
and loses which kind is currently hovered. Not persisted/serialized — `mazeStore` has no
`persist`/`devtools` middleware — and `bigint` ids match the representation `eventTape.ts`
already uses elsewhere in the debug layer, so this isn't a new precedent.

`setDebugMode(false)` resets `hoveredDebugRef` to `null` alongside `debugMode`/`debugStale` — the
tree unmounts when the panel closes, so a hover in progress at that moment would never receive a
matching `onMouseLeave` otherwise, leaving the canvas highlight stuck.

### Canvas highlighting (`maze-web/src/pixi/DebugRefHighlightOverlay.ts`)

Owned by `GenerationRenderer`, not `AnalyticsRenderer`/`IssueHighlightOverlay` — per
`maze-web/CLAUDE.md`'s feature-renderer ownership rule, no renderer instance is shared across
features. Uses a distinct accent color from Analytics' issue-highlight red (`0xff4444`):
`canvas.debug.refHighlight` / `base.debugRefHighlight` (`#44ccff`, cyan) in `colorUtils.ts` /
`palette.ts`, plus a matching DOM pair `ui.debug.refHighlight` (`theme.ts`) for the bubble itself.

Dispatches on `HoveredDebugRef.kind`, holding one instance each of two renderer classes shared
with Analytics (same class, separate instance — not a shared renderer instance, per the ownership
rule):

- `edge` / `cycle` → `EdgeHighlightRenderer` (`pixi/renderers/EdgeHighlightRenderer.ts`,
  pre-existing, used as-is) — one segment for `edge`, several for `cycle`'s `edges` list. Same
  primitive, explicit separate `switch` cases (not an implicit "edge-like" merge). Endpoint
  circles (via the class's own small `Graphics`) still mark each referenced vertex along the
  edge/cycle.
- `region` → `RegionHighlightRenderer` (`pixi/renderers/RegionHighlightRenderer.ts`, new —
  extracted from `IssueHighlightOverlay`'s former inline `drawRegion` method during this issue).
  Same API contract as `EdgeHighlightRenderer` (constructor takes a `Container`, owns a
  persistent `Graphics`, `render()`/`clear()`/`destroy()`) — `IssueHighlightOverlay` now holds its
  own `RegionHighlightRenderer` instance too, for its own region-highlight rendering, instead of
  its old private method. Geometry (`buildRegionGeometry`, cell list + perimeter segments) stays
  in `pixi/selectors/issueHighlightSelectors.ts`, unchanged — pure, no `Graphics` dependency; only
  the drawing half moved.
- `node` → also `RegionHighlightRenderer`, called with a single one-element `regionGroups` entry
  (`[[nodeId]]`) — highlights the referenced vertex's own maze tile (fill + perimeter) rather than
  a circle marker floating at its center, since a single node is just a region of size one and the
  same renderer already draws that shape correctly.

`GenerationRenderer.renderAll` calls `debugRefHighlight.render({ nodes: view.nodes, ref:
state.hoveredDebugRef, cfg })` only while `state.debugMode` is true (`debugRefHighlight.clear()`
otherwise) — `view.nodes` is the already-reconstructed debug-step node list (`debugView`, per
#125/#126), so highlighted positions always match what's currently drawn, including mid-replay.
`hoveredDebugRef` participates in the store-subscribe `dataChanged` diff alongside the existing
debug fields.

### Out of Scope (#130)

- QC/repair narration events (future epic scope, per #121 and #130 itself — landed by #171, see below)
- Reusing `DebugRefHighlightOverlay`/`RegionHighlightRenderer` for other features beyond this and
  Analytics' existing issue highlighting
- Instrumenting Wilson, Kruskal, or custom algorithms with node/edge refs

### Issue bubbles in QC narration (#171)

`QcEvent::CheckRan`'s "issue found" line and `IssuesMerged` now render an interactive bubble
instead of a plain-text issue-kind string — reusing this same `DebugRefBubble`/`hoveredDebugRef`/
`DebugRefHighlightOverlay` machinery (not Analytics' `IssueBubble`/`hoveredIssueLoopEdges` /
`setHoveredIssueRegionGroups`, which only render while the Analytics panel is open — the debug
panel needs the hover highlight independent of that).

`Token`/`HoveredDebugRef` both gain a fourth-and-final variant:

```ts
| {
    kind: "issue"; issueKind: string;
    target: { kind: "cycle"; edges: [bigint, bigint][] } | { kind: "region"; nodes: bigint[] } | null;
    reasons: string[];
  }
```

`issueKind` is the raw wire string (same as everywhere else in this module — never translated);
`target` is `null` for the 9 of 11 issue kinds with no structural payload (`IssuePayload::None`),
otherwise the flattened structural data from `CheckRan`'s per-check `IssuePayload` or
`IssuesMerged`'s merged-issue payload (`quality_control.md`'s "Trace events" section) — flattened
across every contributing check via `algorithmRegistry.ts`'s `issueHighlightTarget`, since a single
debug-tree bubble narrates one issue per event, unlike Analytics' `IssuesBlock`, which renders one
bubble per contributing check and so highlights each check's own cycles/regions independently.

`reasons` is one already-resolved display string per contributing check — built by
`algorithmRegistry.ts`'s `issueReasons`/`issueReasonFor` from `resolveIssueSourceLabel`
(`components/issueRegistry.ts`, the same per-check detail formatter Analytics' `IssueBubble` calls)
against that check's *type* id (resolved from its wire *instance* id — `CheckRan.check_id`/
`IssuesMerged.details`' keys — via `ScopeTitleLookup.checkTypeId`, a new lookup mirroring
`stageTitle`/`ruleTitle`, sourced from the live store's `rules[].checks[]` the same way
`IssueDto.source_check_types` is built for the analytics snapshot) and that check's own `details`
map (`CheckRan.issue.details` / `IssuesMerged.details[checkId]`, both carried on the wire — see
`quality_control.md`'s "Trace events" section). Resolved once per event, in `algorithmRegistry.ts`,
not deferred to the render layer — `DebugRefBubble` only ever renders already-resolved strings, no
`titleLookup` access of its own. Deduplicated (`issueReasons`) so two checks of the same type with
identical params/details don't repeat the same reason twice.

`bubbleLabel` resolves an `issue` token's own visible label from `resolveIssue(issueKind).label`
(`components/issueRegistry.ts`, the same registry `IssuesBlock`'s `IssueBubble` reads) instead of
formatting an id/coordinate — there is no id to format; this stays the generic issue-kind label
even for a merged issue with several distinct `reasons` (only the modal, not the inline label,
shows the per-check breakdown). `DebugRefBubble` opens a modal listing `reasons` on click — a
single line when there's exactly one, or a "Possible reasons:" (`debug.tree.qc.issue_reasons_header`)
header plus a list when there's more than one (only `IssuesMerged` with 2+ contributing checks
produces more than one) — clickable whenever `reasons.length > 0`; every other target kind stays
hover-only (`onClick` only calls `stopPropagation()`). Hovering an `issue` token with a `null`
`target` is a no-op (nothing to highlight) rather than clearing-and-resetting a highlight that was
never set.

`DebugRefHighlightOverlay` dispatches `ref.kind === "issue"` to the same `EdgeHighlightRenderer`/
`RegionHighlightRenderer` sub-renderers a standalone `cycle`/`region` ref uses, keyed off
`ref.target.kind` (or clears both when `target` is `null`) — no new rendering primitive.

**Follow-up fix, found while building this feature: `EdgeId` was narrated as a `NodeId`.**
`EdgeRemoveProposed`/`EdgeRemoved`/`EdgeRemoveDeclined`/`TeleportRemoveWithReverseProposed`/
`TeleportRemovedWithReverse`/`TeleportRemoveWithReverseDeclined` used to carry `MutationCommand`'s
own opaque `EdgeId` and narrate it as a `{kind: "node", id}` token — `bubbleLabel` then looked that
id up against `debugArena.nodes` (a `NodeId`-space list), crashing whenever the `EdgeId` exceeded
the maze's own node count (pre-existing bug, unrelated to the issue bubbles above; surfaced and
fixed in the same pass). Fixed by resolving `EdgeId → (from: NodeId, to: NodeId)` on the Rust side
— in `apply_commands`, off the still-intact graph immediately before the edge is removed (`None`
once removed), and in the strategy-scope `*Proposed` path, off the untouched graph before any
mutation — and changing these 6 `QcEvent` variants' wire shape from `{id: EdgeId}` to `{from, to}`
accordingly (see `quality_control.md`'s "Trace events" section). The web-side narration for all 6
now emits a `{kind: "edge", from, to, bidirectional: false}` token instead of `{kind: "node", id}`.
A resolution failure (stale id) means the event is skipped entirely, never a fabricated `(0, 0)`
pair — node id `0` is a real, valid id, so a fabricated pair would be indistinguishable from a
genuine edge.

## Generic Debug Values (#131)

Generic, named "debug values" mechanism: an algorithm declares arbitrary session-specific ID sets
(e.g. Recursive Backtracker's `"recursion_stack"` — vertices currently on the DFS/backtrack stack —
and `"visited"` — every vertex marked visited so far) that evolve over a run, get reconstructed by
replay alongside the maze graph, and are exposed in the web UI as auto-derived toggles with
persistent canvas highlighting. Replaces the `active_nodes`/`current_src` frontier overlay dropped
in #126 (see that section's updated note) — this time generically, not hardcoded per algorithm.
Pilot scope, matching #123's pilot algorithm: Recursive Backtracker's `"recursion_stack"`/`"visited"`
only; other algorithms and QC/repair debug values are out of scope.

Named `"recursion_stack"`, not `"frontier"` — in graph-traversal terminology, frontier usually
means unvisited-but-reachable candidate vertices (closer to this algorithm's own
`unvisited`/`CandidatesComputed`), not the recursion/backtrack stack itself, so that name would
have misrepresented what the set actually tracks.

### Derived from existing mutating events, not a dedicated wire event

The issue's original epic-level sketch proposed a dedicated `DebugValueChanged { name, op, item }`
event. Implemented differently: debug-value deltas are *derived* from the payload of RB's existing
mutating events (`VertexPushed`/`VertexPopped`) via a new trait, rather than emitting a second
event alongside them. A dedicated event would double the mutating-event count on every push/pop
(inflating the debug panel's step numbering — every DFS push/pop would cost two steps instead of
one) and duplicate the same `NodeId` already carried by `VertexPushed`/`VertexPopped`. Deriving
keeps the wire format completely unchanged (zero new bytes on the tape, no new wire tag) and
composes with the existing replay/checkpoint machinery without touching `DebugTape`'s encoding.

`DebugValueOp` (`Insert`/`Remove`) and `DebugValueDelta<Id>` (`maze-core/src/event_log/mod.rs`):

```rust
pub enum DebugValueOp { Insert, Remove }

pub trait DebugValueDelta<Id> {
    fn debug_value_deltas(&self) -> Vec<(&'static str, DebugValueOp, Id)> {
        Vec::new()
    }
}
```

Generic over `Id` (not hardcoded to `crate::ids::NodeId`) so `event_log` stays free of any
dependency on domain types — mirrors how `Node<E>`/`DebugTape<E>` are generic over the event type
itself. Default implementation returns no deltas; only algorithms that expose debug values need to
override it. `RecursiveBacktrackerEvent`'s impl (`maze-core/src/generation/recursive_backtracker.rs`):
`VertexPushed(id)` → `[("recursion_stack", Insert, id)]`, `VertexPopped(id)` → `[("recursion_stack", Remove, id)]`,
`VertexVisited(id)` → `[("visited", Insert, id)]` (monotonic — RB never unvisits a vertex, so this
is `Insert`-only, unlike `recursion_stack`), every other variant → empty. The `"recursion_stack"`/
`"visited"` names are `RECURSION_STACK`/`VISITED` constants referenced by both `debug_value_deltas()`
and the static declaration below, so the declared and emitted names can't drift apart.

### Static declaration, not scan-derived discovery

The web-side toggle list must not be computed by scanning which deltas a particular run happened to
emit (an earlier version of this mechanism did exactly that, in `resolveDebugArenaMetadata`) — a
trivial run that never triggers a `VertexPushed`/`VertexPopped` (e.g. a single-node field) would
then silently omit `"recursion_stack"` even though the algorithm still declares it. Instead, a
canonical function `recursive_backtracker::debug_value_names() -> &'static [(&'static str, DebugValueKind)]`
(returning `&[(RECURSION_STACK, Sequence), (VISITED, Region)]` — see "Semantic kind" below) is the
source of truth — a static property of the algorithm, not a per-run computation.

`generate_maze_with_events`'s `match config.algorithm` (`maze-core/src/generation/mod.rs`) calls
`recursive_backtracker::debug_value_names()` in the `RecursiveBacktracker` branch and carries the
result on `EventedGenerationResult::debug_value_names: &'static [(&'static str, DebugValueKind)]`
(empty slice for every other algorithm, which don't reach this branch at all). This `match` is the
*export* point for the web side, not the declaration point — instrumenting a future algorithm still
means touching two places (its own `impl DebugValueDelta`/`debug_value_names()`, and one line
here), but the RB-internal declaration itself can't silently diverge from what it actually emits,
since both read the same `RECURSION_STACK`/`VISITED` constants.

### WASM boundary: a plain `Vec<String>`, not a new binary buffer

`debug_value_names` is a handful of short static strings — nothing like the tens-of-thousands-of-events
scale that justifies `DebugTape`'s zero-copy binary encoding (see #124 above). It rides across the
WASM boundary as an ordinary `Vec<String>`, not a new flat buffer pair:

- `GenerateResult` (`maze-wasm/src/result.rs`) gains `debug_value_names: Vec<String>` and
  `debug_value_kinds: Vec<String>` fields — two *parallel* arrays (kind at the same index as its
  name), not one `Vec<(String, DebugValueKind)>`, since `DebugValueKind` itself doesn't cross the
  WASM boundary as an enum — `kind_wire_str` renders it `"region"`/`"sequence"`. Populated by
  `with_debug_tape`'s new fourth parameter (`Vec<(String, DebugValueKind)>`, unzipped into the two
  fields; empty for `without_debug_tape`) and exposed as
  `#[wasm_bindgen(js_name = debugValueNames)] pub fn debug_value_names(&self) -> Vec<String>` /
  `#[wasm_bindgen(js_name = debugValueKinds)] pub fn debug_value_kinds(&self) -> Vec<String>` — plain
  value returns (wasm-bindgen's standard `Vec<String>` marshaling), not the
  `unsafe { Uint8Array::view }` zero-copy pattern
  `debugTapeNodeTable`/`debugTapePayload`/`debugSnapshotTable`/`debugSnapshotPayload` use. No
  detachment caveat — safe to call more than once.
- `run_initial_generation` (`maze-wasm/src/runner.rs`) returns the name/kind pairs as the third
  element of its `(Option<EncodedTape>, Option<EncodedCheckpoints>, Vec<(String, DebugValueKind)>, f64)`
  tuple (collected from `EventedGenerationResult::debug_value_names` when `debug_events` is set and
  the algorithm is instrumented; empty otherwise), which `build_generate_result` threads into
  `GenerateResult::with_debug_tape`.
- `mazeService.ts`'s `generateMaze()` reads `result.debugValueNames()`/`result.debugValueKinds()` and
  zips them (`zipDebugValueNames`, asserting equal length) into `DebugValueDescriptor[]` —
  `DebugTape.debugValueNames` — alongside the existing eager copy of the node table/payload/checkpoint
  buffers.

### Checkpoint format extension

Per the issue's own framing ("debug-value sets are just more state that gets snapshotted and
replayed the same way as graph state"), intermediate snapshot checkpoints (#128) now carry
debug-value sets alongside the edge list — `CheckpointLog`/`CheckpointRecord`
(`maze-core/src/event_log/checkpoint.rs`) stay untouched (still opaque byte payloads keyed by arena
node index); only the payload *format* `CheckpointTracker` writes changes.

`CheckpointTracker` (`maze-core/src/generation/recursive_backtracker.rs`) gains a
`debug_values: BTreeMap<&'static str, Vec<NodeId>>` field alongside its existing `edges` — `Vec`,
not `BTreeSet`, because insertion order matters for `Sequence`-kind values (see "Semantic kind"
below); `BTreeMap` (not `HashMap`) purely for the map's own deterministic key iteration order, so
checkpoint payload encoding is reproducible. `record()`'s signature changed from taking an explicit
`edge_delta: Option<(NodeId, NodeId, bool)>` to taking the mutating event itself
(`event: &RecursiveBacktrackerEvent`) — it derives both the edge delta (from `EdgeAdded`) and the
debug-value deltas (from `event.debug_value_deltas()`) internally, folding each named list's
`Insert` (push if not already present) / `Remove` (find and remove by value) directly.

Extended checkpoint payload format: after the existing edge section (`u32` count + `(u64, u64)`
pairs), a new section — `u32` set count, then per set: `u32` name length + UTF-8 name bytes + `u32`
id count + that many `u64` ids, written in insertion order (not sorted). `maze-web/src/debug/eventTape.ts`'s
checkpoint decoder (`decodeCheckpointPayload`, replacing the narrower `decodeCheckpointEdges`)
parses both sections in one pass; `Checkpoint`/`ApplyFrom`/`ApplyResult` all gained a
`debugValues: Map<string, bigint[]>` field alongside `edges`. `applyRecursiveBacktracker` folds
`debugValueDeltasFor(event)` (the TS mirror of the Rust trait impl) into `debugValues` the same way
it already folds `EdgeAdded` into `edges` — both for the bounded forward scan and the
`from.step === targetStep` early return.

### Web-side wiring

`selectDebugMazeView` (`maze-web/src/store/debugSelectors.ts`) — `DebugMazeView` gained a
`debugValues: Map<string, number[]>` field (node ids as `number`, already joined against
`NodeDto.id`, converted from the replay engine's own `bigint`-keyed result the same way `edges` is;
`number[]`, not `Set<number>`, preserving order for `Sequence`-kind values).

`DebugArenaHandle` (`maze-web/src/store/storeTypes.ts`) gained `debugValueNames: DebugValueDescriptor[]`
(`{ name, kind }` pairs), sourced from the WASM response (`debugTape.debugValueNames`) when the
arena is built in `generateConfigBuilder.ts` — *not* computed by scanning the tape (see "Static
declaration" above).

`GenerationState` gained `debugValueToggles: Set<string>` (several names may be toggled on at once —
not a single active value) and action `toggleDebugValue(name)`. Reset to empty on `setDebugMode(false)`
(mirrors the existing `hoveredDebugRef` reset) and on every new `generate()` call (a fresh run may
expose a different debug-value name set than the previous one).

### UI: per-value toggle row

`DebugPanel.tsx` renders one toggle row per `debugArena.debugValueNames` entry (section hidden
entirely when the list is empty — e.g. any algorithm other than Recursive Backtracker). `ToggleRow`
(`maze-web/src/components/ToggleRow.tsx`) was lifted out of `AnalyticsFeature.tsx`, where it had
been a private local helper, into a shared component — the debug panel is now a second consumer,
so a third hand-rolled copy would have been worse than extracting the existing one.

Labels go through paraglide i18n, not the raw name — `debug.value.<name>` messages (pilot:
`debug.value.recursion_stack`) in `messages/en.json`/`messages/ru.json`. Since a runtime string can't be
turned into a message key automatically, `DebugPanel.tsx` keeps a small local
`DEBUG_VALUE_LABELS: Record<string, () => string>` map from name to message lookup, falling back to
the raw name for any debug value without a catalog entry yet (so an untranslated future debug value
still renders as a toggle instead of crashing).

### Semantic kind: `Region` vs `Sequence`

Not every debug value means the same thing. `"visited"` is an unordered set — its members have no
relationship to each other. `"recursion_stack"` is the actual DFS stack — insertion order *is* the
information (which vertex is on top, what the backtrack path looks like). Collapsing both into an
undifferentiated node set loses that distinction and renders them identically, which is misleading
for a stack.

`DebugValueKind` (`maze-core/src/event_log/mod.rs`) makes the distinction explicit — as of #145's
follow-up (see the Wilson section below) it has two further variants, `Map` and `Vertex`, each with
its own delta trait (`DebugMapDelta`/`DebugVertexDelta`) since neither fits `Insert`/`Remove` on a
single id:

```rust
pub enum DebugValueKind {
    Region,   // unordered set, independent members — e.g. "visited"
    Sequence, // ordered list, adjacent members connected — e.g. "recursion_stack"
    Map,      // key -> value pairs, overwrite-by-key — e.g. Wilson's "current_walk"
    Vertex,   // single reassignable slot — e.g. Wilson's "walk_start"/"walk_head"
}
```

`Region`/`Sequence` only affect *rendering*; `debug_value_deltas()` still reports plain
`Insert`/`Remove` on a single id regardless of which of the two it is.
`recursive_backtracker::debug_value_names()` returns `&[(&str, DebugValueKind)]` pairs instead of
bare names — `("recursion_stack", Sequence)`, `("visited", Region)` — so the kind is part of the
same static declaration the name itself comes from, not a separate lookup that could drift out of
sync. `Map`/`Vertex` follow the same "kind travels with the name in one static declaration" rule,
but are reported through their own traits, not `debug_value_deltas()` — see the Wilson section
below.

Because order now carries meaning, the storage backing debug-value sets changed from an unordered
collection to an order-preserving one on both sides:
- `CheckpointTracker::debug_values` (`maze-core/src/generation/recursive_backtracker.rs`):
  `BTreeMap<&'static str, Vec<NodeId>>`, not `BTreeSet<NodeId>`. `Insert` pushes (only if not
  already present — duplicates would break a `Sequence`'s edge-chain rendering), `Remove` finds
  and removes by value. Checkpoint payload encoding is unchanged (`id_count: u32` + that many
  `u64` ids) — only the *order* those ids are written in changed, from sorted to insertion order.
- `maze-web/src/debug/eventTape.ts`'s `DebugValues` type: `Map<string, bigint[]>`, not
  `Map<string, Set<bigint>>`. `applyRecursiveBacktracker`'s delta fold and
  `decodeCheckpointPayload`'s checkpoint decode both preserve insertion order the same way.
  `selectDebugMazeView`'s `DebugMazeView.debugValues: Map<string, number[]>` (bigint→number join)
  likewise.

Across the WASM boundary, `GenerateResult` (`maze-wasm/src/result.rs`) carries kind as a second
parallel `Vec<String>` — `debugValueKinds()` alongside the existing `debugValueNames()`, each
entry `"region"` or `"sequence"` at the same index as its name (`kind_wire_str`). A plain string,
not a numeric enum, matching how `debugValueNames` itself already crosses the boundary as plain
values rather than a packed buffer. `mazeService.ts`'s `generateMaze()` zips the two arrays into
`DebugValueDescriptor[]` (`{ name, kind }`), asserting equal length — a mismatch would mean the
two arrays fell out of sync on the Rust side, and failing loudly beats silently misaligning names
against kinds.

### Canvas highlighting: persistent, not hover-only, kind-dependent visual, one layer per name

Distinct from `DebugRefHighlightOverlay` (#130, hover-only, driven by `hoveredDebugRef`) — toggled
debug values stay highlighted continuously while their toggle is on, independent of mouse position.

Which low-level renderer draws a debug value depends on its `DebugValueKind`:
- `Region` — `RegionHighlightRenderer` (#130), fill only, no perimeter. Each id is passed as its
  own one-element group (`regionGroups: ids.map(id => [id])`, `skipPerimeter: true`) — an unordered
  debug value like `"visited"` is an arbitrary set of *disconnected* members, not a contiguous
  area, so `buildRegionGeometry`'s shared-boundary perimeter would draw a closed outline around
  every single cell; with cell walls already rendered underneath, that outline reads as extra wall
  lines and makes real walls harder to read. `RegionHighlightRenderer`'s `RegionHighlightData` gained
  an optional `skipPerimeter?: boolean` field (default `false`, preserving every other caller's
  original fill+perimeter behavior — `IssueHighlightOverlay`, `DebugRefHighlightOverlay`) for this.
- `Sequence` — `SequenceHighlightRenderer` (`maze-web/src/pixi/renderers/SequenceHighlightRenderer.ts`),
  a new low-level renderer that draws an *open chain of arrows* between consecutive ids in the
  list's order, plus a filled circle at each id — reusing `BaseGraphRenderer`'s `drawEdge` primitive
  (exported for this purpose) for the arrows, since a stack's *order* is the point. Not closed into
  a loop (no edge from the last id back to the first) — a DFS stack isn't a cycle. The node-circle
  markers were added after the arrow-only version read as disconnected floating line segments —
  same visual anchor role `BaseGraphRenderer`'s own interactive node markers serve for the
  graph/nav-graph overlays it draws, without pulling in that class's interactive/hoverable node
  machinery (unneeded here). Positions come from `getCellCenter(node.x, node.y, cfg)`, the same
  tessellation-geometry function `BaseGraphRenderer`'s own node/edge layout uses — cached internally
  keyed on `nodes`/`cfg` identity (mirroring `GenerationRenderer`'s own `geometryCache` pattern),
  since `nodes` is the whole-maze node list and stays referentially stable across debug steps
  within one session, so rebuilding the position map on every `render()` call (once per debug-step
  tick during scrubbing/autoplay) would be wasted O(total node count) work regardless of how small
  the sequence itself is.

Per explicit product direction, different debug values are expected to get independently
distinguishable colors — so `DebugValueHighlightOverlay`
(`maze-web/src/pixi/DebugValueHighlightOverlay.ts`) holds one renderer instance (either kind, picked
by `kindFor`) and one child `Container` *per debug-value name*, created lazily as names are toggled
on and kept (cleared, not destroyed) when toggled off, rather than rendering every active toggle's
ids through a single shared call. If a name's kind ever changed between renders (shouldn't happen —
it's a static per-run declaration — but guarded defensively), the stale-kind entry is destroyed and
rebuilt rather than fed data it can't render. `render()` takes both a `kindFor: (name: string) =>
DebugValueKind` and a `colorFor: (name: string) => number` callback; `GenerationRenderer` builds
`colorFor` from `buildDebugValuePalette(debugArena.debugValueNames.length)`
(`maze-web/src/pixi/colorUtils.ts`) indexed by each name's position in the declared name list — a
small set of calm, analogous hues (blue/teal/violet, lower saturation than the full-spectrum
`buildPalette` used for e.g. connectivity regions), varied by lightness across passes, so
simultaneously-toggled debug values read as related shades rather than clashing unrelated colors.
No dedicated `debugValueHighlight` color token — the palette assigns a distinct shade to every
declared debug value automatically, including future ones, without a catalog entry. `kindFor` is
built from the same `debugArena.debugValueNames` list, keyed by name. Both the palette and the
name→color/kind lookup maps are cached on `GenerationRenderer` keyed on `debugArena.debugValueNames`
array identity — that list is stable for a whole debug session (only changes on a fresh
`generate()`), so rebuilding it every `renderAll()` call would be wasted work on every debug-step
tick, mirroring the same identity-cache pattern `geometryCache` already uses for walls/closed-cells.

Owned by `GenerationRenderer`, per `maze-web/CLAUDE.md`'s feature-renderer ownership rule — its own
`Container`/instance, added in the constructor alongside `debugRefHighlightContainer`/
`debugRefHighlight`. `debugValueToggles` participates in `subscribe()`'s `dataChanged` diff.
`renderAll()` gates rendering on `state.debugMode && state.debugValueToggles.size > 0` (mirroring
the `debugRefHighlight` branch immediately above it), reading `debugValues` via
`selectDebugMazeView(state.debugArena, state.debugStep)` — the same memoized selector (#125/#139)
`debugRefHighlight`'s `view.nodes` already comes from, so no extra replay cost.

### Replay-side O(1) membership check

`applyRecursiveBacktracker` (`maze-web/src/debug/eventTape.ts`) folds each `debugValueDeltasFor`
delta into a `bigint[]` per name, same as the Rust side's `Vec<NodeId>`. A naive `Array.includes`/
`Array.indexOf` per delta would make this loop O(n²) over a run for a monotonically-growing
`Region` value like `"visited"` (one insert per node, never removed) — and unlike the Rust-side
`CheckpointTracker`, which only runs once at generation time, this replay function runs on *every*
debug-step change (slider drag, autoplay tick), so the cost is repaid on every UI interaction, not
just once. Fixed the same way as `CheckpointTracker::record`'s `DebugValueList` (see above): a
`Map<string, Set<bigint>>` membership mirror, built fresh from the current `bigint[]` lists at the
start of each `applyRecursiveBacktracker` call and discarded once it returns — kept internal rather
than carried in `ApplyFrom`/`DebugValues` itself, so the public `bigint[]`/`number[]` shape every
consumer (store selectors, render overlays) depends on doesn't change. `Remove` still does an O(n)
`Array.indexOf`+`splice` (no reverse id→position index) — acceptable because it's only exercised by
`Sequence` values like `"recursion_stack"`, bounded by DFS stack depth rather than total node count,
mirroring the same asymmetric tradeoff made on the Rust side.

### Out of Scope (#131)

- Other algorithms' debug values (Wilson, Kruskal, custom)
- QC/repair debug values
- User-configurable per-value colors (colors are auto-assigned from the shared palette by name
  position; a future issue may let users override them individually)
- Debug value kinds beyond `Region`/`Sequence` (e.g. a weighted/scored value, a tree) — not needed
  by any currently-instrumented algorithm

## Generalizing `EventedGenerationResult` (#161)

Kruskal (#146) has its own `KruskalEvent` (`DebugEvent`/`EncodeEventPayload` impls, `wire_tags` module,
`kruskal::generate(..., event_log: Option<&mut EventLog<KruskalEvent>>)`) — a second concrete event
type that needed to flow through `EventedGenerationResult` (`maze-core/src/generation/mod.rs`)
alongside Recursive Backtracker's `RecursiveBacktrackerEvent`, without hardcoding either into the
struct's type.

### Type erasure moves into `generate_maze_with_events`

`DebugTape<E>::encode() -> EncodedTape` (see #124 above) already produces a fully non-generic
`EncodedTape { node_table: Vec<u8>, payload: Vec<u8> }` for any `E: DebugEvent + EncodeEventPayload`.
Previously this `.encode()` call happened one layer up, in `maze-wasm/src/runner.rs::run_initial_generation`
— meaning `EventedGenerationResult.tape` itself still had to be `Option<DebugTape<RecursiveBacktrackerEvent>>`,
baking in one concrete event type. The fix moves `.encode()` inside `generate_maze_with_events`
itself, once per algorithm arm: `RecursiveBacktracker` and `KruskalAlgorithm` (the two instrumented
algorithms) each build their own concrete `EventLog<E>`, call the algorithm's `generate`, `.finish()`
the log, and `.encode()` it immediately, before it can leave the function. `EventedGenerationResult.tape`
is now `Option<EncodedTape>` — the concrete `E` never has to appear in the shared struct at all, so
adding a third instrumented algorithm (Wilson, a custom strategy) means adding a new `match` arm, not
touching the struct's fields.

### `EventedEventKind` — a tag, not a re-derivation

Once `tape` is type-erased, a downstream consumer that only understands some event kinds (so far:
the web replay engine, `maze-web/src/debug/eventTape.ts`, which only decodes Recursive Backtracker's
wire tags — Kruskal's `wire_tags` module has no web-side counterpart yet) needs to know *whose* tape
it received without re-deriving that from the generation algorithm. `event_log::EventedEventKind`
(`maze-core/src/event_log/mod.rs`) is a small non-generic enum with one variant per **instrumented**
algorithm (`RecursiveBacktracker`, `Kruskal` — not one variant per `GenerationAlgorithm` variant, since
most aren't instrumented at all):

```rust
pub enum EventedEventKind {
    RecursiveBacktracker,
    Kruskal,
}
```

`EventedGenerationResult` gains `pub event_kind: Option<EventedEventKind>` — `Some` exactly when
`tape` is `Some`, tagging which concrete event enum it was encoded from. This is deliberately data
carried on the result, not a second match on `config.algorithm` that a caller would have to keep in
sync by hand: `generate_maze_with_events` is the *only* place that decides which algorithms are
instrumented, and every other consumer reads `event_kind` off the result instead of re-implementing
that decision.

### WASM boundary gates on `event_kind`, not on the algorithm

`maze-wasm/src/runner.rs::run_initial_generation` must not forward a tape to the web replay engine
for an event kind it can't decode — that would either crash or silently misinterpret the bytes as
the wrong algorithm's. The gate is a small `is_web_decodable(kind: Option<EventedEventKind>) -> bool`
function — as of #146 (see below), `matches!(kind, Some(EventedEventKind::RecursiveBacktracker) |
Some(EventedEventKind::Kruskal))` — called right after `generate_maze_with_events` returns: when the
result's `event_kind` isn't web-decodable, `tape`/`checkpoints`/`debug_value_names` are all discarded
(`None`/`None`/empty) before returning. Gating on the tag rather than re-matching on
`gen_config.algorithm` means this can't drift out of sync with which algorithms get instrumented
next — extending `is_web_decodable`'s `matches!` is the one place a future algorithm's web decoder
needs to touch to start forwarding that kind's tape across the boundary. `web/debugMode` is
independent of the selected generation algorithm (`generateConfigBuilder.ts`), so without this gate,
enabling debug mode while an undecodable algorithm is selected would leak undecodable bytes to the
web decoder.

### Kruskal checkpoints/debug values: deferred, not wired up

Kruskal's arm in `generate_maze_with_events` returns `checkpoints: None` and `debug_value_names: &[]`
— not extended to match Recursive Backtracker's checkpointing (#128) or debug-value declarations
(#131); see #146 below for what *is* covered (event instrumentation, DSU-groups replay). This still
holds after #146 landed. `EventedGenerationResult`'s `checkpoints`/`debug_value_names` parity
documentation ("`Some`/non-empty exactly when `tape` is `Some`") no longer holds universally across
every instrumented algorithm — it holds per-algorithm-arm, and Kruskal's arm simply always supplies
`None`/empty for those two fields regardless of `tape`.

### Out of Scope (#161)

- Kruskal checkpointing (#128-style) or debug value declarations (#131-style) — see #146 for what
  Kruskal instrumentation does cover
- Instrumenting Wilson or custom algorithms

## Kruskal Instrumentation (#146)

Module: `maze-core/src/generation/kruskal.rs`. Second `EventLog` instrumentation after the Recursive
Backtracker pilot (#123) — validates that the event-tree infrastructure generalizes past a single
algorithm, and (unlike #123's initial scope) ships an end-to-end web decoder/narration/canvas
visualization in the same issue, since #161's type-erasure work removed the architectural blocker
that would otherwise have forced deferring the web half to a follow-up.

Kruskal's single per-iteration decision is a union-find lookup on a shuffled candidate-edge list —
a fundamentally different shape from Recursive Backtracker's stack-driven DFS, so the event set
mirrors that instead of reusing RB's vertex-centric vocabulary:

```rust
pub enum KruskalEvent {
    EdgesShuffled(Vec<(NodeId, NodeId)>),
    EdgeSelected { from: NodeId, to: NodeId },
    RootsCompared { from: NodeId, to: NodeId, root_of_from: NodeId, root_of_to: NodeId },
    EdgeRejected,
    EdgeAdded { from: NodeId, to: NodeId, bidirectional: bool },
    SetsMerged { root_a: NodeId, root_b: NodeId },
    PresetUnionsApplied(Vec<(NodeId, NodeId)>),
}
```

- **Mutating**: `EdgeAdded`, `SetsMerged` — these change reconstructable state (the spanning-tree
  edge set and the DSU's group structure).
- **Trace-only**: everything else.

**Tree shape**: one `"edge N"` scope per iteration of the main `for (a, b) in edges` loop (numbered
via `EventLog::enter_numbered("edge")`, mirroring RB's `"step N"` — see #133), containing, in
emission order:
1. `EdgeSelected` — the candidate edge this iteration is deciding on.
2. `RootsCompared` — the union-find roots looked up for `from`/`to`. Carries `from`/`to` again
   (duplicating `EdgeSelected`'s pair) rather than requiring a narration consumer to remember the
   preceding sibling event — self-sufficient payload, reads as "root of `from` is `root_of_from`,
   root of `to` is `root_of_to`" off one event.
3. Either `EdgeRejected` (`root_of_from == root_of_to` — the edge would create a cycle), or
   `EdgeAdded` followed by `SetsMerged` (roots differ — the edge is added and the two sets merge).

Before the main loop, if any preset connections exist, one `PresetUnionsApplied(pairs)` event is
emitted directly under the root scope (see "DSU-groups replay" below for why).

**Not carried on the wire**: `EdgeRejected`'s `from`/`to` (redundant with the immediately-preceding
`RootsCompared`'s — see that variant's Rust doc comment) and `SetsMerged`'s resulting new root
(`KruskalEvent::merged_root(root_a, root_b) -> NodeId` computes it as `min(root_a, root_b)`,
mirroring `Dsu::union_by_min`'s own tie-breaking rule, so core and every replay consumer derive it
identically instead of risking a third, independently-computed copy drifting out of sync — see that
method's doc comment for the non-obvious invariant it depends on: `kruskal::generate`'s dense
`node_index` must be built by sorting `NodeId`s, or `min` on `NodeId`s stops agreeing with
`Dsu::union_by_min`'s index-based comparison).

**Threading**: `kruskal::generate(..., event_log: Option<&mut EventLog<KruskalEvent>>)` — the same
`Option<&mut T>` zero-cost-opt-out pattern as RB's `event_log`/`on_step`. `generate_maze_with_events`
(`maze-core/src/generation/mod.rs`) has a `KruskalAlgorithm` arm building a real `EventLog`, calling
`kruskal::generate`, and tagging the result `EventedEventKind::Kruskal` (see #161 above) —
`checkpoints`/`debug_value_names` are always `None`/empty for this arm (deferred, not in scope here).

### Wire encoding

Wire tags (`kruskal.rs`'s `wire_tags` module): `EDGES_SHUFFLED=1`, `ROOTS_COMPARED=2`,
`EDGE_REJECTED=3`, `EDGE_ADDED=4`, `SETS_MERGED=5`, `PRESET_UNIONS_APPLIED=6`, `EDGE_SELECTED=7` —
manually assigned per #124's convention, `0`/`TAG_SCOPE` reserved.

`NodeId` (`u64`) is 8 little-endian bytes per id. `EdgeSelected`/`SetsMerged` are two back-to-back
`NodeId`s (16 bytes). `RootsCompared` is four back-to-back `NodeId`s, in order `from, to,
root_of_from, root_of_to` (32 bytes) — this exact field order is the one thing
`kruskal_event_payload_round_trips_for_every_variant` (`maze-core/tests/generation/kruskal.rs`)
exists specifically to pin down, since a byte-offset/field-order mistake here silently produces
wrong narration rather than a crash (this happened once during development — a wire-tag-uniqueness
test alone did not catch it, only a byte-level round-trip test did). `EdgeAdded` is two back-to-back
`NodeId`s plus a 1-byte `bidirectional` flag (17 bytes). `EdgeRejected` carries no payload (0
bytes). `EdgesShuffled`/`PresetUnionsApplied` (the variable-length variants) are a `u32` LE length
prefix followed by that many `(NodeId, NodeId)` pairs.

### `PresetUnionsApplied` — seeding replay's initial DSU state

Preset-connected node pairs are pre-unioned into the union-find structure before the main edge loop
starts (`kruskal::generate`'s pre-union step, mirroring `preset_connected` handling elsewhere in
generation) — but those unions happen before any event-log scope opens, so there is no corresponding
per-pair `SetsMerged` a replay consumer could fold in to reconstruct the same starting state. Without
`PresetUnionsApplied`, a from-scratch web replay would show every preset-connected node as its own
singleton DSU group at step 0, when in reality they're already merged. Emitted once, as a single
event directly under the root scope (before the first `"edge N"` scope) — a `Vec<(NodeId, NodeId)>`
of the preset-connected pairs, analogous to `EdgesShuffled`'s shape. Not emitted at all (not even
with an empty `pairs` list) when there are no preset connections, so a replay consumer doesn't have
to special-case "empty" vs. "absent". Trace-only (`is_mutating()` is `false`) — it seeds replay's
initial state rather than describing a step-by-step mutation.

### Web-side DSU-groups replay

Unlike Recursive Backtracker's named debug values (`"recursion_stack"`/`"visited"`, #131 — a fixed,
statically-declared set of named id lists), Kruskal's interesting algorithm state is its union-find
group structure: a *dynamic* number of groups that merge over the run, with no natural per-group
name (a group's identity — its root — changes on every merge that involves it). This doesn't fit
`DebugValueDelta`'s `Insert`/`Remove`-on-a-named-set model, so it isn't modeled as a debug value at
all — instead, `maze-web/src/debug/eventTape.ts` provides a parallel, Kruskal-specific replay path:

- `KruskalDsu` — a minimal union-find over `bigint` ids (path compression + union-by-min), operating
  directly on `NodeId`s rather than dense indices (unlike core's `Dsu`, the web side never builds
  core's dense-index mapping). Its `union`'s tie-break (`min(a, b)`) must stay in sync with core's
  `Dsu::union_by_min` for a replayed root to match what `RootsCompared`/`SetsMerged` events actually
  carried.
- `applyKruskal(tape, targetStep) -> { edges, dsuGroups, step, nodeIndex }` — Kruskal's counterpart
  to `applyRecursiveBacktracker`, simplified: no `debugValues` output (Kruskal declares none) and no
  `from`-based resume (Kruskal produces no checkpoints, #128 is RB-only) — every call replays from
  the tape's start, seeding `KruskalDsu` from `findPresetUnions(tape)` (a linear scan locating the
  single `PresetUnionsApplied` event, if any, which always precedes the first `"edge N"` scope) then
  folding in every `SetsMerged` up to `targetStep`. `dsuGroups: Map<bigint, bigint>` maps every id
  the replay has seen to its current root — two ids sharing a value are in the same connected
  component of the spanning tree built so far.
- `selectDebugMazeView` (`maze-web/src/store/debugSelectors.ts`) dispatches on `arena.algorithmKind`
  between `applyRecursiveBacktracker` (with checkpoint-resume) and `applyKruskal` (always
  from-scratch); `DebugMazeView.dsuGroups: Map<number, number> | null` carries the joined
  (`NodeDto.id`-space) result, `null` for Recursive Backtracker.

### Narration (`DebugEventTree.tsx`)

`kruskalNarrationTokensFor` renders, per event: `EdgeSelected` — "Edge selected: A ↔ B";
`RootsCompared` — "Root of A = X, root of B = Y. Roots equal/different." (the same-root/different-root
outcome is spelled out inline, not left implicit in whether an `EdgeAdded` or `EdgeRejected` follows
— per explicit user feedback during development, narration must state the comparison's outcome in
words); `EdgeRejected` — "Edge rejected" (the reason was already stated by the immediately-preceding
`RootsCompared` row, so this doesn't repeat it); `EdgeAdded` — "Edge added: A ↔ B"; `SetsMerged` —
"Sets X and Y merged. New root: Z" (`Z` via `kruskalMergedRoot`, the TS mirror of
`KruskalEvent::merged_root`); `PresetUnionsApplied` — "N preset connection(s) pre-merged". `"edge N"`
scope rows render as "Edge N" (mirroring RB's "Step N").

### Canvas visualization: `KruskalDsuHighlightOverlay`

A new toggle, `showKruskalDsuGroups` (`GenerationState`, action `toggleKruskalDsuGroups`) —
independent of `debugValueToggles` (RB's named-set toggles): DSU groups are the algorithm's core
state, not a named/user-declared value, so there's one on/off switch rather than one toggle per
group. Only shown in `DebugPanel.tsx` when `debugArena.algorithmKind === "kruskal"`; reset to `false`
on `setDebugMode(false)` and on every fresh `generate()`, mirroring `debugValueToggles`'s reset
discipline.

`KruskalDsuHighlightOverlay` (`maze-web/src/pixi/`, owned by `GenerationRenderer` per the
feature-renderer ownership rule in `maze-web/CLAUDE.md`) renders every current non-singleton DSU
group at once — singleton groups (a node not yet merged into anything) are filtered out, since
highlighting every isolated cell individually would paint almost the entire field on the first
replay step and read as noise rather than signal. Draws through `RegionHighlightRenderer` with
`skipPerimeter: true` (fill only, no cell-outline stroke — a plain `RegionHighlightRenderer` call
would otherwise draw a closed perimeter around every single cell, which reads as extra wall lines
once real walls are rendered underneath). Since group membership and count change on every replay
step (a merge reduces the group count by one), there's no stable per-group identity to key a
persistent per-group layer by — the overlay holds a pool of `RegionHighlightRenderer` instances
(one per currently-drawn group) resized to fit each render, resized down (destroying the spares) or
up as needed.

**Color stability**: colored by `hash(root) % PALETTE.length` into a fixed-size (64-entry)
precomputed palette (`buildPalette`, the same full-spectrum palette connectivity-component overlays
use elsewhere) — not by the group's position in that render's `Map` iteration order. A group's root
id only changes when that exact group merges with another (`union_by_min` always keeps the smaller
of the two roots), so as long as a group doesn't merge, hashing its root keeps its color stable
across replay steps. An earlier implementation assigned colors by array position after rebuilding
the palette every render; since `Map` iteration order isn't tied to group identity, an unrelated
group merging elsewhere could shift every other group's position and flip its color even though
that group itself hadn't changed — this was caught via manual browser testing, not a unit test at
the time. The grouping/coloring logic (`groupNonSingletonsByRoot`, `colorForRoot`) was subsequently
pulled out of the class into standalone exported pure functions specifically so this regression
class is now covered by unit tests (`maze-web/src/test/KruskalDsuHighlightOverlay.test.ts`) instead
of relying on manual browser testing to catch it again.

### Out of Scope (#146)

- Kruskal checkpointing (#128-style) or debug value declarations (#131-style) — see #161's section
  above
- Instrumenting custom algorithms
- A generalized replacement for `DebugValueDelta` that could express dynamic/unnamed group
  structures like Kruskal's DSU groups through the same mechanism RB's named values use — DSU-groups
  replay is a parallel, Kruskal-specific path instead (see above)

## Wilson Instrumentation (#145)

Module: `maze-core/src/generation/wilson.rs`. Third `EventLog` instrumentation, after Recursive
Backtracker (#123) and Kruskal (#146) — ships end-to-end (core events, web decoder/apply/narration,
canvas visualization) in the same issue, per #146's precedent.

Wilson's decision shape is a two-level loop — an outer "pick an unvisited node and loop-erased
random-walk from it" iteration, and an inner per-step random walk that can erase its own loops (by
overwriting an already-recorded step) before committing the found path into the maze — so the event
set mirrors both levels, unlike Kruskal's single-level per-edge decision:

```rust
pub enum WilsonEvent {
    StartVisited(NodeId),
    WalkStartPicked(NodeId),
    StepTaken { from: NodeId, to: NodeId },
    LoopErased { node: NodeId },
    WalkDeadEnd,
    EdgeAdded { from: NodeId, to: NodeId, bidirectional: bool },
    NodeVisited(NodeId),
}
```

- **Mutating**: `StartVisited`, `WalkStartPicked`, `StepTaken`, `LoopErased`, `EdgeAdded`,
  `NodeVisited`. The first three don't touch the graph, but they change the walk's `next` map — the
  reconstructable state the `"current_walk"` debug value (see below) needs to redraw the
  in-progress walk — so they're mutating for that reason, not because they mutate the graph.
- **Trace-only**: `WalkDeadEnd` — it carries no `next` change of its own; the walk simply stops with
  whatever `next` state the preceding steps already left behind.

### Tree shape: `StartVisited`, then `"walk N"` scopes each split into `"search"`/`"commit"`

Before the main loop, `StartVisited(start)` is emitted once directly under the root scope — the
maze's start node being seeded into `visited` is the algorithm's actual first operation, and it
happens before any walk has even picked a `walk_start`, so there's no walk scope to nest it under.
Preset-connected nodes are *not* covered by this event: they're seeded into `visited` the same way
presets are seeded everywhere else in this codebase (a silent zero-state snapshot, not a narrated
event) — only the start node's own seeding is a distinct, narratable step.

Each subsequent loop iteration opens one `"walk N"` scope (`EventLog::enter_numbered("walk")`),
containing, in emission order:
1. `WalkStartPicked` — the unvisited node this walk starts from, chosen uniformly at random.
   Emitted directly under `"walk N"`, before either sub-phase, so a narration reader knows the
   walk's origin up front.
2. A `"search"` sub-scope (`EventLog::enter("search")`, not numbered — exactly one per walk) —
   every step-related event (`StepTaken`, optionally `LoopErased`, and finally `WalkDeadEnd` if the
   walk dead-ends) lives here flat, not one `"step M"` sub-scope per step. An earlier version of
   this instrumentation used a numbered `"step M"` scope per step, mirroring RB's `"step N"`
   shape — reworked because a step is usually a single event, so a scope per step added tree depth
   in the web narration UI without adding information.
3. A `"commit"` sub-scope (`EventLog::enter("commit")`), **only opened when there's actually a path
   to commit** (i.e. `next` has an entry for `walk_start` — the walk took at least one step before
   possibly dead-ending) — containing an `EdgeAdded` + `NodeVisited` pair for each node committed
   from `walk_start` up to (not including) the already-visited node the loop-erased path reaches.
   Skipped entirely (not opened as an empty scope) when the walk dead-ends on its very first step,
   so a walk that never got anywhere doesn't leave a stray, non-expandable "commit" row in the
   narration tree.

Both `"search"`/`"commit"` contain only events, never further nested scopes.

**Threading**: `wilson::generate(..., event_log: Option<&mut EventLog<WilsonEvent>>)` — the same
`Option<&mut T>` zero-cost-opt-out pattern as RB/Kruskal. `generate_maze_with_events`
(`maze-core/src/generation/mod.rs`) has a `WilsonAlgorithm` arm building a real `EventLog`, calling
`wilson::generate`, and tagging the result `EventedEventKind::Wilson` (see #161 above) —
`checkpoints` is always `None` for this arm (Wilson checkpointing isn't wired up, same as Kruskal).

### Wire encoding

Wire tags (`wilson.rs`'s `wire_tags` module): `WALK_START_PICKED=1`, `STEP_TAKEN=2`,
`LOOP_ERASED=3`, `WALK_DEAD_END=4`, `EDGE_ADDED=5`, `NODE_VISITED=6`, `START_VISITED=7` —
manually assigned per #124's convention, `0`/`TAG_SCOPE` reserved. `NodeId` (`u64`) is 8
little-endian bytes; `StepTaken`/`EdgeAdded` (minus its 1-byte `bidirectional` flag) are two
back-to-back `NodeId`s; `WalkDeadEnd` carries no payload (0 bytes).

### Debug values: `"visited"` (`Region`), `"current_walk"` (`Map`), `"walk_start"`/`"walk_head"` (`Vertex`)

`wilson::debug_value_names() -> &'static [(&'static str, DebugValueKind)]` returns
`&[("visited", Region), ("current_walk", Map), ("walk_start", Vertex), ("walk_head", Vertex)]` —
the same static-declaration pattern as `recursive_backtracker::debug_value_names()` (see #131
above).

- **`"visited"`** (`Region`) — a plain insert-only set, mirroring the algorithm's own
  `visited: HashSet<NodeId>` exactly (a node is never un-visited once committed). Reported via the
  existing `DebugValueDelta` trait: `StartVisited`/`NodeVisited` → `Insert`.
- **`"current_walk"`** (`Map`) — the in-progress walk's `next` map. `StepTaken { from, to }` sets
  `next[from] = to`, **overwriting** any prior value for `from` exactly the way `HashMap::insert`
  does — this is why it can't be a plain `DebugValueDelta`: `Insert`/`Remove` only ever touch one
  id, never overwrite a key's value, which is exactly what loop erasure needs (re-stepping through
  an already-recorded node replaces that node's outgoing step). `WalkStartPicked` clears the map, so
  a new walk doesn't inherit the previous (committed-or-abandoned) walk's track. Reported via a new
  trait, `DebugMapDelta<Id>`, and a new op enum, `DebugMapOp<Id> { Set(Id, Id), Clear }` (generic
  over `Id` so `Clear` doesn't need placeholder ids) — both in `maze-core/src/event_log/mod.rs`,
  alongside `DebugValueDelta`/`DebugValueOp`.
- **`"walk_start"`/`"walk_head"`** (`Vertex`) — the walk's origin and current position,
  respectively. `WalkStartPicked(node)` sets *both* to `node` (before any step, the head *is* the
  start); each subsequent `StepTaken { to, .. }` moves only `walk_head` to `to`. Reported via
  another new trait, `DebugVertexDelta<Id>`, and op enum, `DebugVertexOp<Id> { Set(Id), Clear }` —
  structurally `DebugMapOp` minus the second id, since a `Vertex` slot never carries a "value", only
  an occupant. Deliberately *not* derived by reading the endpoints off `current_walk`'s `Map` state
  on the web side (e.g. "the last key in insertion order is the walk's head") — a
  `HashMap::insert`-style overwrite of an *existing* key doesn't move that key's position in
  iteration order, so "last key" silently stops tracking the walk's actual current position once a
  walk revisits a node via loop erasure. That heuristic was tried and rejected during development
  specifically because it broke on this exact case. `walk_start`/`walk_head` are reported directly
  by the events that actually change them instead, sidestepping the whole question of map-iteration
  order. Neither slot ever `Clear`s — a new `WalkStartPicked` simply overwrites both, and there's no
  meaningful "no walk in progress" moment mid-run worth rendering as empty.

### Web side

`maze-web/src/debug/eventTape.ts` mirrors the above: `WILSON_TAG` wire-tag constants,
`decodeWilsonEvent`/`isMutatingWilsonEvent`, `mutatingWilsonEventsWithIndex`/`mutatingWilsonEvents`
(flat-layer scan, mirroring Kruskal's — no checkpoint resume, every call replays from the tape's
start), and `applyWilson(tape, targetStep) -> { edges, debugValues, debugMaps, debugVertices, step,
nodeIndex }`. `DebugValueKind` gained `"map"`/`"vertex"` string values (the WASM-boundary wire
strings, via `kind_wire_str` in `maze-wasm/src/result.rs`); `DebugMapOp`/`DebugVertexOp` TS types and
`wilsonDebugMapDeltasFor`/`wilsonDebugVertexDeltasFor` mirror the Rust trait impls exactly.
`DebugMazeView` (`maze-web/src/store/debugSelectors.ts`) gained `debugMaps: Map<string, Map<number,
number>>` and `debugVertices: Map<string, number | null>` fields alongside the existing
`debugValues`, populated only on the Wilson dispatch branch (empty for RB/Kruskal).

**Narration** (`DebugEventTree.tsx`): `"walk N"` scopes render as "Walk N" (mirroring RB/Kruskal's
numbered-scope labels); `"search"`/`"commit"` are fixed, non-numbered scope names, rendered as
"Route search"/"Route commit" — checked before the numbered-scope regex (which wouldn't match a
name with no trailing index) in `rowTokens`'s scope-label branch.

**Canvas**: `MapHighlightRenderer` (`maze-web/src/pixi/renderers/`) draws a `Map`-kind value as one
independent directed arrow per key -> value pair, plus a filled circle at every id that appears as
a key or a value — not a chain (unlike `Sequence`'s `SequenceHighlightRenderer`), since pairs don't
connect to each other. `VertexHighlightRenderer` draws a `Vertex`-kind value as one enlarged filled
circle at the slot's current occupant, or nothing when the slot is `null`. `DebugValueHighlightOverlay`
holds one renderer instance per debug-value name (same per-name-not-shared discipline as
`Region`/`Sequence`), picking the renderer class via `kindFor`; `Vertex`-kind layers are always
raised above `Map`-kind layers after each render pass (`walk_start`/`walk_head`'s markers must read
on top of `current_walk`'s arrows, regardless of toggle order) via `Container.addChild` re-appending
each vertex layer's container to the top of the child list.

### Out of Scope (#145)

- Wilson checkpointing (#128-style intermediate snapshots)
- A generalized replacement for `DebugMapDelta`/`DebugVertexDelta` that could express both shapes
  through one trait — kept as two separate traits deliberately (see "Debug values" above)
- Instrumenting custom algorithms, or QC/repair narration-level logging

## Unifying into One Multi-Source Tape (#169)

Every prior section above describes a tape carrying exactly one instrumented source's events —
`EventedGenerationResult`/`GenerateResult` were physically single-slot (one `EncodedTape`, one
`EventedEventKind`). This breaks down once more than one thing needs instrumenting in the same
`generate()` call — QC/repair instrumentation (issue #147) is a second, independent pass that runs
after generation in every call, and per-repair-strategy instrumentation (planned as #147's
follow-on) would add still more sources. This issue unifies the architecture so any number of
sources land in one combined tree; it does not itself add any new instrumented source — QC/repair
events remain #147's scope. The web replay/narration/decode stack now dispatches per top-level
source scope rather than assuming the whole tape is one source.

### `merge_tapes` — domain-agnostic tree combination

`event_log::merge_tapes(sources: Vec<TapeSource>) -> (EncodedTape, Option<EncodedCheckpoints>)`
(`maze-core/src/event_log/mod.rs`) combines several already-encoded, independently-produced tapes
into one arena, operating purely on already-written `NodeRecord`s — it never re-decodes or
re-encodes event payloads. `TapeSource { scope_name: &'static str, tape: EncodedTape, checkpoints:
Option<EncodedCheckpoints> }` is the per-source input; `scope_name` becomes that source's dedicated
top-level child scope's label under the merged root.

Deliberately domain-agnostic: `merge_tapes` takes only a scope-name string per source, never
`GenerationAlgorithm`/`EventedEventKind`-shaped knowledge. Mapping a merged source's scope name to
whichever concrete decoder it needs is the caller's concern — today, `generate_maze_with_events`
(`maze-core/src/generation/mod.rs`) is the single call site, and the only place that both knows
which algorithm ran and calls `merge_tapes`.

**Merge always runs, no single-source special case.** Even with exactly one instrumented source
(every case today), the tape is still wrapped in a merged root + one dedicated top-level source
scope — deliberate, not a placeholder: every consumer sees the same tree shape regardless of how
many sources actually ran, so adding a second source later (#147) requires no branch anywhere that
currently assumes "there's only ever one." Concretely, the tree shape is always: merged root (node
0, `Scope("root")`) → one top-level child scope per source, named `scope_name`, in `sources`' order
→ each wraps that source's own former root (the actual `EventLog::new()` root the algorithm built,
itself always named `"root"`) as its own child → that former root's own children are the
algorithm's real content (e.g. RB's `"step N"` scopes), unchanged in shape from every section above
— just one level deeper than before this issue.

### Tag namespacing: source-index prefix in the high byte

Wire tags (`EncodeEventPayload::type_id()`, a `u16`) are unique only *within* one source's own
event enum — `RecursiveBacktrackerEvent`'s tag 1 (`VertexSelected`) and `KruskalEvent`'s tag 1
(`EdgesShuffled`) collide numerically. This was safe pre-#169 because each `EncodedTape` was
decoded by exactly one decoder, selected via the (single) `EventedEventKind`. Combining sources
into one arena needs per-event source disambiguation, without walking back up the tree to the
nearest source scope for every node.

`merge_tapes` prefixes every non-scope node's tag with its source's positional index, in the tag's
high byte: `tag = (source_index: u8) << SOURCE_SHIFT | local_tag: u8`, where `SOURCE_SHIFT = 8`,
`SOURCE_MASK = 0xFF00`, `LOCAL_TAG_MASK = 0x00FF` (all `pub const` in `event_log/mod.rs`, mirrored
in `maze-web/src/debug/eventTape.ts`). `source_index` is `sources`' 0-based position *within one
`merge_tapes` call* — never a stable cross-tape identifier; it does not correspond to
`EventedEventKind`'s variant order and must not be cached/compared across different tapes.
`TAG_SCOPE` (0) is never namespaced — scope nodes stay `0` regardless of which source they belong
to, so "is this a scope" is still a single equality check against the untouched constant.

For the first source (`source_index == 0`), `0 << SOURCE_SHIFT == 0`, so its tags are numerically
unchanged from their original `local_tag` values — this is the shift math working correctly, not a
skipped step; a decoder must always apply the mask/shift uniformly, never special-case "the first
source doesn't need unpacking."

All existing per-algorithm wire tags (RB, Kruskal, Wilson, CustomEdgeBased, CustomVertexBased) are
completely unchanged by this issue — the largest is `VertexBasedEvent`'s `DIRECTIONALITY_ROLLED =
25`, comfortably inside the low byte. No algorithm's `wire_tags` module needed touching.

### Relinking and payload handling

`merge_tapes`'s node-table pass, per source: shifts `parent`/`first_child`/`next_sibling` links by
that source's node offset (root + one top-level scope per source come first, so offsets start
after those); the former root's own `parent` (previously `NO_NODE`, since it was rootless) is
rewritten to point at its new top-level scope node instead; `payload_offset` is shifted by that
source's payload-arena offset. Payload bytes themselves are copied verbatim — concatenated in
source order, then followed by the merge's own newly-interned scope names (`"root"`,
`scope_name`s) — never reinterpreted or re-encoded.

**Every node index a caller may have captured against a source's original, unmerged `EncodedTape`
becomes meaningless after merging** — every index is renumbered. This includes any raw `node_index`
inside an `EncodedCheckpoints::table` read before the merge call.

### Checkpoint concatenation

Checkpoints (issue #128) are folded the same way: `merge_tapes` concatenates every source's
`EncodedCheckpoints` (if any) into one combined table, shifting each entry's `node_index` by that
source's node offset — same shift as its node table. The result is `None` only when *no* source
supplied checkpoints; if any source has some, the combined table includes exactly those entries
(sources with `checkpoints: None` simply contribute nothing), still sorted by `node_index` since
sources are processed in order and each source's own entries were already sorted by
`CheckpointLog::push`'s invariant.

### `EventedGenerationResult` and `qualify_debug_value_names`

`EventedGenerationResult` (`maze-core/src/generation/mod.rs`) changed shape: `tape` is now a plain
`EncodedTape`, not `Option<EncodedTape>` — `generate_maze_with_events` is the sole constructor and
every algorithm arm produces a tape via `merge_tapes`, so there is no reachable "no tape" state to
represent; a caller needing to conditionally discard it (e.g. `maze-wasm/src/runner.rs`, when the
web replay engine can't decode this event kind) wraps it in its own `Option` rather than this type
carrying one it can never actually leave unset. The single `event_kind: Option<EventedEventKind>`
field is replaced by `sources: Vec<(&'static str, EventedEventKind)>` — one entry per top-level
source scope, in the same order as the merged tree's top-level children (today: always exactly one,
`("generation", ...)`).

`debug_value_names` changed from `&'static [(&'static str, DebugValueKind)]` to `Vec<(String,
DebugValueKind)>` — no longer a static slice, since names may now be dynamically qualified.
`qualify_debug_value_names` (private, `generation/mod.rs`) prefixes every name with `"{scope_name}:"`
when more than one source is present, disambiguating a name two sources might independently declare
(`"visited"` is already reused by RB, Wilson, CustomEdgeBased, and CustomVertexBased independently —
see their respective sections above). With exactly one source (every case today), names pass
through unqualified, matching every pre-#169 name/test/UI expectation verbatim — qualification only
changes the wire format once a second source genuinely exists (#147).

### WASM boundary: `sources`/`source_scope_names`/`source_event_kinds`

`GenerateResult` (`maze-wasm/src/result.rs`) replaces its single `event_kind: Option<String>` field
with a parallel-array pair, same pattern `debug_value_names`/`debug_value_kinds` already use:
`source_scope_names: Vec<String>` and `source_event_kinds: Vec<String>` (wire strings via the
existing `event_kind_wire_str`), one entry per top-level source scope, both empty exactly when no
debug tape was built. Exposed as `.sourceScopeNames()`/`.sourceEventKinds()` (replacing the old
`.eventKind()`), plain `Vec<String>` returns — no zero-copy view, matching `debugValueNames`'s own
marshaling. `maze-wasm/src/runner.rs`'s `is_web_decodable` gate now checks every source's kind
(`result.sources.iter().all(...)`) — all-or-nothing today (there's always exactly one source);
partial forwarding when a mix of decodable/undecodable sources exists is out of scope until #147
makes that a real case.

### Web side: `topLevelSourceScopes`, per-source tag unpacking, auto-expand

`maze-web/src/debug/eventTape.ts`'s `nodeAt` — the single place every decoder in the module reads a
`NodeRecord` from — now unpacks the merge's tag prefix once: `NodeRecord.tag` comes back as the
already-unmasked local wire tag, and a new `NodeRecord.sourceIndex` field carries the unpacked
source index (`0` for `TAG_SCOPE` nodes, matching the Rust side's "never namespaced" rule). Every
existing per-algorithm decoder (`decodeRecursiveBacktrackerEvent`, etc.) is unaware merging exists
at all — it keeps reading `record.tag` exactly as before.

`topLevelSourceScopes(tape) -> TopLevelSourceScope[]` (`{ scopeName, nodeIndex }[]`) walks the
merged root's direct children — a pure navigation/inspection helper, used by tests and as the entry
point a future multi-source consumer (#147) would use to enumerate sources. `mazeService.ts`'s
`DebugTape.sourceScopeNames`/`sourceEventKinds` mirror the WASM boundary's parallel arrays;
`DebugArenaHandle.algorithmKind` (`storeTypes.ts`) reads the first (only) entry of
`sourceEventKinds` — consuming more than one source's decoder/apply/narration at once is out of
scope until #147.

`DebugEventTree.tsx` auto-expands, on every fresh tape, both each top-level source scope and its
one child (the former root) — matching pre-#169 behavior (where `"step N"`/`"edge N"`/... were
visible immediately without an extra click) despite the tree now being two levels deeper. Resets
the `expanded` set to a fresh one per tape rather than adding on top of the previous tape's
expanded-row indices, which would otherwise be stale, coincidentally-matching state carried across
unrelated runs.

### Out of Scope (#169)

- Adding any new instrumented source (QC/repair events remain #147's scope)
- Aggregating narration/apply across more than one source scope at once in the web UI (deferred
  until a real second source exists)
- A generalized replacement for the per-repair-strategy instrumentation this issue's architecture
  enables but does not itself build

## QC/Repair Instrumentation and Multi-Source Web Replay (#147)

The first real second source: `QcEvent` narration (`maze-core/src/quality_control/event.rs`, see
`Specs/quality_control.md`'s "Narration-level debug instrumentation" section for the full
scope/event catalog) merges alongside generation's own tape whenever `debug_events` is on and the
QC/repair pass produced at least one event. This is where #169's multi-source merge machinery gets
its first genuine multi-source consumer on the web side — `topLevelSourceScopes` goes from
enumerating exactly one entry to potentially two (`"generation"`, then `"quality_control"`), and
every web-side consumer that used to read `DebugArenaHandle.algorithmKind`/`sourceEventKinds[0]`
as if it were the whole tape had to become genuinely per-source-scope-aware. The four contracts
below are the rules that transition rests on — referenced by name (`Contract A`/`B`/`C`/`D`)
throughout `eventTape.ts`/`algorithmRegistry.ts`/`debugSelectors.ts`/`debugTreeSelectors.ts`/
`storeTypes.ts`/`generateConfigBuilder.ts`/`DebugEventTree.tsx`'s own doc comments, defined here
once rather than re-explained at every call site.

### Contract A — global `debugStep` numbering, source order = execution order

One counter spans the whole merged tape: every mutating event in the first top-level source scope
gets a lower `debugStep` than every mutating event in the second, with no interleaving between
them. This isn't an arbitrary numbering choice — it reflects real execution order. QC/repair only
ever starts after generation has fully finished (`maze-wasm/src/runner.rs::run_generate` calls
`build_maze` strictly after `run_initial_generation` returns), so `debugStep=0..totalGenerationSteps-1`
replays generation, and `debugStep=totalGenerationSteps..totalSteps-1` replays QC's mutations on
top of generation's already-complete final state.

`DebugArenaHandle.sources` (`storeTypes.ts`) is the concrete realization: one entry per top-level
source scope, each owning a `[startStep, endStep)` half-open range of the shared `debugStep`
space, built by `generateConfigBuilder.ts`'s debug-arena construction — `resolveMetadata`'s
`totalSteps` per source accumulates into `runningStep`, and each source's `startStep`/`endStep`
are just that running total before/after. A caller resolving global `debugStep` down to a specific
source's own local step (`selectDebugMazeView`, `buildStepIndex`) finds the owning source by
`startStep <= debugStep < endStep` and subtracts `startStep`.

### Contract B — `sourceScopeForNode`/`adapterForNode` are the only ways to resolve "which source"

Nothing outside `eventTape.ts` walks `NodeRecord.parent` by hand to find which top-level source
scope a given arena node belongs to. `sourceScopeForNode(tape, nodeIndex)` walks `.parent` up to
the nearest top-level scope and returns it; `adapterForNode(tape, nodeIndex, sourceEventKinds)`
(`algorithmRegistry.ts`) builds on that to resolve the concrete decoder/apply/narration adapter for
an arbitrary node — the one function `DebugEventTree.tsx`'s per-row rendering (`rowTokens`) and
`debugTreeSelectors.ts` call, instead of re-deriving "which source" independently in each place.
Every top-level source's own *content* starts at its scope wrapper's `firstChild`, not at the
wrapper's own `nodeIndex` — `merge_tapes` lays every source's wrapper node out contiguously right
after the merged root, *before* any source's actual content (`maze-core/src/event_log/mod.rs`), so
a flat scan bounded by `nodeIndex` itself (instead of `firstChild`) runs straight into a different
source's bytes. `sourceContentStart(tape, nodeIndex)` (`eventTape.ts`) is the single place this
resolution happens — every bounded scan (`mutatingXEventsWithIndex`'s `startIndex`/`endIndex`,
`resolveDebugArenaMetadata`, every `applyX`) is bounded through it, not through a top-level scope's
raw `nodeIndex`. Getting this wrong was a real, shipped regression: an unbounded/mis-bounded scan
of one source's tags ran into a later source's bytes and mis-decoded them using the wrong
decoder — concretely, QC's `IterationStarted` tag (`1`) numerically collides with RB's
`VertexSelected` tag (`1`), so the failure mode surfaces as a payload-length mismatch error
("`tag 1 payload_len N does not match expected M`") rather than a silently wrong value.

### Contract C — `mergeDebugMazeView` combines independent per-source contributions, never in place

Each source's own `apply()` call (`applyKruskal`/`applyWilson`/`applyRecursiveBacktracker`/
`applyEdgeBased`/`applyVertexBased`/`applyQc`) builds its contribution in complete independence —
it never knows any other source exists, never reads another source's state, and is bounded to only
its own arena range (Contract B). `debugSelectors.ts`'s `generationContribution`/`qcContribution`
package each source's own `apply()` result into a `DebugMazeViewContribution`; `mergeDebugMazeView`
is the *only* place contributions from more than one source are ever combined, folding them in
source order (mirroring Contract A's execution order): the accumulator's `edges` starts from the
first (generation) contribution's own list, and each subsequent contribution's `removedEdges` is
applied as a retraction against edges contributed by an *earlier* source, before that contribution's
own `edges` are appended. `dsuGroups`/`debugMaps`/`debugVertices` are generation-only fields (no
`QcEvent` carries an equivalent — see `Specs/quality_control.md`'s note on why QC declares no debug
values) and pass straight through from whichever single contribution actually populates them.

**A single source's own `apply()` result must already be a net state, not two independent
append-only logs**, or `mergeDebugMazeView`'s cross-source filter-then-concat can't correctly
resolve an edge added and removed *within the same source's own replay window* (e.g. QC's repair
loop adding a shortcut in one iteration and a later strategy removing that same edge, both within
`[0, targetStep]`) — this was a real, shipped bug: `applyQc` used to accumulate `edges`/
`removedEdges` as two flat, order-blind lists, so an intra-QC add-then-remove for the same `from:to`
pair left the edge visible after merge instead of correctly net-removed. `applyQc` folds events
into a `from:to`-keyed running map in emission order instead (a later event always overrides an
earlier one for the same pair, whichever direction), and only reports `removedEdges` for a pair
that was never added within this same call — i.e. one that can only have come from an *earlier*
source's contribution. Debug-value/-map/-vertex names get a parallel per-contribution transform,
`qualifyContribution`, mirroring `maze_core::generation::qualify_debug_value_names`'s own
`"{scopeName}:"` qualification (applied only once `arena.sources.length > 1`) — the *declared* name
list (`debugArena.debugValueNames`, what `DebugPanel.tsx` renders toggles from) is qualified on the
core side, but the *replayed* state each `applyX` call returns is keyed by each algorithm's own
unqualified name, so `debugSelectors.ts` must qualify it the same way or a toggle keyed by the
qualified name never matches a replayed map's unqualified key — another real regression, fixed by
`qualifyContribution`.

### Contract D — a single source degenerates to identity, no special case anywhere

With no QC source (debug_events off, or QC produced zero events) or a web-undecodable source
filtered out, `arena.sources`/`topLevelSourceScopes` carry exactly one entry, same as every run
before #147. `mergeDebugMazeView` called with exactly one contribution reduces to identity — the
returned `edges` is just that contribution's own list, unchanged; `dsuGroups`/`debugMaps`/
`debugVertices` pass through as-is. No caller anywhere (`selectDebugMazeView`,
`debugTreeSelectors.ts`, `DebugEventTree.tsx`) special-cases `sources.length === 1` — the same code
path that handles two sources handles one, which is what keeps every pre-#147 generation-only test
(Kruskal/Wilson/RB/EdgeBased/VertexBased) passing unmodified.

### Scope-id-to-title resolution stays on the web side, never round-tripped through the wire

`"stage <id>"`/`"rule <id>"` scope names (`maze-core/src/quality_control/`) embed each `Stage`/
`Rule`'s own opaque config `id`, never a user-facing display title — core has no concept of a
rule's title at all (`QcRuleConfig` on the wire carries only `id`; `StageConfig` carries both `id`
and `name`, but only `id` ever reaches a scope name). `algorithmRegistry.ts`'s `ScopeTitleLookup`
resolves an id to its current title live, from the running store's `stages`/`rules` config
(`DebugEventTree.tsx` builds it from `useMazeStore((s) => s.stages)`/`.rules`), rather than having
core send the title across the wire — sending it wouldn't actually be any fresher: a title
round-tripped through the wire at generation time would go stale exactly as fast after a later
rename as one resolved from the live store on each render, so there is no correctness argument for
the wire round-trip, only unnecessary wire/type surface. `BaseAlgorithmAdapter.scopeLabel`/
`narrationTokensFor` both take an optional `titleLookup: ScopeTitleLookup` parameter — every
non-QC adapter ignores it; `QC_ADAPTER` uses it to resolve `"stage <id>"`/`"rule <id>"` scope
labels and `CheckRan`'s narration text to the current title (quoted, via
`quoted()`, so it reads as a distinct name rather than running into the surrounding sentence with
no separator), falling back to the raw id when the lookup doesn't recognize it (e.g. the rule was
deleted after this tape was generated).

### Tree rendering: the former-root merge artifact never gets its own row

Every top-level source scope's own single child is that source's former root (the scope
`EventLog::new()` always names `"root"` before merging existed) — a purely structural artifact of
`merge_tapes`, never a real narration step. `debugTreeSelectors.ts`'s `flattenVisibleRows` accepts
an explicit `transparentNodeIndices` set (each source's former-root node index, computed by
`DebugEventTree.tsx` from `topLevelSourceScopes`) and treats each one exactly like the merged root
itself is already treated: never its own row, always expanded, its children rendered one depth
shallower than they'd otherwise sit at — so the visible tree reads `<source scope> -> <real
steps>` instead of `<source scope> -> "root" -> <real steps>`. Deliberately *not* inferred from
tree shape (e.g. "any depth-2 scope is a former root") inside `flattenVisibleRows` itself — that
function is a generic tree-flattening utility with no built-in notion of merged tapes, and this
module's own unit tests build differently-shaped, non-merged trees that a depth-based heuristic
would misfire on. `displayStepForRow`'s "first mutating step in this scope's subtree" resolution
is a real structural walk via `firstChild`/`nextSibling` for the same reason a top-level scope's
own subtree range check (`subtreeEnd`-style arena-index-range arithmetic) doesn't work: a top-level
scope's real content isn't contiguous with its own arena index the way an ordinary nested scope's
children are, so only a genuine tree walk gives the right answer for every scope shape uniformly.

### Out of Scope (#147, beyond `Specs/quality_control.md`'s own "out of scope" note)

- Per-repair-strategy instrumentation (a further breakdown inside one `"rule <id>"` scope) —
  #169's architecture supports it, this issue doesn't build it
- A third top-level source, or any change to `merge_tapes`'s own node-layout/tag-namespacing
  mechanism — #147 only changes which callers reach `merge_tapes` and how many sources they hand
  it, never the function itself
- QC checkpoints (#128-style intermediate snapshots) — QC's own tape is expected far shorter than
  a full generation tape, so `CHECKPOINT_INTERVAL`-scale resume isn't needed
