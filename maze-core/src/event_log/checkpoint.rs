//! Intermediate snapshot checkpointing for the debug event tree (GitHub issue #128). Lets a
//! replay consumer reconstruct state at a late arena node index without replaying every
//! mutating event from the start of the tape.
//!
//! Deliberately independent of [`super::EventLog`]/[`super::DebugTape`]/[`super::Node`] — this
//! module doesn't know what a "snapshot" contains (that's algorithm-specific, e.g. Recursive
//! Backtracker's accumulated edge list); it only stores opaque byte payloads indexed by arena
//! node index. It lives under `event_log/` because it mirrors `EncodedTape`'s POD-buffer
//! transport mechanics (same WASM zero-copy story), not because it depends on the arena type.

/// Byte size of one encoded [`CheckpointRecord`] in [`EncodedCheckpoints::table`].
pub const CHECKPOINT_RECORD_SIZE: usize = 12; // 4 (node_index) + 4 (offset) + 4 (len)

struct CheckpointRecord {
    node_index: u32,
    offset: u32,
    len: u32,
}

impl CheckpointRecord {
    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.node_index.to_le_bytes());
        out.extend_from_slice(&self.offset.to_le_bytes());
        out.extend_from_slice(&self.len.to_le_bytes());
    }
}

/// Builder for a checkpoint table — a caller (e.g. Recursive Backtracker) pushes an opaque
/// snapshot payload every so often during generation, tagged with the arena node index of the
/// mutating event it corresponds to.
///
/// **Invariant**: [`Self::push`] must be called with a strictly increasing `node_index` across
/// calls — checkpoints are recorded in the same order generation produces mutating events, so
/// this holds by construction for a well-behaved caller. Violating it is a caller bug, not a
/// recoverable condition: [`Self::push`] `assert!`s on it (a real assert, not `debug_assert!` —
/// the check is O(1) and the alternative is a release/WASM build silently encoding an unsorted
/// table whose binary-search precondition on the web side doesn't hold, producing a wrong
/// reconstructed maze state with no visible failure) rather than [`Self::encode`] silently sorting.
#[derive(Default)]
pub struct CheckpointLog {
    records: Vec<CheckpointRecord>,
    payload: Vec<u8>,
}

impl CheckpointLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one checkpoint: `bytes` is an opaque snapshot payload, `node_index` is the arena
    /// index of the mutating event this snapshot reflects state up to and including.
    pub fn push(&mut self, node_index: u32, bytes: &[u8]) {
        if let Some(last) = self.records.last() {
            assert!(
                node_index > last.node_index,
                "CheckpointLog::push called with non-increasing node_index ({node_index} after {})",
                last.node_index
            );
        }
        let offset = self.payload.len() as u32;
        self.payload.extend_from_slice(bytes);
        self.records.push(CheckpointRecord { node_index, offset, len: bytes.len() as u32 });
    }

    /// Encodes this log into its canonical binary form — a flat, fixed-stride table (see
    /// [`CHECKPOINT_RECORD_SIZE`]) sorted by ascending `node_index` (guaranteed by [`Self::push`]'s
    /// invariant, not re-sorted here) plus a single payload byte arena.
    pub fn encode(&self) -> EncodedCheckpoints {
        let mut table = Vec::with_capacity(self.records.len() * CHECKPOINT_RECORD_SIZE);
        for record in &self.records {
            record.write(&mut table);
        }
        EncodedCheckpoints { table, payload: self.payload.clone() }
    }
}

/// Canonical binary encoding of a [`CheckpointLog`] — see [`CheckpointLog::encode`].
pub struct EncodedCheckpoints {
    pub table: Vec<u8>,
    pub payload: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_record(table: &[u8], index: usize) -> (u32, u32, u32) {
        let base = index * CHECKPOINT_RECORD_SIZE;
        let bytes = &table[base..base + CHECKPOINT_RECORD_SIZE];
        (
            u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
        )
    }

    #[test]
    fn empty_log_encodes_to_empty_buffers() {
        let log = CheckpointLog::new();
        let encoded = log.encode();
        assert!(encoded.table.is_empty());
        assert!(encoded.payload.is_empty());
    }

    #[test]
    fn single_push_round_trips() {
        let mut log = CheckpointLog::new();
        log.push(5, &[1, 2, 3]);
        let encoded = log.encode();

        assert_eq!(encoded.table.len(), CHECKPOINT_RECORD_SIZE);
        let (node_index, offset, len) = read_record(&encoded.table, 0);
        assert_eq!(node_index, 5);
        assert_eq!(&encoded.payload[offset as usize..(offset + len) as usize], &[1, 2, 3]);
    }

    #[test]
    fn multiple_pushes_preserve_order_and_distinct_payload_slices() {
        let mut log = CheckpointLog::new();
        log.push(10, &[1, 2]);
        log.push(20, &[3, 4, 5]);
        log.push(30, &[]);
        let encoded = log.encode();

        assert_eq!(encoded.table.len(), 3 * CHECKPOINT_RECORD_SIZE);

        let (idx0, off0, len0) = read_record(&encoded.table, 0);
        assert_eq!((idx0, len0), (10, 2));
        assert_eq!(&encoded.payload[off0 as usize..(off0 + len0) as usize], &[1, 2]);

        let (idx1, off1, len1) = read_record(&encoded.table, 1);
        assert_eq!((idx1, len1), (20, 3));
        assert_eq!(&encoded.payload[off1 as usize..(off1 + len1) as usize], &[3, 4, 5]);

        let (idx2, _off2, len2) = read_record(&encoded.table, 2);
        assert_eq!((idx2, len2), (30, 0));
    }

    #[test]
    #[should_panic(expected = "non-increasing node_index")]
    fn push_with_equal_node_index_panics() {
        let mut log = CheckpointLog::new();
        log.push(10, &[1]);
        log.push(10, &[2]);
    }

    #[test]
    #[should_panic(expected = "non-increasing node_index")]
    fn push_with_decreasing_node_index_panics() {
        let mut log = CheckpointLog::new();
        log.push(10, &[1]);
        log.push(5, &[2]);
    }
}
