//! Canonical binary wire format for a [`DebugTape`] — see [`EncodedTape`]. Kept separate from
//! [`DebugEvent`] (which stays purely semantic) so the binary encoding can evolve independently
//! of an event's meaning.

use super::tape::{DebugEvent, DebugTape, NodeKind};

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
pub(super) struct NodeRecord {
    pub(super) parent: u32,
    pub(super) first_child: u32,
    pub(super) next_sibling: u32,
    pub(super) tag: u16,
    pub(super) payload_offset: u32,
    pub(super) payload_len: u32,
}

impl NodeRecord {
    pub(super) fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.parent.to_le_bytes());
        out.extend_from_slice(&self.first_child.to_le_bytes());
        out.extend_from_slice(&self.next_sibling.to_le_bytes());
        out.extend_from_slice(&self.tag.to_le_bytes());
        out.extend_from_slice(&self.payload_offset.to_le_bytes());
        out.extend_from_slice(&self.payload_len.to_le_bytes());
    }

    /// Decodes one record at `index` (by [`NODE_RECORD_SIZE`] stride) out of an
    /// [`EncodedTape::node_table`] — the read-side mirror of [`Self::write`], needed by
    /// [`super::merge::merge_tapes`] to relink/renumber already-encoded records without redecoding events.
    pub(super) fn read(node_table: &[u8], index: usize) -> Self {
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

/// Interns scope names into a shared payload byte arena, deduplicating repeats to the same
/// `(offset, len)` slice — the encoder-side dedup used by both [`DebugTape::encode`] and
/// [`super::merge::merge_tapes`] so a scope name written once is never duplicated in the arena
/// regardless of how many nodes (or sources) share it.
pub(super) struct ScopeNameInterner<'a> {
    offsets: std::collections::HashMap<&'a str, (u32, u32)>,
}

impl<'a> ScopeNameInterner<'a> {
    pub(super) fn new() -> Self {
        Self { offsets: std::collections::HashMap::new() }
    }

    pub(super) fn intern(&mut self, name: &'a str, payload: &mut Vec<u8>) -> (u32, u32) {
        *self.offsets.entry(name).or_insert_with(|| {
            let offset = payload.len() as u32;
            payload.extend_from_slice(name.as_bytes());
            (offset, name.len() as u32)
        })
    }
}

impl<E: DebugEvent + EncodeEventPayload> DebugTape<E> {
    /// Encodes this tape into its canonical binary form (see [`EncodedTape`]).
    pub fn encode(&self) -> EncodedTape {
        let mut payload = Vec::new();
        let mut interner = ScopeNameInterner::new();

        let mut node_table = Vec::with_capacity(self.nodes.len() * NODE_RECORD_SIZE);
        for node in &self.nodes {
            let (tag, payload_offset, payload_len) = match &node.kind {
                NodeKind::Scope(name) => {
                    let (offset, len) = interner.intern(name.as_ref(), &mut payload);
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

#[cfg(test)]
mod tests {
    use super::super::tape::EventLog;
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
        let record = NodeRecord::read(node_table, index);
        (record.parent, record.first_child, record.next_sibling, record.tag, record.payload_offset, record.payload_len)
    }

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
