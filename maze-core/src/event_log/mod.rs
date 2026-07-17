//! Debug event log: a tree of scopes and events built during generation, stored as a flat
//! arena (`Vec`-backed, parent/first_child/next_sibling links) so it can later be exposed
//! zero-copy across the WASM boundary (see issue #124).
//!
//! Events are split into two kinds via [`DebugEvent::is_mutating`]: mutating events are
//! replayed to reconstruct state, trace events are narration-only. Insertion order in the
//! backing `Vec` is DFS pre-order by construction (see the invariant note on [`DebugTape`]),
//! so linear (emission) order for mutating events is recovered by a plain forward scan.

use std::borrow::Cow;

enum NodeKind<E> {
    Scope(Cow<'static, str>),
    Event(E),
}

struct Node<E> {
    parent: Option<u32>,
    first_child: Option<u32>,
    last_child: Option<u32>,
    next_sibling: Option<u32>,
    kind: NodeKind<E>,
}

/// Implemented by concrete per-algorithm event enums (e.g. Recursive Backtracker's events,
/// added in issue #123) to mark which variants are mutating (replayed) vs. trace-only
/// (display-only narration).
pub trait DebugEvent {
    fn is_mutating(&self) -> bool;
}

/// Insert/remove operation on a named [`DebugEvent::debug_value_deltas`] set — see issue #131.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugValueOp {
    Insert,
    Remove,
}

/// Semantic shape of a debug value's id collection — affects how the web side renders it, not how
/// `debug_value_deltas` reports it (both kinds still use `Insert`/`Remove` on a single id). See
/// issue #131's follow-up and `Specs/event_log.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugValueKind {
    /// Unordered set of ids with no relationship between members — rendered as independent
    /// per-node highlights (e.g. `"visited"`).
    Region,
    /// Ordered list of ids where adjacent members are connected — rendered as a chain of
    /// arrows between consecutive ids, mirroring the graph/nav-graph edge visual (e.g.
    /// `"recursion_stack"`, the DFS stack in push order).
    Sequence,
    /// Key-to-value pairs with overwrite-by-key semantics — rendered as an independent arrow from
    /// each key to its value (not a chain: unlike `Sequence`, pairs don't connect to each other).
    /// Reported via [`DebugMapDelta`], not [`DebugValueDelta`] — `Insert`/`Remove` on a single id
    /// can't express "setting a key that already has a value replaces it", which is exactly
    /// `HashMap::insert`'s behavior for a structure like Wilson's walk `next` map (issue #145).
    Map,
    /// A single, reassignable node id — not a `Region` with one element: a `Region` is an
    /// unordered *set* (`Insert`/`Remove` on possibly-many ids), where a `Vertex` is one named
    /// slot that always holds at most one id at a time and is *replaced* wholesale, not
    /// inserted/removed piecemeal (e.g. Wilson's `"walk_head"` — the walk's current position,
    /// which moves on every step rather than accumulating). Reported via [`DebugVertexDelta`], not
    /// [`DebugValueDelta`] — mirrors why `Map` needed its own trait instead of reusing
    /// `Insert`/`Remove`.
    Vertex,
}

/// Set/clear operation on a named [`DebugMapDelta::debug_map_deltas`] map — see issue #145's
/// follow-up (Wilson's `"current_walk"`). Separate from [`DebugValueOp`] (not folded into it as
/// another variant) because `Set` carries two ids (key, value) where `Insert`/`Remove` carry one;
/// generic over `Id` itself (rather than living alongside the ids in a separate tuple field) so
/// `Clear` — which has no per-entry payload — doesn't need to carry unused placeholder ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugMapOp<Id> {
    /// Sets `key` to `value`, overwriting any existing value for that key — mirrors
    /// `HashMap::insert`'s key-overwrite semantics exactly.
    Set(Id, Id),
    /// Clears every key currently in the map — used e.g. at the start of a new Wilson walk, so
    /// the previous walk's `next` map doesn't linger into the new one's replay.
    Clear,
}

/// Set/clear operation on a named [`DebugVertexDelta::debug_vertex_deltas`] single-id slot — see
/// issue #145's follow-up (Wilson's `"walk_start"`/`"walk_head"`). Structurally identical to
/// [`DebugMapOp`] minus the second id (no value, just the slot's occupant) — a separate type
/// rather than reusing `DebugMapOp<Id>` with a placeholder id, since a `Vertex` slot never has a
/// "value" to carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugVertexOp<Id> {
    /// Sets the slot to `id`, replacing whatever it held before.
    Set(Id),
    /// Empties the slot. Part of the trait's declared vocabulary (mirrors `DebugMapOp::Clear`,
    /// which Wilson's `"current_walk"` does use) even though no current implementor constructs it
    /// — Wilson's `"walk_start"`/`"walk_head"` only ever `Set` (a new `WalkStartPicked` overwrites
    /// both slots rather than clearing them first, since there's no meaningful "no walk in
    /// progress" moment worth rendering as empty mid-run). Kept for a future `Vertex`-kind value
    /// that does need an explicit empty state.
    Clear,
}

/// Tags which concrete event enum an [`EncodedTape`] was built from — one variant per algorithm
/// that has `EventLog` instrumentation (not one per generation-algorithm variant in general, most
/// of which aren't instrumented at all). This is the single source of truth for "whose tape is
/// this" once the concrete `E` has been erased to bytes — see GitHub issue #161: consumers that
/// only understand some event kinds (e.g. the web replay engine, RB-only so far) filter on this
/// tag rather than re-matching on the generation algorithm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventedEventKind {
    RecursiveBacktracker,
    Kruskal,
    Wilson,
    EdgeBased,
    VertexBased,
    QualityControl,
}

/// Implemented by a concrete event enum to declare how its mutating variants affect named,
/// session-specific "debug value" sets (e.g. Recursive Backtracker's `"recursion_stack"` — see issue
/// #131 and `Specs/event_log.md`). Deliberately derived from the *existing* mutating events
/// rather than a separate `DebugValueChanged` event: a dedicated event would double the mutating
/// event count on every push/pop (inflating step numbering) and duplicate the same id already
/// carried by e.g. `VertexPushed`/`VertexPopped`. Default implementation returns no deltas — only
/// algorithms that expose debug values need to override this.
///
/// Generic over `Id` (rather than hardcoding `crate::ids::NodeId`) so `event_log` stays free of
/// any dependency on domain types — mirrors how `Node<E>`/`DebugTape<E>` are generic over the
/// event type itself.
pub trait DebugValueDelta<Id> {
    /// Named set deltas this event causes, e.g. `[("recursion_stack", DebugValueOp::Insert, id)]` for
    /// `VertexPushed(id)`. Empty for events that don't affect any debug value. `name` is a
    /// `'static` string (the debug value's stable identifier, shared across every event of a
    /// given algorithm) so no allocation is needed to report it.
    fn debug_value_deltas(&self) -> Vec<(&'static str, DebugValueOp, Id)> {
        Vec::new()
    }
}

/// Implemented by a concrete event enum to declare how its mutating variants affect named
/// `DebugValueKind::Map` debug values (see issue #145's follow-up, e.g. Wilson's `"current_walk"`)
/// — the `Set`/`Clear`-based counterpart to [`DebugValueDelta`]'s `Insert`/`Remove`. A separate
/// trait rather than a variant on `DebugValueDelta` since `Set` carries two ids (key, value) where
/// `Insert`/`Remove` carry one (see [`DebugMapOp`]'s doc comment). Default implementation returns
/// no deltas — only algorithms that expose map-shaped debug values need to override this.
pub trait DebugMapDelta<Id> {
    /// Named map deltas this event causes, e.g. `[("current_walk", DebugMapOp::Set(from, to))]`
    /// for a `StepTaken { from, to }`-style event. Empty for events that don't affect any map
    /// debug value.
    fn debug_map_deltas(&self) -> Vec<(&'static str, DebugMapOp<Id>)> {
        Vec::new()
    }
}

