use wasm_bindgen::prelude::*;

/// Return type of `generate()` (GitHub issue #124). Wraps the existing `MazeSnapshot` (unchanged
/// — still one `serde_wasm_bindgen`-serialized `JsValue`) alongside an optional debug event tape,
/// encoded as two flat byte buffers (see `maze_core::event_log::DebugTape::encode`) — populated
/// only when `GenerateConfig.debug_events` is set. `None` when the debug event tree wasn't built
/// (no cost beyond the two `None`s on the normal/non-debug path).
///
/// A third, independent pair of buffers carries intermediate snapshot checkpoints (GitHub issue
/// #128, see `maze_core::event_log::CheckpointLog::encode`) — populated whenever the debug event
/// tape is (both come from the same Recursive Backtracker run), attached separately via
/// [`Self::with_checkpoints`] rather than folded into `with_debug_tape`'s parameters, so the two
/// concerns (event tree transfer vs. checkpoint transfer) stay independently constructible.
#[wasm_bindgen]
pub struct GenerateResult {
    snapshot: JsValue,
    node_table: Option<Vec<u8>>,
    payload: Option<Vec<u8>>,
    snapshot_table: Option<Vec<u8>>,
    snapshot_payload: Option<Vec<u8>>,
}

impl GenerateResult {
    pub fn without_debug_tape(snapshot: JsValue) -> Self {
        Self { snapshot, node_table: None, payload: None, snapshot_table: None, snapshot_payload: None }
    }

    pub fn with_debug_tape(snapshot: JsValue, node_table: Vec<u8>, payload: Vec<u8>) -> Self {
        Self { snapshot, node_table: Some(node_table), payload: Some(payload), snapshot_table: None, snapshot_payload: None }
    }

    /// Attaches checkpoint buffers to an already-built result — must be chained onto
    /// `with_debug_tape` specifically, e.g. `GenerateResult::with_debug_tape(...).with_checkpoints(table, payload)`,
    /// never onto `without_debug_tape`. Checkpoints are only ever produced alongside a debug event
    /// tape (both come from the same Recursive Backtracker run — see `EventedGenerationResult`'s
    /// `tape`/`checkpoints` fields on the core side), so a `GenerateResult` with checkpoints but no
    /// tape would contradict that invariant; asserted here rather than left to caller discipline.
    ///
    /// Also asserts `snapshot_table`'s length is a whole number of `CHECKPOINT_RECORD_SIZE`
    /// records — currently always true for the only caller (`runner.rs`, which passes
    /// `CheckpointLog::encode()`'s output straight through), but a real `assert!` (not
    /// `debug_assert!`) catches a malformed buffer here rather than letting it silently propagate
    /// to the web side, which would misinterpret record boundaries in `parseCheckpoints`.
    pub fn with_checkpoints(mut self, snapshot_table: Vec<u8>, snapshot_payload: Vec<u8>) -> Self {
        assert!(
            self.node_table.is_some() && self.payload.is_some(),
            "GenerateResult::with_checkpoints called without a debug tape — checkpoints require \
             with_debug_tape to have been called first (see EventedGenerationResult's tape/checkpoints pairing)"
        );
        assert_eq!(
            snapshot_table.len() % maze_core::event_log::CHECKPOINT_RECORD_SIZE, 0,
            "GenerateResult::with_checkpoints: snapshot_table length {} is not a whole number of CHECKPOINT_RECORD_SIZE ({}) records",
            snapshot_table.len(), maze_core::event_log::CHECKPOINT_RECORD_SIZE
        );
        self.snapshot_table = Some(snapshot_table);
        self.snapshot_payload = Some(snapshot_payload);
        self
    }
}

#[cfg(test)]
impl GenerateResult {
    /// Test-only accessors for the raw buffers — avoids exercising the `#[wasm_bindgen]`
    /// `js_sys::Uint8Array`/`unsafe` view path (which needs a real WASM linear memory, not
    /// available under `cargo test`'s host target) while still letting native tests assert on
    /// presence/contents of the debug tape.
    pub(crate) fn debug_tape_bytes(&self) -> Option<(&[u8], &[u8])> {
        match (&self.node_table, &self.payload) {
            (Some(nodes), Some(payload)) => Some((nodes, payload)),
            (None, None) => None,
            _ => panic!("GenerateResult: node_table/payload must always be Some/None together (see without_debug_tape/with_debug_tape)"),
        }
    }

    /// Test-only accessor for the raw checkpoint buffers — see [`Self::debug_tape_bytes`].
    pub(crate) fn checkpoint_bytes(&self) -> Option<(&[u8], &[u8])> {
        match (&self.snapshot_table, &self.snapshot_payload) {
            (Some(table), Some(payload)) => Some((table, payload)),
            (None, None) => None,
            _ => panic!("GenerateResult: snapshot_table/snapshot_payload must always be Some/None together (see with_checkpoints)"),
        }
    }
}

#[wasm_bindgen]
impl GenerateResult {
    /// The maze snapshot — same `MazeSnapshot` shape `generate()` returned directly before issue
    /// #124. Cloning a `JsValue` clones the handle to the already-serialized JS object, not a
    /// re-serialization — safe to call more than once.
    #[wasm_bindgen(js_name = snapshot)]
    pub fn snapshot(&self) -> JsValue {
        self.snapshot.clone()
    }

