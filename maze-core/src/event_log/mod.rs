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

    fn emit_inner(&mut self, event: E) {
        self.push_child(NodeKind::Event(event));
    }

    /// Emits an event directly into the current cursor's scope (the root scope, if no
    /// guard is open) without opening a nested scope for it.
    pub fn emit(&mut self, event: E) {
        self.emit_inner(event);
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
    pub fn emit(&mut self, event: E) {
        self.log.emit_inner(event);
    }

    /// Opens a nested scope under this one, consuming this guard. Only one guard can be
    /// alive at a time by construction (the borrow checker enforces it): opening a nested
    /// scope "moves into" the child guard, and the parent scope is only usable again once
    /// every descendant guard has been dropped.
    pub fn enter(self, name: impl Into<Cow<'static, str>>) -> ScopeGuard<'a, E> {
        // `self` implements `Drop`, so its `log` field can't be moved out normally.
        // Wrapping in `ManuallyDrop` suppresses `self`'s destructor (which would otherwise
        // reset `cursor` back to *this* guard's parent right after the nested `enter` below
        // moves it to the new child — clobbering the correct cursor). The single `unsafe`
        // block reads `log` out exactly once; `this` is never touched again afterwards, so
        // there is no double-drop and no access through an already-moved-from field.
        let this = std::mem::ManuallyDrop::new(self);
        let log: &'a mut EventLog<E> = unsafe { std::ptr::read(&this.log) };
        log.enter(name)
    }

    /// Nested-scope counterpart to [`EventLog::enter_numbered`] — see its docs for the naming
    /// scheme. Consumes this guard the same way [`ScopeGuard::enter`] does.
    pub fn enter_numbered(self, base_name: &str) -> ScopeGuard<'a, E> {
        let this = std::mem::ManuallyDrop::new(self);
        let log: &'a mut EventLog<E> = unsafe { std::ptr::read(&this.log) };
        log.enter_numbered(base_name)
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
}

/// Canonical binary encoding of a [`DebugTape`] — two flat buffers: a fixed-stride node table
/// (see [`NODE_RECORD_SIZE`]) and a single payload byte arena that both scope names (UTF-8) and
/// event payloads are written into (deduplicated for scope names — an implementation detail of
/// the encoder, not part of the wire format). This is the tape's canonical binary format,
/// independent of any particular transport (WASM, file, ...) — see GitHub issue #124.
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
            let g = log.enter("a");
            {
                let g2 = g.enter("b");
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
            let outer = log.enter_numbered("outer");
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