/// Implemented by a concrete event enum to declare how its mutating variants affect named
/// `DebugValueKind::Vertex` debug values (see issue #145's follow-up, e.g. Wilson's
/// `"walk_start"`/`"walk_head"`) — the `Set`/`Clear`-based counterpart to [`DebugValueDelta`] for a
/// single reassignable slot rather than a set. A separate trait from both [`DebugValueDelta`] and
/// [`DebugMapDelta`] for the same reason those two are separate from each other: the payload shape
/// differs (one id here, vs. one id with Insert/Remove semantics, vs. two ids for Map).
pub trait DebugVertexDelta<Id> {
    /// Named vertex deltas this event causes, e.g. `[("walk_head", DebugVertexOp::Set(to))]` for a
    /// `StepTaken { from, to }`-style event. Empty for events that don't affect any vertex debug
    /// value.
    fn debug_vertex_deltas(&self) -> Vec<(&'static str, DebugVertexOp<Id>)> {
        Vec::new()
    }
}

/// RAII builder for a [`DebugTape`]. `enter` opens a nested scope and returns a guard;
/// while a guard is alive it is the only way to `emit`/`enter` further, and dropping it
/// (including on panic unwind) restores the cursor to the parent scope.
pub struct EventLog<E> {
    nodes: Vec<Node<E>>,
    cursor: u32,
    /// Per-(parent scope, base name) sibling counters backing [`EventLog::enter_numbered`] /
    /// [`ScopeGuard::enter_numbered`] — e.g. distinguishing "step 1" from "step 47" without the
    /// caller (or a UI consumer) having to count siblings manually (see issue #133).
    numbered_counters: std::collections::HashMap<(u32, Cow<'static, str>), u32>,
}

impl<E> EventLog<E> {
    pub fn new() -> Self {
        let root = Node {
            parent: None,
            first_child: None,
            last_child: None,
            next_sibling: None,
            kind: NodeKind::Scope(Cow::Borrowed("root")),
        };
        Self { nodes: vec![root], cursor: 0, numbered_counters: std::collections::HashMap::new() }
    }

    /// Next 1-based index for `base_name` among same-name siblings opened directly under the
    /// current cursor via `enter_numbered` — independent of any plain (non-numbered) `enter`
    /// scopes that share the same cursor and name.
    fn next_numbered_index(&mut self, base_name: &str) -> u32 {
        let key = (self.cursor, Cow::Owned(base_name.to_owned()));
        let counter = self.numbered_counters.entry(key).or_insert(0);
        *counter += 1;
        *counter
    }

    fn push_child(&mut self, kind: NodeKind<E>) -> u32 {
        let idx = self.nodes.len() as u32;
        self.nodes.push(Node {
            parent: Some(self.cursor),
            first_child: None,
            last_child: None,
            next_sibling: None,
            kind,
        });
        let parent = &mut self.nodes[self.cursor as usize];
        match parent.last_child {
            Some(last) => self.nodes[last as usize].next_sibling = Some(idx),
            None => self.nodes[self.cursor as usize].first_child = Some(idx),
        }
        self.nodes[self.cursor as usize].last_child = Some(idx);
        idx
    }

    /// Opens a new scope as the last child of the current cursor, returning a guard that
    /// restores the cursor to its current value when dropped.
    pub fn enter(&mut self, name: impl Into<Cow<'static, str>>) -> ScopeGuard<'_, E> {
        let parent = self.cursor;
        let idx = self.push_child(NodeKind::Scope(name.into()));
        self.cursor = idx;
        ScopeGuard { log: self, parent }
    }

    /// Opens a new scope as the last child of the current cursor, named `"{base_name} {n}"`
    /// where `n` is a 1-based counter auto-incremented per (current cursor, `base_name`) pair —
    /// e.g. successive calls with `base_name = "step"` under the same parent produce "step 1",
    /// "step 2", ... (see issue #133). Counting is scoped to the cursor, not global, so sibling
    /// scopes under different parents (or with a different name) number independently.
    pub fn enter_numbered(&mut self, base_name: &str) -> ScopeGuard<'_, E> {
        let n = self.next_numbered_index(base_name);
        self.enter(format!("{base_name} {n}"))
    }

    fn emit_inner(&mut self, event: E) -> u32 {
        self.push_child(NodeKind::Event(event))
    }

    /// Emits an event directly into the current cursor's scope (the root scope, if no
    /// guard is open) without opening a nested scope for it. Returns the arena index the event
    /// was inserted at — an opaque handle (not exposed elsewhere as an indexable position).
    pub fn emit(&mut self, event: E) -> u32 {
        self.emit_inner(event)
    }

    /// Consumes the builder, returning a read-only [`DebugTape`]. No further `enter`/`emit`
    /// is possible after this — enforced at the type level (`self` is consumed).
    pub fn finish(self) -> DebugTape<E> {
        DebugTape { nodes: self.nodes }
    }
}

impl<E> Default for EventLog<E> {
    fn default() -> Self {
        Self::new()
    }
}

/// Scope handle returned by [`EventLog::enter`] / [`ScopeGuard::enter`]. The only way to
/// `emit`/`enter` while this scope is open — enforces at compile time that a scope can't be
/// forgotten, since dropping the guard is the only way to close it.
pub struct ScopeGuard<'a, E> {
    log: &'a mut EventLog<E>,
    parent: u32,
}

impl<'a, E> ScopeGuard<'a, E> {
    /// Returns the arena index the event was inserted at — see [`EventLog::emit`].
    pub fn emit(&mut self, event: E) -> u32 {
        self.log.emit_inner(event)
    }

    /// Opens a nested scope under this one, borrowing this guard rather than consuming it —
    /// only one guard can be alive at a time by construction (the borrow checker enforces
    /// it): the child guard holds `&mut` on this one, so this guard is unusable until the
    /// child is dropped. Once the child drops, this guard is directly usable again — this is
    /// what lets a caller emit into the parent scope between/after a sequence of sibling
    /// child scopes (see issue #162).
    ///
    /// Caveat: since [`ScopeGuard`] has a non-trivial [`Drop`], NLL does not shorten the
    /// child's borrow to its last use — it lives until the child is actually dropped. A child
    /// opened inline in a loop body (not in its own nested block) is still borrowed at the
    /// following statement, so emitting into the parent right after opening a child without
    /// an explicit enclosing block fails to borrow-check; wrap the child's `enter`/`emit` in
    /// its own block so it drops before the parent is used again.
    pub fn enter(&mut self, name: impl Into<Cow<'static, str>>) -> ScopeGuard<'_, E> {
        self.log.enter(name)
    }

    /// Nested-scope counterpart to [`EventLog::enter_numbered`] — see its docs for the naming
    /// scheme and [`ScopeGuard::enter`]'s docs for the borrowing/`Drop` caveat.
    pub fn enter_numbered(&mut self, base_name: &str) -> ScopeGuard<'_, E> {
        self.log.enter_numbered(base_name)
    }
}

impl<'a, E> Drop for ScopeGuard<'a, E> {
    fn drop(&mut self) {
        // Runs on both normal scope exit and panic unwind, so the cursor is always restored
        // to the parent scope regardless of how the guard's lifetime ends.
        self.log.cursor = self.parent;
    }
}

