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

`generation::generate_maze_with_events` (`maze-core/src/generation/mod.rs`) bypasses `dispatch()` deliberately — `dispatch` is shared across all five generation algorithms and must not be tied to one concrete `EventLog<E>` type. It matches `config.algorithm` directly: for `RecursiveBacktracker` it builds a real `EventLog`, calls `recursive_backtracker::generate` with it, and returns `Some(DebugTape)`; every other algorithm returns `None` (not instrumented yet). It also accepts a `collect_steps: bool` to optionally gather the legacy `GenerationStep` trace (`on_step`) alongside the event tree in the same pass, since `debug` and `debug_events` are independent flags on `GenerateConfig` and may both be set during the migration off the old snapshot tool.

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

`start`/`finish` are never part of the reconstructed state — Recursive Backtracker doesn't emit them; they're static config outside this engine's scope.

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

`showDebugFrontier` (the old debug-frontier highlight toggle, tied to `MazeTileRenderer`'s `activeNodes`/`current_src` fields) is dropped, not ported forward — the new replay engine has no live producer for "frontier" state (which nodes are currently reachable-but-unvisited mid-DFS), and reimplementing it against the arena/replay model was explicitly out of scope for this issue. `MazeTileRenderer.ts` itself was later deleted (dead code, zero call sites, found during #132's review) since nothing else depended on it either. Frontier highlighting was superseded by the interactive node/edge ref highlighting built in #130 (see below), which highlights on hover rather than showing a persistent frontier set.

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

`generate_maze_with_events` (`maze-core/src/generation/mod.rs`) now returns a named struct, `EventedGenerationResult { steps, tape, checkpoints }`, instead of a growing tuple — the function is public API `maze-wasm` calls into, so a third positional tuple element would have hurt readability at both call sites. `checkpoints: Option<CheckpointLog>` is `Some` exactly when `tape` is (both come from the same Recursive Backtracker run); `None` for every other algorithm.

### WASM boundary

`GenerateResult` (`maze-wasm/src/result.rs`) gained a second, independent buffer pair: `snapshot_table: Option<Vec<u8>>` / `snapshot_payload: Option<Vec<u8>>`, attached via a chainable `with_checkpoints(self, table, payload) -> Self` builder method (composes with either `with_debug_tape`/`without_debug_tape`) rather than folding checkpoint parameters into the existing constructors — keeps the two transfer concerns (event tree vs. checkpoints) independently constructible. Exposed as `.debugSnapshotTable()` / `.debugSnapshotPayload()` — `Option<js_sys::Uint8Array>`, the same zero-copy `js_sys::Uint8Array::view` pattern and next-WASM-call invalidation caveat as `.debugTapeNodeTable()`/`.debugTapePayload()` (see #124's section above).

`maze-wasm/src/runner.rs`'s `run_initial_generation` encodes `checkpoints.encode()` alongside `tape.encode()` (same post-timing-window placement as the tape, so it doesn't inflate `initial_build_ms`) and returns it as a fourth tuple element — this helper stays a plain tuple (unlike `EventedGenerationResult`) since it's a small internal function, not public API.

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

- QC/repair narration events (future epic scope, per #121 and #130 itself)
- Reusing `DebugRefHighlightOverlay`/`RegionHighlightRenderer` for other features beyond this and
  Analytics' existing issue highlighting
- Instrumenting Wilson, Kruskal, or custom algorithms with node/edge refs
