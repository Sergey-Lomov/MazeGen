use wasm_bindgen::prelude::*;

/// Wire representation of `maze_core::event_log::DebugValueKind` for `GenerateResult`'s
/// `debugValueKinds()` getter — plain strings, not a numeric enum, since this rides across the
/// WASM boundary as a `Vec<String>` alongside `debug_value_names` (see that field's doc comment).
fn kind_wire_str(kind: maze_core::event_log::DebugValueKind) -> &'static str {
    match kind {
        maze_core::event_log::DebugValueKind::Region => "region",
        maze_core::event_log::DebugValueKind::Sequence => "sequence",
        maze_core::event_log::DebugValueKind::Map => "map",
        maze_core::event_log::DebugValueKind::Vertex => "vertex",
    }
}

/// Wire representation of `maze_core::event_log::EventedEventKind` for `GenerateResult`'s
/// `sourceEventKinds()` getter — tells the web replay engine (`maze-web/src/debug/eventTape.ts`)
/// which concrete event enum each top-level source scope's subtree was encoded from, so it knows
/// which decoder/apply function to dispatch to for that scope (GitHub issue #146, generalized to
/// multiple sources by #169). Plain string, not a numeric enum, matching how
/// `debug_value_names`/`debug_value_kinds` already cross the boundary as plain values.
fn event_kind_wire_str(kind: maze_core::event_log::EventedEventKind) -> &'static str {
    match kind {
        maze_core::event_log::EventedEventKind::PresetSetup => "preset_setup",
        maze_core::event_log::EventedEventKind::RecursiveBacktracker => "recursive_backtracker",
        maze_core::event_log::EventedEventKind::Kruskal => "kruskal",
        maze_core::event_log::EventedEventKind::Wilson => "wilson",
        maze_core::event_log::EventedEventKind::EdgeBased => "edge_based",
        maze_core::event_log::EventedEventKind::VertexBased => "vertex_based",
        maze_core::event_log::EventedEventKind::QualityControl => "quality_control",
    }
}

/// Return type of `generate()` (GitHub issue #124). Wraps the existing `MazeSnapshot` (unchanged
/// — still one `serde_wasm_bindgen`-serialized `JsValue`) alongside an optional debug event tape,
/// encoded as two flat byte buffers (see `maze_core::event_log::DebugTape::encode`) — populated
/// only when `GenerateConfig.debug_events` is set. `None` when the debug event tree wasn't built
/// (no cost beyond the two `None`s on the normal/non-debug path).
///
/// Since GitHub issue #169, `node_table`/`payload` are always the output of
/// `maze_core::event_log::merge_tapes` — one combined tree with one top-level scope per
/// instrumented source (today: always exactly one, "generation"; QC/repair instrumentation,
/// issue #147, will add more). `source_scope_names`/`source_event_kinds` (below) describe that
/// top-level structure.
#[wasm_bindgen]
pub struct GenerateResult {
    snapshot: JsValue,
    node_table: Option<Vec<u8>>,
    payload: Option<Vec<u8>>,
    /// Debug-value names (GitHub issue #131, e.g. `"recursion_stack"`) declared by the instrumented
    /// algorithm(s) — see `maze_core::generation::EventedGenerationResult::debug_value_names`.
    /// Already qualified with `"{scope_name}:"` when more than one source is present (see that
    /// field's doc comment) — this type does no further transformation, only forwards. Always
    /// empty when `node_table`/`payload` are `None`. Plain `Vec<String>`, not a zero-copy
    /// buffer — a handful of short names doesn't warrant the `Uint8Array::view` treatment the
    /// node table/payload buffers get.
    debug_value_names: Vec<String>,
    /// Parallel array to `debug_value_names` — each entry is `"region"` or `"sequence"`
    /// (`maze_core::event_log::DebugValueKind`'s wire representation), same index as its name.
    /// A separate `Vec<String>` rather than e.g. `"name:kind"` packed into one string, matching
    /// the existing plain-array marshaling `debug_value_names` itself uses.
    debug_value_kinds: Vec<String>,
    /// One entry per top-level source scope in the merged tree (GitHub issue #169), in the same
    /// order as that tree's top-level children — e.g. `["generation"]` today. Empty exactly when
    /// `node_table`/`payload` are `None`.
    source_scope_names: Vec<String>,
    /// Parallel array to `source_scope_names` — which concrete event enum each source scope's
    /// subtree was encoded from, wire string via `event_kind_wire_str`.
    source_event_kinds: Vec<String>,
}