/// Read-only result of [`EventLog::finish`] — an immutable arena. No direct indexing is
/// exposed outside this type (see issue #124's encapsulation constraint); all access goes
/// through [`DebugTape::iter`] / [`DebugTape::mutating_events`] / [`DebugTape::root`] /
/// [`NodeView`].
pub struct DebugTape<E> {
    nodes: Vec<Node<E>>,
}

impl<E> DebugTape<E> {
    /// DFS pre-order traversal — by construction, this is just insertion order: every node
    /// is pushed as the last child of the then-current cursor, so a node's index in `nodes`
    /// is always after its parent's and after every previously-inserted node in the same
    /// subtree. No recursion or explicit stack is needed.
    pub fn iter(&self) -> impl Iterator<Item = &E> {
        self.nodes.iter().filter_map(|n| match &n.kind {
            NodeKind::Event(e) => Some(e),
            NodeKind::Scope(_) => None,
        })
    }

    /// The root scope, as a [`NodeView`] — entry point for walking the tree's actual
    /// structure (scope names, parent/child relationships), which `iter`/`mutating_events`
    /// deliberately flatten away.
    pub fn root(&self) -> NodeView<'_, E> {
        NodeView { tape: self, index: 0 }
    }
}

impl<E: DebugEvent> DebugTape<E> {
    /// Mutating events only, in linear (emission) order — independent of tree nesting.
    pub fn mutating_events(&self) -> impl Iterator<Item = &E> {
        self.iter().filter(|e| e.is_mutating())
    }
}

/// Encodes a single event's binary payload into the shared payload byte arena, returning its
/// stable wire tag. Kept separate from [`DebugEvent`] (which stays purely semantic — is this
/// event mutating or trace-only) so the binary wire format can evolve independently of the
/// event's meaning. Implemented per instrumented algorithm's event enum (see
/// `RecursiveBacktrackerEvent`'s impl for the encoding conventions).
///
/// `type_id` must return a stable, manually-assigned constant from a registry (never
/// `mem::discriminant` or `#[repr(u16)]` on the enum) — Rust's enum variant order/discriminant
/// is not part of the wire format and must be free to change without breaking already-encoded
/// tapes or out-of-sync core/web builds. `0` is reserved for scope nodes and must never be
/// returned here.
pub trait EncodeEventPayload {
    fn type_id(&self) -> u16;
    /// Appends this event's binary payload to `out` (little-endian, no padding/alignment).
    fn encode_payload(&self, out: &mut Vec<u8>);
}

/// Wire tag reserved for scope nodes (never used by an event's `type_id`).
pub const TAG_SCOPE: u16 = 0;

/// Sentinel for "no parent" / "no child" / "no next sibling" in an encoded [`NodeRecord`].
pub const NO_NODE: u32 = u32::MAX;

/// Byte size of one encoded [`NodeRecord`] in [`EncodedTape::node_table`] — the stride a reader
/// (Rust or JS `DataView`) must use to walk the flat node table.
pub const NODE_RECORD_SIZE: usize = 22; // 4 (parent) + 4 (first_child) + 4 (next_sibling) + 2 (tag) + 4 (payload_offset) + 4 (payload_len)

/// One node's encoded fields, as written into [`EncodedTape::node_table`] — logically fixed
/// fields, physically a flat byte stream (no `#[repr(C)]`/`unsafe` cast; see module docs on why).
struct NodeRecord {
    parent: u32,
    first_child: u32,
    next_sibling: u32,
    tag: u16,
    payload_offset: u32,
    payload_len: u32,
}

impl NodeRecord {
    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.parent.to_le_bytes());
        out.extend_from_slice(&self.first_child.to_le_bytes());
        out.extend_from_slice(&self.next_sibling.to_le_bytes());
        out.extend_from_slice(&self.tag.to_le_bytes());
        out.extend_from_slice(&self.payload_offset.to_le_bytes());
        out.extend_from_slice(&self.payload_len.to_le_bytes());
    }

    /// Decodes one record at `index` (by [`NODE_RECORD_SIZE`] stride) out of an
    /// [`EncodedTape::node_table`] — the read-side mirror of [`Self::write`], needed by
    /// [`merge_tapes`] to relink/renumber already-encoded records without redecoding events.
    fn read(node_table: &[u8], index: usize) -> Self {
        let base = index * NODE_RECORD_SIZE;
        let bytes = &node_table[base..base + NODE_RECORD_SIZE];
        Self {
            parent: u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            first_child: u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            next_sibling: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            tag: u16::from_le_bytes(bytes[12..14].try_into().unwrap()),
            payload_offset: u32::from_le_bytes(bytes[14..18].try_into().unwrap()),
            payload_len: u32::from_le_bytes(bytes[18..22].try_into().unwrap()),
        }
    }
}

/// Canonical binary encoding of a [`DebugTape`] — two flat buffers: a fixed-stride node table
/// (see [`NODE_RECORD_SIZE`]) and a single payload byte arena that both scope names (UTF-8) and
/// event payloads are written into (deduplicated for scope names — an implementation detail of
/// the encoder, not part of the wire format). This is the tape's canonical binary format,
/// independent of any particular transport (WASM, file, ...) — see GitHub issue #124.
#[derive(Clone)]
pub struct EncodedTape {
    pub node_table: Vec<u8>,
    pub payload: Vec<u8>,
}

impl<E: DebugEvent + EncodeEventPayload> DebugTape<E> {
    /// Encodes this tape into its canonical binary form (see [`EncodedTape`]).
    pub fn encode(&self) -> EncodedTape {
        let mut payload = Vec::new();
        let mut scope_name_offsets: std::collections::HashMap<&str, (u32, u32)> = std::collections::HashMap::new();

        let mut node_table = Vec::with_capacity(self.nodes.len() * NODE_RECORD_SIZE);
        for node in &self.nodes {
            let (tag, payload_offset, payload_len) = match &node.kind {
                NodeKind::Scope(name) => {
                    let &mut (offset, len) = scope_name_offsets.entry(name.as_ref()).or_insert_with(|| {
                        let offset = payload.len() as u32;
                        payload.extend_from_slice(name.as_bytes());
                        (offset, name.len() as u32)
                    });
                    (TAG_SCOPE, offset, len)
                }
                NodeKind::Event(event) => {
                    let offset = payload.len() as u32;
                    event.encode_payload(&mut payload);
                    let len = payload.len() as u32 - offset;
                    let type_id = event.type_id();
                    debug_assert_ne!(type_id, TAG_SCOPE, "EncodeEventPayload::type_id() must never return TAG_SCOPE (0) — it is reserved for scope nodes");
                    (type_id, offset, len)
                }
            };
            NodeRecord {
                parent: node.parent.unwrap_or(NO_NODE),
                first_child: node.first_child.unwrap_or(NO_NODE),
                next_sibling: node.next_sibling.unwrap_or(NO_NODE),
                tag,
                payload_offset,
                payload_len,
            }
            .write(&mut node_table);
        }

        EncodedTape { node_table, payload }
    }
}

/// Number of bits [`merge_tapes`] shifts a source's positional index into an already-encoded
/// [`NodeRecord`]'s `tag` — see the module-level "multi-source merge" docs above [`merge_tapes`].
pub const SOURCE_SHIFT: u32 = 8;
/// Mask isolating the source-index byte of a merged tag.
pub const SOURCE_MASK: u16 = 0xFF00;
/// Mask isolating the original per-source wire tag (`EncodeEventPayload::type_id()`'s value) of a
/// merged tag.
pub const LOCAL_TAG_MASK: u16 = 0x00FF;