    /// Zero-copy view of the debug event tree's node table (see
    /// `maze_core::event_log::NODE_RECORD_SIZE`/`NodeRecord`), or `undefined` if
    /// `debug_events` wasn't enabled for this `generate()` call.
    ///
    /// ⚠️ The returned `Uint8Array` is a *view* directly into WASM linear memory, not a copy —
    /// it is invalidated ("detached buffer") by the next `memory.grow` (which can be triggered
    /// by any subsequent call into this WASM module, including another `generate()`). Callers
    /// must read/copy its contents synchronously before making another WASM call.
    #[wasm_bindgen(js_name = debugTapeNodeTable)]
    pub fn debug_tape_node_table(&self) -> Option<js_sys::Uint8Array> {
        // SAFETY: the view borrows `self.node_table`'s backing allocation directly out of WASM
        // linear memory. It stays valid as long as `self` (and thus the `Vec<u8>`) is alive and
        // the memory isn't grown/reallocated in between — see the doc comment above for the
        // caller-side contract this depends on.
        self.node_table.as_deref().map(|bytes| unsafe { js_sys::Uint8Array::view(bytes) })
    }

    /// Zero-copy view of the debug event tree's payload byte arena — same lifetime/detachment
    /// caveat as [`Self::debug_tape_node_table`].
    #[wasm_bindgen(js_name = debugTapePayload)]
    pub fn debug_tape_payload(&self) -> Option<js_sys::Uint8Array> {
        // SAFETY: see `debug_tape_node_table`.
        self.payload.as_deref().map(|bytes| unsafe { js_sys::Uint8Array::view(bytes) })
    }

    /// Zero-copy view of the intermediate snapshot checkpoint table (GitHub issue #128, see
    /// `maze_core::event_log::CHECKPOINT_RECORD_SIZE`), or `undefined` if no checkpoints were
    /// recorded for this `generate()` call. Same detachment caveat as [`Self::debug_tape_node_table`].
    #[wasm_bindgen(js_name = debugSnapshotTable)]
    pub fn debug_snapshot_table(&self) -> Option<js_sys::Uint8Array> {
        // SAFETY: see `debug_tape_node_table`.
        self.snapshot_table.as_deref().map(|bytes| unsafe { js_sys::Uint8Array::view(bytes) })
    }

    /// Zero-copy view of the intermediate snapshot checkpoint payload byte arena — same
    /// lifetime/detachment caveat as [`Self::debug_tape_node_table`].
    #[wasm_bindgen(js_name = debugSnapshotPayload)]
    pub fn debug_snapshot_payload(&self) -> Option<js_sys::Uint8Array> {
        // SAFETY: see `debug_tape_node_table`.
        self.snapshot_payload.as_deref().map(|bytes| unsafe { js_sys::Uint8Array::view(bytes) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `.snapshot()`/`.debugTapeNodeTable()`/`.debugTapePayload()` (the `#[wasm_bindgen]` methods)
    // go through `js_sys`/`JsValue`, which panic outside a real WASM runtime — not exercisable by
    // `cargo test`'s host target. These tests instead cover the plain-Rust constructors plus the
    // `debug_tape_bytes()` test accessor, which carry the actual logic worth protecting (which
    // buffers end up `Some`/`None`).

    #[test]
    fn without_debug_tape_has_no_buffers() {
        let result = GenerateResult::without_debug_tape(JsValue::UNDEFINED);
        assert!(result.debug_tape_bytes().is_none());
    }

    #[test]
    fn with_debug_tape_carries_both_buffers() {
        let result = GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5]);
        let (node_table, payload) = result.debug_tape_bytes().expect("both buffers must be present");
        assert_eq!(node_table, &[1, 2, 3]);
        assert_eq!(payload, &[4, 5]);
    }

    #[test]
    fn without_checkpoints_has_no_checkpoint_buffers() {
        let result = GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5]);
        assert!(result.checkpoint_bytes().is_none());
    }

    #[test]
    fn with_checkpoints_carries_both_checkpoint_buffers() {
        let snapshot_table = vec![0u8; maze_core::event_log::CHECKPOINT_RECORD_SIZE]; // one whole record
        let result = GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5])
            .with_checkpoints(snapshot_table.clone(), vec![8, 9, 10]);
        let (node_table, payload) = result.debug_tape_bytes().expect("debug tape buffers must still be present");
        assert_eq!(node_table, &[1, 2, 3]);
        assert_eq!(payload, &[4, 5]);
        let (checkpoint_table, snapshot_payload) = result.checkpoint_bytes().expect("checkpoint buffers must be present");
        assert_eq!(checkpoint_table, snapshot_table.as_slice());
        assert_eq!(snapshot_payload, &[8, 9, 10]);
    }

    #[test]
    #[should_panic(expected = "not a whole number of CHECKPOINT_RECORD_SIZE")]
    fn with_checkpoints_rejects_a_table_length_not_a_multiple_of_checkpoint_record_size() {
        GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5])
            .with_checkpoints(vec![6, 7], vec![8, 9, 10]);
    }

    #[test]
    #[should_panic(expected = "with_checkpoints called without a debug tape")]
    fn with_checkpoints_rejects_being_chained_onto_without_debug_tape() {
        let snapshot_table = vec![0u8; maze_core::event_log::CHECKPOINT_RECORD_SIZE];
        GenerateResult::without_debug_tape(JsValue::UNDEFINED)
            .with_checkpoints(snapshot_table, vec![8, 9, 10]);
    }
}