impl GenerateResult {
    pub fn without_debug_tape(snapshot: JsValue) -> Self {
        Self {
            snapshot, node_table: None, payload: None,
            debug_value_names: Vec::new(), debug_value_kinds: Vec::new(),
            source_scope_names: Vec::new(), source_event_kinds: Vec::new(),
        }
    }

    pub fn with_debug_tape(
        snapshot: JsValue,
        node_table: Vec<u8>,
        payload: Vec<u8>,
        debug_value_names: Vec<(String, maze_core::event_log::DebugValueKind)>,
        sources: Vec<(&'static str, maze_core::event_log::EventedEventKind)>,
    ) -> Self {
        let (names, kinds) = debug_value_names.into_iter().map(|(name, kind)| (name, kind_wire_str(kind).to_string())).unzip();
        let (source_scope_names, source_event_kinds) = sources
            .into_iter()
            .map(|(scope_name, kind)| (scope_name.to_string(), event_kind_wire_str(kind).to_string()))
            .unzip();
        Self {
            snapshot, node_table: Some(node_table), payload: Some(payload),
            debug_value_names: names, debug_value_kinds: kinds, source_scope_names, source_event_kinds,
        }
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

    /// Test-only accessor for `debug_value_names` — avoids the `#[wasm_bindgen]` method for the
    /// same reason as `debug_tape_bytes`, though this field is a plain
    /// `Vec<String>` and doesn't itself need a real WASM runtime; kept alongside the others for
    /// consistency of the test-only accessor surface.
    pub(crate) fn debug_value_names_bytes(&self) -> &[String] {
        &self.debug_value_names
    }

    /// Test-only accessor for `debug_value_kinds` — see [`Self::debug_value_names_bytes`].
    pub(crate) fn debug_value_kinds_bytes(&self) -> &[String] {
        &self.debug_value_kinds
    }

    /// Test-only accessor for `source_scope_names` — see [`Self::debug_value_names_bytes`].
    pub(crate) fn source_scope_names_bytes(&self) -> &[String] {
        &self.source_scope_names
    }

    /// Test-only accessor for `source_event_kinds` — see [`Self::debug_value_names_bytes`].
    pub(crate) fn source_event_kinds_bytes(&self) -> &[String] {
        &self.source_event_kinds
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

    /// Debug-value names (GitHub issue #131) declared by the instrumented algorithm — empty when
    /// `debug_events` wasn't enabled or the algorithm isn't instrumented yet. Plain value return,
    /// not a zero-copy view — safe to call more than once, no detachment caveat.
    #[wasm_bindgen(js_name = debugValueNames)]
    pub fn debug_value_names(&self) -> Vec<String> {
        self.debug_value_names.clone()
    }

    /// Parallel to [`Self::debug_value_names`] — each entry is `"region"`, `"sequence"`, `"map"`,
    /// or `"vertex"` (GitHub issue #145's follow-up added the latter two), same index as its name,
    /// see `kind_wire_str`.
    #[wasm_bindgen(js_name = debugValueKinds)]
    pub fn debug_value_kinds(&self) -> Vec<String> {
        self.debug_value_kinds.clone()
    }

    /// Name of each top-level source scope in the merged debug event tree (GitHub issue #169),
    /// in the same order as that tree's top-level children — e.g. `["generation"]` today. Empty
    /// if `debug_events` wasn't enabled. Plain value return, not a zero-copy view.
    #[wasm_bindgen(js_name = sourceScopeNames)]
    pub fn source_scope_names(&self) -> Vec<String> {
        self.source_scope_names.clone()
    }

    /// Parallel to [`Self::source_scope_names`] — which concrete event enum
    /// (`"recursive_backtracker"`, `"kruskal"` (#146), `"wilson"` (#145), ...) that source scope's
    /// subtree was encoded from. Tells the web replay engine which decoder to dispatch to for
    /// that scope.
    #[wasm_bindgen(js_name = sourceEventKinds)]
    pub fn source_event_kinds(&self) -> Vec<String> {
        self.source_event_kinds.clone()
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
        let result = GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5], Vec::new(), vec![("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker)]);
        let (node_table, payload) = result.debug_tape_bytes().expect("both buffers must be present");
        assert_eq!(node_table, &[1, 2, 3]);
        assert_eq!(payload, &[4, 5]);
    }

    #[test]
    fn without_debug_tape_has_no_debug_value_names() {
        let result = GenerateResult::without_debug_tape(JsValue::UNDEFINED);
        assert!(result.debug_value_names_bytes().is_empty());
    }

    #[test]
    fn with_debug_tape_carries_debug_value_names() {
        let result = GenerateResult::with_debug_tape(
            JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5],
            vec![("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence)],
            vec![("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker)],
        );
        assert_eq!(result.debug_value_names_bytes(), &["recursion_stack".to_string()]);
        assert_eq!(result.debug_value_kinds_bytes(), &["sequence".to_string()]);
    }

    #[test]
    fn with_debug_tape_carries_a_region_kind_debug_value() {
        // Guards kind_wire_str's Region arm specifically — with_debug_tape_carries_debug_value_names
        // above only ever exercises Sequence, so a typo'd/swapped wire string for Region would
        // otherwise ship undetected.
        let result = GenerateResult::with_debug_tape(
            JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5],
            vec![("visited".to_string(), maze_core::event_log::DebugValueKind::Region)],
            vec![("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker)],
        );
        assert_eq!(result.debug_value_names_bytes(), &["visited".to_string()]);
        assert_eq!(result.debug_value_kinds_bytes(), &["region".to_string()]);
    }

    #[test]
    fn with_debug_tape_carries_a_map_kind_debug_value() {
        // Guards kind_wire_str's Map arm specifically (GitHub issue #145's follow-up) — mirrors
        // with_debug_tape_carries_a_region_kind_debug_value's rationale for Region.
        let result = GenerateResult::with_debug_tape(
            JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5],
            vec![("current_walk".to_string(), maze_core::event_log::DebugValueKind::Map)],
            vec![("generation", maze_core::event_log::EventedEventKind::Wilson)],
        );
        assert_eq!(result.debug_value_names_bytes(), &["current_walk".to_string()]);
        assert_eq!(result.debug_value_kinds_bytes(), &["map".to_string()]);
    }

    #[test]
    fn with_debug_tape_carries_a_vertex_kind_debug_value() {
        // Guards kind_wire_str's Vertex arm specifically (GitHub issue #145's follow-up) — mirrors
        // with_debug_tape_carries_a_map_kind_debug_value's rationale for Map.
        let result = GenerateResult::with_debug_tape(
            JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5],
            vec![("walk_head".to_string(), maze_core::event_log::DebugValueKind::Vertex)],
            vec![("generation", maze_core::event_log::EventedEventKind::Wilson)],
        );
        assert_eq!(result.debug_value_names_bytes(), &["walk_head".to_string()]);
        assert_eq!(result.debug_value_kinds_bytes(), &["vertex".to_string()]);
    }

    #[test]
    fn without_debug_tape_has_no_sources() {
        let result = GenerateResult::without_debug_tape(JsValue::UNDEFINED);
        assert!(result.source_scope_names_bytes().is_empty());
        assert!(result.source_event_kinds_bytes().is_empty());
    }

    #[test]
    fn with_debug_tape_carries_recursive_backtracker_event_kind() {
        let result = GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5], Vec::new(), vec![("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker)]);
        assert_eq!(result.source_scope_names_bytes(), &["generation".to_string()]);
        assert_eq!(result.source_event_kinds_bytes(), &["recursive_backtracker".to_string()]);
    }

    #[test]
    fn with_debug_tape_carries_kruskal_event_kind() {
        let result = GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5], Vec::new(), vec![("generation", maze_core::event_log::EventedEventKind::Kruskal)]);
        assert_eq!(result.source_event_kinds_bytes(), &["kruskal".to_string()]);
    }

    #[test]
    fn with_debug_tape_carries_wilson_event_kind() {
        let result = GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5], Vec::new(), vec![("generation", maze_core::event_log::EventedEventKind::Wilson)]);
        assert_eq!(result.source_event_kinds_bytes(), &["wilson".to_string()]);
    }

    #[test]
    fn with_debug_tape_carries_edge_based_event_kind() {
        let result = GenerateResult::with_debug_tape(JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5], Vec::new(), vec![("generation", maze_core::event_log::EventedEventKind::EdgeBased)]);
        assert_eq!(result.source_event_kinds_bytes(), &["edge_based".to_string()]);
    }

    #[test]
    fn with_debug_tape_carries_multiple_sources_in_order() {
        // Guards the parallel-array pairing itself when more than one source is present —
        // every other test in this module only ever exercises exactly one.
        let result = GenerateResult::with_debug_tape(
            JsValue::UNDEFINED, vec![1, 2, 3], vec![4, 5], Vec::new(),
            vec![
                ("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker),
                ("quality_control", maze_core::event_log::EventedEventKind::Kruskal),
            ],
        );
        assert_eq!(result.source_scope_names_bytes(), &["generation".to_string(), "quality_control".to_string()]);
        assert_eq!(result.source_event_kinds_bytes(), &["recursive_backtracker".to_string(), "kruskal".to_string()]);
    }
}