/// One already-encoded tape to fold into [`merge_tapes`]'s combined arena — `scope_name` becomes
/// the label of this source's dedicated top-level child scope under the merged root.
pub struct TapeSource {
    pub scope_name: &'static str,
    pub tape: EncodedTape,
}

/// Merges several already-encoded, independently-produced tapes into one combined arena (GitHub
/// issue #169) — generation, QC, and (later) per-repair-strategy instrumentation all end up in one
/// `DebugTape`/arena per `generate()` call instead of one tape per source. Deliberately
/// domain-agnostic: takes only a scope name string per source, never
/// [`crate::generation::GenerationAlgorithm`]/[`EventedEventKind`]-shaped knowledge — mapping a
/// merged source's scope name to whichever concrete decoder it needs (e.g. the web replay engine's
/// `EventedEventKind`) is the caller's concern, not this function's.
///
/// Operates purely on already-encoded [`NodeRecord`]s — never re-decodes/re-encodes event payloads.
/// Each source keeps its own low-level wire tags (`EncodeEventPayload::type_id()`) completely
/// unchanged; only the already-written [`NodeRecord::tag`] byte layout gains a source-index prefix
/// (see [`SOURCE_SHIFT`]) so a reader can tell which source's decoder a merged event belongs to
/// without walking back up the tree to the nearest source scope. `payload` bytes are copied
/// as-is (concatenated), never reinterpreted.
///
/// Builds one new root, with one top-level child scope per source (named `scope_name`, in
/// `sources`' order) — **always**, including when `sources` has exactly one element: there is no
/// "skip wrapping for a single source" special case, so every caller (today: generation alone;
/// later: generation + QC + ...) sees the same tree shape regardless of how many sources are
/// actually present.
///
/// Every node index a caller may have captured against one of `sources`' original, unmerged
/// `EncodedTape`s becomes meaningless after merging — every index is renumbered.
///
/// `sources` must not be empty — an empty merge has no meaningful combined tree to build; the
/// caller must simply skip calling this function when there is nothing to merge (a `debug_assert!`
/// documents this rather than returning some placeholder empty tape).
pub fn merge_tapes(sources: Vec<TapeSource>) -> EncodedTape {
    debug_assert!(!sources.is_empty(), "merge_tapes called with no sources — caller should skip merging entirely instead");

    // Pass 1: figure out, for each source, the node-index / payload-byte offset its records will
    // land at in the combined arena (root + one top-level scope per source come first).
    let root_and_scopes_len = 1 + sources.len();
    let mut node_offsets = Vec::with_capacity(sources.len());
    let mut payload_offsets = Vec::with_capacity(sources.len());
    {
        let mut running_node_offset = root_and_scopes_len as u32;
        let mut running_payload_offset = 0u32;
        for source in &sources {
            node_offsets.push(running_node_offset);
            payload_offsets.push(running_payload_offset);
            running_node_offset += (source.tape.node_table.len() / NODE_RECORD_SIZE) as u32;
            running_payload_offset += source.tape.payload.len() as u32;
        }
    }

    let mut payload = Vec::new();
    for source in &sources {
        payload.extend_from_slice(&source.tape.payload);
    }

    // Root scope name is deduplicated with any source scope name below via the same
    // scope_name_offsets map DebugTape::encode uses for its own scope-name dedup.
    let mut scope_name_offsets: std::collections::HashMap<&str, (u32, u32)> = std::collections::HashMap::new();
    let mut intern_scope_name = |name: &'static str, payload: &mut Vec<u8>| -> (u32, u32) {
        *scope_name_offsets.entry(name).or_insert_with(|| {
            let offset = payload.len() as u32;
            payload.extend_from_slice(name.as_bytes());
            (offset, name.len() as u32)
        })
    };

    let mut node_table = Vec::new();

    // Node 0: the new merged root — first_child is node 1 (the first source's top-level scope),
    // last source's top-level scope has no next_sibling.
    let (root_offset, root_len) = intern_scope_name("root", &mut payload);
    NodeRecord {
        parent: NO_NODE,
        first_child: if sources.is_empty() { NO_NODE } else { 1 },
        next_sibling: NO_NODE,
        tag: TAG_SCOPE,
        payload_offset: root_offset,
        payload_len: root_len,
    }
    .write(&mut node_table);

    // Nodes 1..=sources.len(): one top-level scope per source, siblings of each other, each
    // pointing at its source's (relinked) former root as its own first_child.
    for (i, source) in sources.iter().enumerate() {
        let (offset, len) = intern_scope_name(source.scope_name, &mut payload);
        let former_root_relinked = if source.tape.node_table.is_empty() { None } else { Some(node_offsets[i]) };
        NodeRecord {
            parent: 0,
            first_child: former_root_relinked.unwrap_or(NO_NODE),
            next_sibling: if i + 1 < sources.len() { (i + 2) as u32 } else { NO_NODE },
            tag: TAG_SCOPE,
            payload_offset: offset,
            payload_len: len,
        }
        .write(&mut node_table);
    }

    // Relink every source's own records: shift parent/first_child/next_sibling by this source's
    // node offset (its former root becomes a child of this source's new top-level scope node,
    // whose index is root_and_scopes_len-adjusted below), shift payload_offset, and prefix tag
    // with the source's positional index — applied uniformly, including source_index == 0 (see
    // Specs/event_log.md's rationale: 0 << SOURCE_SHIFT == 0 is not "skipped", it's the correct
    // result for the first source).
    for (source_index, source) in sources.iter().enumerate() {
        let node_offset = node_offsets[source_index];
        let payload_offset = payload_offsets[source_index];
        let record_count = source.tape.node_table.len() / NODE_RECORD_SIZE;
        let source_tag_prefix = (source_index as u16) << SOURCE_SHIFT;

        let shift_link = |link: u32| -> u32 {
            if link == NO_NODE { NO_NODE } else { link + node_offset }
        };

        for local_index in 0..record_count {
            let mut record = NodeRecord::read(&source.tape.node_table, local_index);
            // The former root's parent (NO_NODE) must instead point at this source's new
            // top-level scope node (index 1 + source_index) rather than staying rootless.
            record.parent = if local_index == 0 { (1 + source_index) as u32 } else { shift_link(record.parent) };
            record.first_child = shift_link(record.first_child);
            record.next_sibling = shift_link(record.next_sibling);
            record.payload_offset += payload_offset;
            if record.tag != TAG_SCOPE {
                record.tag |= source_tag_prefix;
            }
            record.write(&mut node_table);
        }
    }

    EncodedTape { node_table, payload }
}

/// What a [`NodeView`] points at — either a named scope or a leaf event.
pub enum NodePayload<'a, E> {
    Scope(&'a str),
    Event(&'a E),
}

/// A handle onto one node in a [`DebugTape`]'s arena — the structural counterpart to
/// `iter()`'s flat event list. Exposes the tree shape (scope names, children, parent)
/// without exposing arena indices themselves, per #124's encapsulation constraint: callers
/// walk the tree through `NodeView` methods, never through a raw index into the backing
/// `Vec`.
pub struct NodeView<'a, E> {
    tape: &'a DebugTape<E>,
    index: u32,
}

impl<'a, E> Clone for NodeView<'a, E> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<'a, E> Copy for NodeView<'a, E> {}

