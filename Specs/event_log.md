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

Encoding conventions used by `RecursiveBacktrackerEvent` (the only instrumented enum so far): a `NodeId` (`u64`) is 8 little-endian bytes; `EdgeAdded { from, to }` is two back-to-back `NodeId`s (16 bytes); `CandidatesComputed(Vec<NodeId>)` (the only variable-length variant) is a `u32` LE length prefix followed by that many `NodeId`s — the length lives *inside* the payload slice, not as another `NodeRecord`-level offset/len tier; `DeadEnd` (unit variant) is a 0-byte payload.

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

Bounded on both ends: the node-table scan starts at `from.nodeIndex + 1` (or 0 without `from`) via `mutatingRbEventsWithIndex(tape, targetStep - (from?.step ?? -1), scanStart)`, and stops once enough new mutating events have been collected to reach `targetStep`. So neither the already-known prefix (when resuming via `from`) nor the tape's tail past `targetStep` is ever decoded — this is what makes a resumed call's cost independent of how large `targetStep` itself is, not just independent of the tape's total size. Only `EdgeAdded` events from the new (post-`from`) slice are folded into `edges`; `VertexVisited`/`VertexPushed`/`VertexPopped` are walked over (so step indexing lines up) but aren't accumulated into the output, since this minimal state shape carries no visited-set/frontier.

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
- Cleanup of the old `debug_steps`/`GenerationStepDto` path
- Intermediate snapshots / checkpointing (core-side)