impl<'a, E> NodeView<'a, E> {
    fn node(&self) -> &'a Node<E> {
        &self.tape.nodes[self.index as usize]
    }

    pub fn payload(&self) -> NodePayload<'a, E> {
        match &self.node().kind {
            NodeKind::Scope(name) => NodePayload::Scope(name),
            NodeKind::Event(e) => NodePayload::Event(e),
        }
    }

    pub fn parent(&self) -> Option<NodeView<'a, E>> {
        self.node().parent.map(|i| NodeView { tape: self.tape, index: i })
    }

    /// Children in emission order (first child first).
    pub fn children(&self) -> impl Iterator<Item = NodeView<'a, E>> {
        let tape = self.tape;
        let mut next = self.node().first_child;
        std::iter::from_fn(move || {
            let idx = next?;
            next = tape.nodes[idx as usize].next_sibling;
            Some(NodeView { tape, index: idx })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq)]
    enum TestEvent {
        Mutating(u32),
        Trace(u32),
    }

    impl DebugEvent for TestEvent {
        fn is_mutating(&self) -> bool {
            matches!(self, TestEvent::Mutating(_))
        }
    }

    const TEST_TAG_MUTATING: u16 = 1;
    const TEST_TAG_TRACE: u16 = 2;

    impl EncodeEventPayload for TestEvent {
        fn type_id(&self) -> u16 {
            match self {
                TestEvent::Mutating(_) => TEST_TAG_MUTATING,
                TestEvent::Trace(_) => TEST_TAG_TRACE,
            }
        }

        fn encode_payload(&self, out: &mut Vec<u8>) {
            let (TestEvent::Mutating(v) | TestEvent::Trace(v)) = self;
            out.extend_from_slice(&v.to_le_bytes());
        }
    }

    /// Decodes one [`NodeRecord`] at `index` (by [`NODE_RECORD_SIZE`] stride) out of an
    /// [`EncodedTape::node_table`] — mirrors how a reader (Rust test or JS `DataView`) walks the
    /// flat byte buffer.
    fn read_node_record(node_table: &[u8], index: usize) -> (u32, u32, u32, u16, u32, u32) {
        let base = index * NODE_RECORD_SIZE;
        let bytes = &node_table[base..base + NODE_RECORD_SIZE];
        let parent = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let first_child = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let next_sibling = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let tag = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
        let payload_offset = u32::from_le_bytes(bytes[14..18].try_into().unwrap());
        let payload_len = u32::from_le_bytes(bytes[18..22].try_into().unwrap());
        (parent, first_child, next_sibling, tag, payload_offset, payload_len)
    }

    #[test]
    fn emit_without_enter_lands_in_root_scope() {
        let mut log = EventLog::new();
        log.emit(TestEvent::Mutating(1));
        log.emit(TestEvent::Trace(2));

        let tape = log.finish();
        let all: Vec<_> = tape.iter().cloned().collect();
        assert_eq!(all, vec![TestEvent::Mutating(1), TestEvent::Trace(2)]);
    }

    #[test]
    fn nested_scopes_restore_cursor_on_drop() {
        let mut log = EventLog::new();
        {
            let mut g = log.enter("step");
            g.emit(TestEvent::Mutating(1));
            {
                let mut g2 = g.enter("roll");
                g2.emit(TestEvent::Trace(2));
            }
        }
        log.emit(TestEvent::Mutating(3));

        let tape = log.finish();
        let all: Vec<_> = tape.iter().cloned().collect();
        assert_eq!(
            all,
            vec![TestEvent::Mutating(1), TestEvent::Trace(2), TestEvent::Mutating(3)]
        );
    }

    #[test]
    fn mutating_events_preserve_linear_order_independent_of_nesting() {
        let mut log = EventLog::new();
        log.emit(TestEvent::Mutating(1));
        {
            let mut g = log.enter("step");
            g.emit(TestEvent::Trace(2));
            g.emit(TestEvent::Mutating(3));
            {
                let mut g2 = g.enter("roll");
                g2.emit(TestEvent::Mutating(4));
            }
        }
        log.emit(TestEvent::Mutating(5));

        let tape = log.finish();
        let mutating: Vec<_> = tape.mutating_events().cloned().collect();
        assert_eq!(
            mutating,
            vec![
                TestEvent::Mutating(1),
                TestEvent::Mutating(3),
                TestEvent::Mutating(4),
                TestEvent::Mutating(5)
            ]
        );
    }

    #[test]
    fn panic_inside_nested_scope_still_restores_cursor() {
        let mut log = EventLog::new();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut g = log.enter("step");
            g.emit(TestEvent::Mutating(1));
            let mut g2 = g.enter("roll");
            g2.emit(TestEvent::Mutating(2));
            panic!("boom");
        }));
        assert!(result.is_err());

        // Cursor must be back at root — a fresh top-level emit lands in the root scope,
        // not still nested under "step"/"roll".
        log.emit(TestEvent::Mutating(3));

        let tape = log.finish();
        let all: Vec<_> = tape.iter().cloned().collect();
        assert_eq!(
            all,
            vec![TestEvent::Mutating(1), TestEvent::Mutating(2), TestEvent::Mutating(3)]
        );
    }

    #[test]
    fn three_level_nesting_closes_in_correct_order() {
        let mut log = EventLog::new();
        {
            let mut g1 = log.enter("a");
            g1.emit(TestEvent::Mutating(1));
            {
                let mut g2 = g1.enter("b");
                g2.emit(TestEvent::Mutating(2));
                {
                    let mut g3 = g2.enter("c");
                    g3.emit(TestEvent::Mutating(3));
                }
            }
        }
        log.emit(TestEvent::Mutating(4));

        let tape = log.finish();
        let all: Vec<_> = tape.iter().cloned().collect();
        assert_eq!(
            all,
            vec![
                TestEvent::Mutating(1),
                TestEvent::Mutating(2),
                TestEvent::Mutating(3),
                TestEvent::Mutating(4)
            ]
        );
    }

    #[test]
    fn node_view_exposes_scope_names_and_children_in_order() {
        let mut log = EventLog::new();
        log.emit(TestEvent::Mutating(1));
        {
            let mut g = log.enter("step");
            g.emit(TestEvent::Trace(2));
            {
                let mut g2 = g.enter("roll");
                g2.emit(TestEvent::Mutating(3));
            }
        }

        let tape = log.finish();
        let root = tape.root();
        assert!(matches!(root.payload(), NodePayload::Scope("root")));

        let root_children: Vec<_> = root.children().collect();
        assert_eq!(root_children.len(), 2, "root has 2 children: the top-level event and the \"step\" scope");
        assert!(matches!(root_children[0].payload(), NodePayload::Event(TestEvent::Mutating(1))));
        assert!(matches!(root_children[1].payload(), NodePayload::Scope("step")));

        let step_children: Vec<_> = root_children[1].children().collect();
        assert_eq!(step_children.len(), 2, "\"step\" has 2 children: the trace event and the \"roll\" scope");
        assert!(matches!(step_children[0].payload(), NodePayload::Event(TestEvent::Trace(2))));
        assert!(matches!(step_children[1].payload(), NodePayload::Scope("roll")));

        let roll_children: Vec<_> = step_children[1].children().collect();
        assert_eq!(roll_children.len(), 1);
        assert!(matches!(roll_children[0].payload(), NodePayload::Event(TestEvent::Mutating(3))));

        // parent() walks back up correctly
        let roll_scope = step_children[1];
        assert!(matches!(roll_scope.parent().unwrap().payload(), NodePayload::Scope("step")));
        assert!(root.parent().is_none(), "root has no parent");

        // Event payload actually carries the right value, not just matching the variant shape.
        if let NodePayload::Event(e) = root_children[0].payload() {
            assert_eq!(*e, TestEvent::Mutating(1));
        } else {
            panic!("expected an event payload");
        }
    }

    #[test]
    fn default_is_equivalent_to_new() {
        let mut log: EventLog<TestEvent> = EventLog::default();
        log.emit(TestEvent::Mutating(1));
        let tape = log.finish();
        assert!(matches!(tape.root().payload(), NodePayload::Scope("root")));
        assert_eq!(tape.iter().cloned().collect::<Vec<_>>(), vec![TestEvent::Mutating(1)]);
    }

    #[test]
    fn four_siblings_in_a_row_preserve_emission_order() {
        // Mirrors the target granularity from issue #121: several sibling events emitted in
        // sequence under one scope (roll, compare, roll, distribution), not just pairs.
        let mut log = EventLog::new();
        {
            let mut g = log.enter("step");
            g.emit(TestEvent::Trace(1));
            g.emit(TestEvent::Trace(2));
            g.emit(TestEvent::Mutating(3));
            g.emit(TestEvent::Mutating(4));
        }

        let tape = log.finish();
        let step_children: Vec<_> = tape.root().children().next().unwrap().children().collect();
        assert_eq!(step_children.len(), 4);
        let payloads: Vec<TestEvent> = step_children
            .iter()
            .map(|n| match n.payload() {
                NodePayload::Event(e) => e.clone(),
                NodePayload::Scope(_) => panic!("expected only events"),
            })
            .collect();
        assert_eq!(
            payloads,
            vec![
                TestEvent::Trace(1),
                TestEvent::Trace(2),
                TestEvent::Mutating(3),
                TestEvent::Mutating(4)
            ]
        );
    }

    #[test]
    fn empty_scope_has_no_children() {
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let _g = log.enter("empty");
        }
        let tape = log.finish();
        let empty_scope = tape.root().children().next().unwrap();
        assert!(matches!(empty_scope.payload(), NodePayload::Scope("empty")));
        assert_eq!(empty_scope.children().count(), 0);
    }

    #[test]
    fn iter_skips_scopes_at_any_depth_when_no_events_are_emitted() {
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let mut g = log.enter("a");
            {
                let mut g2 = g.enter("b");
                let _g3 = g2.enter("c");
            }
        }
        let tape = log.finish();
        assert_eq!(tape.iter().count(), 0, "no events were emitted anywhere in the tree");
    }

    // --- enter_numbered() (GitHub issue #133) ---

    #[test]
    fn enter_numbered_increments_per_cursor_and_base_name() {
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let mut g = log.enter_numbered("step");
            g.emit(TestEvent::Mutating(1));
        }
        {
            let mut g = log.enter_numbered("step");
            g.emit(TestEvent::Mutating(2));
        }
        {
            let mut g = log.enter_numbered("roll");
            g.emit(TestEvent::Mutating(3));
        }

        let tape = log.finish();
        let names: Vec<&str> = tape
            .root()
            .children()
            .map(|c| match c.payload() {
                NodePayload::Scope(name) => name,
                NodePayload::Event(_) => panic!("expected only scopes"),
            })
            .collect();
        assert_eq!(names, vec!["step 1", "step 2", "roll 1"]);
    }

    #[test]
    fn enter_numbered_counts_independently_per_parent_scope() {
        // "step" scopes opened directly under two different parent cursors (root vs. a nested
        // "outer" scope) must number independently — the counter is keyed by (parent cursor,
        // base name), not by base name alone.
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let mut top_step = log.enter_numbered("step");
            top_step.emit(TestEvent::Mutating(1));
        }
        {
            let mut outer = log.enter_numbered("outer");
            let mut nested_step = outer.enter_numbered("step");
            nested_step.emit(TestEvent::Mutating(2));
        }

        let tape = log.finish();
        let root_children: Vec<_> = tape.root().children().collect();
        assert_eq!(root_children.len(), 2);
        assert!(matches!(root_children[0].payload(), NodePayload::Scope("step 1")));
        assert!(matches!(root_children[1].payload(), NodePayload::Scope("outer 1")));

        let nested_step = root_children[1].children().next().unwrap();
        assert!(
            matches!(nested_step.payload(), NodePayload::Scope("step 1")),
            "\"step\" nested under \"outer\" is a different parent cursor than root, so it numbers independently of the top-level \"step 1\""
        );
    }

    // --- resuming a parent ScopeGuard after a nested scope closes (GitHub issue #162) ---

    #[test]
    fn parent_guard_reusable_between_and_after_sibling_child_scopes() {
        // Mirrors Wilson's "walk" > "step 1", "step 2", ... shape (issue #145): a parent scope
        // stays open across several sibling child scopes, with emits into the parent both
        // between and after them, all through the same `parent` guard.
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let mut parent = log.enter("walk");
            parent.emit(TestEvent::Trace(0)); // before the first child
            for i in 1..=3 {
                {
                    let mut child = parent.enter_numbered("step");
                    child.emit(TestEvent::Mutating(i));
                } // child dropped here, releasing the borrow on `parent`
                parent.emit(TestEvent::Trace(i + 100)); // between/after each child
            }
        }

        let tape = log.finish();
        let walk = tape.root().children().next().unwrap();
        assert!(matches!(walk.payload(), NodePayload::Scope("walk")));

        let walk_children: Vec<_> = walk.children().collect();
        assert_eq!(walk_children.len(), 7, "1 leading event + 3 * (child scope + trailing event)");

        assert!(matches!(walk_children[0].payload(), NodePayload::Event(TestEvent::Trace(0))));
        for i in 1..=3u32 {
            let base = ((i - 1) * 2 + 1) as usize;
            let step_scope = walk_children[base];
            let expected_name = format!("step {i}");
            assert!(matches!(step_scope.payload(), NodePayload::Scope(name) if name == expected_name));
            let step_children: Vec<_> = step_scope.children().collect();
            assert_eq!(step_children.len(), 1);
            assert!(matches!(step_children[0].payload(), NodePayload::Event(TestEvent::Mutating(v)) if *v == i));

            // The trailing per-iteration event lands as `walk`'s direct child, not `step i`'s —
            // proof that `parent.emit` after the child drops reaches the right scope.
            assert!(matches!(
                walk_children[base + 1].payload(),
                NodePayload::Event(TestEvent::Trace(v)) if *v == i + 100
            ));
        }
    }

    // --- encode() (GitHub issue #124) ---

    #[test]
    fn encode_exact_sequence_on_small_deterministic_tree() {
        // root -> Mutating(1), "step" scope -> Trace(2), Mutating(3)
        let mut log = EventLog::new();
        log.emit(TestEvent::Mutating(1));
        {
            let mut g = log.enter("step");
            g.emit(TestEvent::Trace(2));
            g.emit(TestEvent::Mutating(3));
        }
        let tape = log.finish();
        let encoded = tape.encode();

        // 4 nodes: root scope, Mutating(1), "step" scope, Trace(2), Mutating(3) = 5 actually.
        assert_eq!(encoded.node_table.len(), 5 * NODE_RECORD_SIZE);

        // Node 0: root scope — no parent, first child is node 1, tag = TAG_SCOPE.
        let (parent, first_child, next_sibling, tag, payload_offset, payload_len) = read_node_record(&encoded.node_table, 0);
        assert_eq!((parent, next_sibling), (NO_NODE, NO_NODE));
        assert_eq!(first_child, 1);
        assert_eq!(tag, TAG_SCOPE);
        assert_eq!(&encoded.payload[payload_offset as usize..(payload_offset + payload_len) as usize], b"root");

        // Node 1: Mutating(1) — sibling is node 2 ("step" scope).
        let (parent, first_child, next_sibling, tag, payload_offset, payload_len) = read_node_record(&encoded.node_table, 1);
        assert_eq!(parent, 0);
        assert_eq!(first_child, NO_NODE);
        assert_eq!(next_sibling, 2);
        assert_eq!(tag, TEST_TAG_MUTATING);
        assert_eq!(payload_len, 4);
        assert_eq!(u32::from_le_bytes(encoded.payload[payload_offset as usize..(payload_offset + 4) as usize].try_into().unwrap()), 1);

        // Node 2: "step" scope — first child is node 3 (Trace(2)), no next sibling.
        let (parent, first_child, next_sibling, tag, payload_offset, payload_len) = read_node_record(&encoded.node_table, 2);
        assert_eq!(parent, 0);
        assert_eq!(first_child, 3);
        assert_eq!(next_sibling, NO_NODE);
        assert_eq!(tag, TAG_SCOPE);
        assert_eq!(&encoded.payload[payload_offset as usize..(payload_offset + payload_len) as usize], b"step");

        // Node 3: Trace(2) — sibling is node 4 (Mutating(3)).
        let (parent, first_child, next_sibling, tag, payload_offset, _payload_len) = read_node_record(&encoded.node_table, 3);
        assert_eq!(parent, 2);
        assert_eq!(first_child, NO_NODE);
        assert_eq!(next_sibling, 4);
        assert_eq!(tag, TEST_TAG_TRACE);
        assert_eq!(u32::from_le_bytes(encoded.payload[payload_offset as usize..(payload_offset + 4) as usize].try_into().unwrap()), 2);

        // Node 4: Mutating(3) — last child of "step", no siblings.
        let (parent, first_child, next_sibling, tag, payload_offset, _payload_len) = read_node_record(&encoded.node_table, 4);
        assert_eq!(parent, 2);
        assert_eq!((first_child, next_sibling), (NO_NODE, NO_NODE));
        assert_eq!(tag, TEST_TAG_MUTATING);
        assert_eq!(u32::from_le_bytes(encoded.payload[payload_offset as usize..(payload_offset + 4) as usize].try_into().unwrap()), 3);
    }

    #[test]
    fn encode_root_has_no_parent_and_no_next_sibling_sentinels() {
        let mut log: EventLog<TestEvent> = EventLog::new();
        log.emit(TestEvent::Mutating(1));
        let tape = log.finish();
        let encoded = tape.encode();

        let (parent, _, next_sibling, ..) = read_node_record(&encoded.node_table, 0);
        assert_eq!(parent, NO_NODE);
        assert_eq!(next_sibling, NO_NODE);
    }

    #[test]
    fn encode_leaf_event_has_no_child_sentinel() {
        let mut log: EventLog<TestEvent> = EventLog::new();
        log.emit(TestEvent::Mutating(1));
        let tape = log.finish();
        let encoded = tape.encode();

        let (_, first_child, ..) = read_node_record(&encoded.node_table, 1);
        assert_eq!(first_child, NO_NODE);
    }

    #[test]
    fn encode_dedups_repeated_scope_names_to_same_payload_offset() {
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let mut g = log.enter("step");
            g.emit(TestEvent::Mutating(1));
        }
        {
            let mut g = log.enter("step");
            g.emit(TestEvent::Mutating(2));
        }
        let tape = log.finish();
        let encoded = tape.encode();

        let (_, _, _, _, offset_a, len_a) = read_node_record(&encoded.node_table, 1); // first "step" scope
        let (_, _, _, _, offset_b, len_b) = read_node_record(&encoded.node_table, 3); // second "step" scope
        assert_eq!((offset_a, len_a), (offset_b, len_b), "repeated scope name must reuse the same payload slice");
        // Payload arena holds "root" once + "step" once (4 bytes each) plus two 4-byte u32 event payloads = 16 bytes.
        assert_eq!(encoded.payload.len(), 16);
    }

    #[test]
    fn encode_variable_length_payload_round_trips_through_node_view() {
        // Mirrors RecursiveBacktrackerEvent::CandidatesComputed's encoding shape (len-prefixed
        // list) using a local variable-length test event, since TestEvent itself is fixed-shape.
        #[derive(Debug, Clone, PartialEq)]
        enum ListEvent {
            Ids(Vec<u32>),
        }
        impl DebugEvent for ListEvent {
            fn is_mutating(&self) -> bool { false }
        }
        impl EncodeEventPayload for ListEvent {
            fn type_id(&self) -> u16 { 1 }
            fn encode_payload(&self, out: &mut Vec<u8>) {
                let ListEvent::Ids(ids) = self;
                out.extend_from_slice(&(ids.len() as u32).to_le_bytes());
                for id in ids {
                    out.extend_from_slice(&id.to_le_bytes());
                }
            }
        }

        let mut log: EventLog<ListEvent> = EventLog::new();
        log.emit(ListEvent::Ids(vec![10, 20, 30]));
        let tape = log.finish();
        let encoded = tape.encode();

        let (_, _, _, tag, payload_offset, payload_len) = read_node_record(&encoded.node_table, 1);
        assert_eq!(tag, 1);
        assert_eq!(payload_len, 4 + 3 * 4); // len prefix + 3 u32s

        let bytes = &encoded.payload[payload_offset as usize..(payload_offset + payload_len) as usize];
        let len = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        assert_eq!(len, 3);
        let ids: Vec<u32> = bytes[4..].chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        assert_eq!(ids, vec![10, 20, 30]);
    }
}

// --- merge_tapes() (GitHub issue #169) ---

#[cfg(test)]
mod merge_tapes_tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq)]
    enum FixtureEvent {
        Mutating(u32),
        Trace(u32),
    }

    impl DebugEvent for FixtureEvent {
        fn is_mutating(&self) -> bool {
            matches!(self, FixtureEvent::Mutating(_))
        }
    }

    const FIXTURE_TAG_MUTATING: u16 = 1;
    const FIXTURE_TAG_TRACE: u16 = 2;

    impl EncodeEventPayload for FixtureEvent {
        fn type_id(&self) -> u16 {
            match self {
                FixtureEvent::Mutating(_) => FIXTURE_TAG_MUTATING,
                FixtureEvent::Trace(_) => FIXTURE_TAG_TRACE,
            }
        }

        fn encode_payload(&self, out: &mut Vec<u8>) {
            let (FixtureEvent::Mutating(v) | FixtureEvent::Trace(v)) = self;
            out.extend_from_slice(&v.to_le_bytes());
        }
    }

    fn read_node_record(node_table: &[u8], index: usize) -> (u32, u32, u32, u16, u32, u32) {
        let record = NodeRecord::read(node_table, index);
        (record.parent, record.first_child, record.next_sibling, record.tag, record.payload_offset, record.payload_len)
    }

    /// A one-scope-one-event tape: root -> "step" scope -> Mutating(value). Mirrors the shape
    /// every real algorithm's tape has (a root scope with content beneath it), not a bare single
    /// event directly on root — so relinking the former root's parent/children is actually
    /// exercised.
    fn fixture_tape(value: u32) -> (EncodedTape, u32 /* node count */) {
        let mut log: EventLog<FixtureEvent> = EventLog::new();
        {
            let mut g = log.enter("step");
            g.emit(FixtureEvent::Mutating(value));
            g.emit(FixtureEvent::Trace(value + 1));
        }
        let tape = log.finish();
        let encoded = tape.encode();
        let count = (encoded.node_table.len() / NODE_RECORD_SIZE) as u32;
        (encoded, count)
    }

    #[test]
    fn single_source_still_gets_wrapped_in_root_and_source_scope() {
        // No special-casing for exactly one source — merge always adds root + one top-level
        // scope, even when there's only one source to wrap (per explicit product decision).
        let (tape, node_count) = fixture_tape(10);
        assert_eq!(node_count, 4, "root(step-tape) + step scope + Mutating + Trace = 4 nodes in the unmerged tape");

        let merged = merge_tapes(vec![TapeSource { scope_name: "generation", tape }]);

        // Node 0: new merged root, first_child = 1 (the "generation" top-level scope).
        let (parent, first_child, next_sibling, tag, _, _) = read_node_record(&merged.node_table, 0);
        assert_eq!((parent, next_sibling), (NO_NODE, NO_NODE));
        assert_eq!(first_child, 1);
        assert_eq!(tag, TAG_SCOPE);

        // Node 1: "generation" top-level scope, parent = 0 (new root), first_child = 2 (former
        // root of the source tape, relinked), no next_sibling (only one source).
        let (parent, first_child, next_sibling, tag, offset, len) = read_node_record(&merged.node_table, 1);
        assert_eq!(parent, 0);
        assert_eq!(first_child, 2);
        assert_eq!(next_sibling, NO_NODE);
        assert_eq!(tag, TAG_SCOPE);
        assert_eq!(&merged.payload[offset as usize..(offset + len) as usize], b"generation");

        // Node 2: the former root ("root" scope of the source tape), now parented under node 1
        // instead of being rootless.
        let (parent, _, _, tag, ..) = read_node_record(&merged.node_table, 2);
        assert_eq!(parent, 1);
        assert_eq!(tag, TAG_SCOPE);
    }

    #[test]
    fn source_index_zero_tag_is_masked_the_same_way_as_any_other_source() {
        // source_index == 0 means `0 << SOURCE_SHIFT == 0` — the resulting tag numerically equals
        // the original local tag, but only because of the shift math, not because masking was
        // skipped. A decoder must always apply the mask/shift, never assume "first source needs
        // no unpacking".
        let (tape, _) = fixture_tape(10);
        let merged = merge_tapes(vec![TapeSource { scope_name: "generation", tape }]);

        // Layout: 0=merged root, 1="generation" scope, 2=former root("root"), 3=former "step"
        // scope, 4=Mutating(10), 5=Trace(11).
        let (_, _, _, tag, ..) = read_node_record(&merged.node_table, 4);
        assert_eq!(tag & SOURCE_MASK, 0, "source_index 0 must produce a zero source-mask nibble");
        assert_eq!(tag & LOCAL_TAG_MASK, FIXTURE_TAG_MUTATING, "local tag must survive unchanged under the mask");
        assert_eq!(tag, FIXTURE_TAG_MUTATING, "numerically the merged tag equals the local tag for source 0, per SOURCE_SHIFT math");
    }

    #[test]
    fn second_source_gets_a_nonzero_source_prefix_and_first_source_stays_untouched() {
        let (tape_a, _) = fixture_tape(10);
        let (tape_b, _) = fixture_tape(20);
        let merged = merge_tapes(vec![
            TapeSource { scope_name: "generation", tape: tape_a },
            TapeSource { scope_name: "quality_control", tape: tape_b },
        ]);

        // Layout: 0=root, 1="generation" scope, 2="quality_control" scope,
        // 3=former-root-of-a("root"), 4="step"(a), 5=Mutating(10), 6=Trace(11),
        // 7=former-root-of-b("root"), 8="step"(b), 9=Mutating(20), 10=Trace(21).
        let (_, _, _, tag_a, ..) = read_node_record(&merged.node_table, 5);
        assert_eq!(tag_a & SOURCE_MASK, 0);
        assert_eq!(tag_a & LOCAL_TAG_MASK, FIXTURE_TAG_MUTATING);

        let (_, _, _, tag_b, ..) = read_node_record(&merged.node_table, 9);
        assert_eq!((tag_b & SOURCE_MASK) >> SOURCE_SHIFT, 1, "second source must carry source_index 1 in its tag prefix");
        assert_eq!(tag_b & LOCAL_TAG_MASK, FIXTURE_TAG_MUTATING, "local tag itself must be unchanged");
        assert_ne!(tag_a, tag_b, "same local tag from two different sources must decode to different raw tags");
    }

    #[test]
    fn tag_scope_is_never_namespaced() {
        let (tape_a, _) = fixture_tape(10);
        let (tape_b, _) = fixture_tape(20);
        let merged = merge_tapes(vec![
            TapeSource { scope_name: "generation", tape: tape_a },
            TapeSource { scope_name: "quality_control", tape: tape_b },
        ]);

        // Every scope node (root, both top-level scopes, both former roots, both "step" scopes)
        // must keep tag == TAG_SCOPE (0) regardless of which source it belongs to.
        for index in [0usize, 1, 2, 3, 4, 7, 8] {
            let (_, _, _, tag, ..) = read_node_record(&merged.node_table, index);
            assert_eq!(tag, TAG_SCOPE, "node {index} is a scope and must never be namespaced");
        }
    }

    #[test]
    fn payload_bytes_are_copied_verbatim_not_reencoded() {
        let (tape_a, _) = fixture_tape(10);
        let (tape_b, _) = fixture_tape(20);
        let original_a_payload = tape_a.payload.clone();
        let original_b_payload = tape_b.payload.clone();

        let merged = merge_tapes(vec![
            TapeSource { scope_name: "generation", tape: tape_a },
            TapeSource { scope_name: "quality_control", tape: tape_b },
        ]);

        // The merged payload arena holds each source's payload bytes concatenated verbatim first
        // (source a, then source b, untouched), followed by the merge's own new top-level scope
        // names ("root", "generation", "quality_control" — interned after the sources' bytes).
        assert_eq!(&merged.payload[0..original_a_payload.len()], &original_a_payload[..]);
        assert_eq!(&merged.payload[original_a_payload.len()..original_a_payload.len() + original_b_payload.len()], &original_b_payload[..]);
    }

    #[test]
    #[should_panic(expected = "merge_tapes called with no sources")]
    fn merge_tapes_panics_on_empty_sources_in_debug_builds() {
        // Guards the `debug_assert!` documenting the "caller must not call this with nothing to
        // merge" contract — every real caller (generate_maze_with_events) always supplies at
        // least one source, but nothing at the type level stops a future caller from passing an
        // empty Vec by mistake; this must fail loudly rather than silently building a rootless,
        // childless merged tape.
        merge_tapes(Vec::new());
    }

    #[test]
    fn single_source_with_an_empty_node_table_gets_no_child_and_relinks_nothing() {
        // A source whose `EncodedTape` has no records at all (hypothetically possible if a
        // caller handed merge_tapes something other than a real DebugTape::encode() output,
        // which always emits at least the root scope) — the top-level source scope must not
        // point at a nonexistent former-root node, and the relink pass over 0 records is a no-op.
        let empty_tape = EncodedTape { node_table: Vec::new(), payload: Vec::new() };
        let merged = merge_tapes(vec![TapeSource { scope_name: "generation", tape: empty_tape }]);

        // Node 0: merged root, first_child = 1 ("generation" scope) as usual.
        let (_, first_child, _, _, _, _) = read_node_record(&merged.node_table, 0);
        assert_eq!(first_child, 1);

        // Node 1: "generation" scope has no first_child (NO_NODE) — nothing to relink to.
        let (_, first_child, next_sibling, tag, ..) = read_node_record(&merged.node_table, 1);
        assert_eq!(first_child, NO_NODE, "an empty source's top-level scope must not point at a nonexistent former root");
        assert_eq!(next_sibling, NO_NODE);
        assert_eq!(tag, TAG_SCOPE);
        assert_eq!(merged.node_table.len() / NODE_RECORD_SIZE, 2, "only the merged root and the top-level scope exist — no former root, no content");
    }
}
