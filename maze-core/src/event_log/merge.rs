//! Merges several already-encoded, independently-produced tapes into one combined arena — see
//! [`merge_tapes`].

use super::wire::{
    EncodedTape, NO_NODE, NODE_RECORD_SIZE, NodeRecord, ScopeNameInterner, TAG_SCOPE,
};

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
/// [`crate::generation::GenerationAlgorithm`]/[`super::deltas::EventedEventKind`]-shaped knowledge — mapping a
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
    debug_assert!(
        !sources.is_empty(),
        "merge_tapes called with no sources — caller should skip merging entirely instead"
    );

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
    // interner DebugTape::encode uses for its own scope-name dedup.
    let mut interner = ScopeNameInterner::new();

    let mut node_table = Vec::new();

    // Node 0: the new merged root — first_child is node 1 (the first source's top-level scope),
    // last source's top-level scope has no next_sibling.
    let (root_offset, root_len) = interner.intern("root", &mut payload);
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
        let (offset, len) = interner.intern(source.scope_name, &mut payload);
        let former_root_relinked = if source.tape.node_table.is_empty() {
            None
        } else {
            Some(node_offsets[i])
        };
        NodeRecord {
            parent: 0,
            first_child: former_root_relinked.unwrap_or(NO_NODE),
            next_sibling: if i + 1 < sources.len() {
                (i + 2) as u32
            } else {
                NO_NODE
            },
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
            if link == NO_NODE {
                NO_NODE
            } else {
                link + node_offset
            }
        };

        for local_index in 0..record_count {
            let mut record = NodeRecord::read(&source.tape.node_table, local_index);
            // The former root's parent (NO_NODE) must instead point at this source's new
            // top-level scope node (index 1 + source_index) rather than staying rootless.
            record.parent = if local_index == 0 {
                (1 + source_index) as u32
            } else {
                shift_link(record.parent)
            };
            record.first_child = shift_link(record.first_child);
            record.next_sibling = shift_link(record.next_sibling);
            record.payload_offset += payload_offset;
            if record.tag != TAG_SCOPE {
                record.tag |= source_tag_prefix;
            }
            record.write(&mut node_table);
        }
    }

    EncodedTape {
        node_table,
        payload,
    }
}

#[cfg(test)]
mod tests {
    use super::super::tape::{DebugEvent, EventLog};
    use super::super::wire::{EncodeEventPayload, NODE_RECORD_SIZE as REC_SIZE};
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
        (
            record.parent,
            record.first_child,
            record.next_sibling,
            record.tag,
            record.payload_offset,
            record.payload_len,
        )
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
        let count = (encoded.node_table.len() / REC_SIZE) as u32;
        (encoded, count)
    }

    #[test]
    fn single_source_still_gets_wrapped_in_root_and_source_scope() {
        // No special-casing for exactly one source — merge always adds root + one top-level
        // scope, even when there's only one source to wrap (per explicit product decision).
        let (tape, node_count) = fixture_tape(10);
        assert_eq!(
            node_count, 4,
            "root(step-tape) + step scope + Mutating + Trace = 4 nodes in the unmerged tape"
        );

        let merged = merge_tapes(vec![TapeSource {
            scope_name: "generation",
            tape,
        }]);

        // Node 0: new merged root, first_child = 1 (the "generation" top-level scope).
        let (parent, first_child, next_sibling, tag, _, _) =
            read_node_record(&merged.node_table, 0);
        assert_eq!((parent, next_sibling), (NO_NODE, NO_NODE));
        assert_eq!(first_child, 1);
        assert_eq!(tag, TAG_SCOPE);

        // Node 1: "generation" top-level scope, parent = 0 (new root), first_child = 2 (former
        // root of the source tape, relinked), no next_sibling (only one source).
        let (parent, first_child, next_sibling, tag, offset, len) =
            read_node_record(&merged.node_table, 1);
        assert_eq!(parent, 0);
        assert_eq!(first_child, 2);
        assert_eq!(next_sibling, NO_NODE);
        assert_eq!(tag, TAG_SCOPE);
        assert_eq!(
            &merged.payload[offset as usize..(offset + len) as usize],
            b"generation"
        );

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
        let merged = merge_tapes(vec![TapeSource {
            scope_name: "generation",
            tape,
        }]);

        // Layout: 0=merged root, 1="generation" scope, 2=former root("root"), 3=former "step"
        // scope, 4=Mutating(10), 5=Trace(11).
        let (_, _, _, tag, ..) = read_node_record(&merged.node_table, 4);
        assert_eq!(
            tag & SOURCE_MASK,
            0,
            "source_index 0 must produce a zero source-mask nibble"
        );
        assert_eq!(
            tag & LOCAL_TAG_MASK,
            FIXTURE_TAG_MUTATING,
            "local tag must survive unchanged under the mask"
        );
        assert_eq!(
            tag, FIXTURE_TAG_MUTATING,
            "numerically the merged tag equals the local tag for source 0, per SOURCE_SHIFT math"
        );
    }

    #[test]
    fn second_source_gets_a_nonzero_source_prefix_and_first_source_stays_untouched() {
        let (tape_a, _) = fixture_tape(10);
        let (tape_b, _) = fixture_tape(20);
        let merged = merge_tapes(vec![
            TapeSource {
                scope_name: "generation",
                tape: tape_a,
            },
            TapeSource {
                scope_name: "quality_control",
                tape: tape_b,
            },
        ]);

        // Layout: 0=root, 1="generation" scope, 2="quality_control" scope,
        // 3=former-root-of-a("root"), 4="step"(a), 5=Mutating(10), 6=Trace(11),
        // 7=former-root-of-b("root"), 8="step"(b), 9=Mutating(20), 10=Trace(21).
        let (_, _, _, tag_a, ..) = read_node_record(&merged.node_table, 5);
        assert_eq!(tag_a & SOURCE_MASK, 0);
        assert_eq!(tag_a & LOCAL_TAG_MASK, FIXTURE_TAG_MUTATING);

        let (_, _, _, tag_b, ..) = read_node_record(&merged.node_table, 9);
        assert_eq!(
            (tag_b & SOURCE_MASK) >> SOURCE_SHIFT,
            1,
            "second source must carry source_index 1 in its tag prefix"
        );
        assert_eq!(
            tag_b & LOCAL_TAG_MASK,
            FIXTURE_TAG_MUTATING,
            "local tag itself must be unchanged"
        );
        assert_ne!(
            tag_a, tag_b,
            "same local tag from two different sources must decode to different raw tags"
        );
    }

    #[test]
    fn tag_scope_is_never_namespaced() {
        let (tape_a, _) = fixture_tape(10);
        let (tape_b, _) = fixture_tape(20);
        let merged = merge_tapes(vec![
            TapeSource {
                scope_name: "generation",
                tape: tape_a,
            },
            TapeSource {
                scope_name: "quality_control",
                tape: tape_b,
            },
        ]);

        // Every scope node (root, both top-level scopes, both former roots, both "step" scopes)
        // must keep tag == TAG_SCOPE (0) regardless of which source it belongs to.
        for index in [0usize, 1, 2, 3, 4, 7, 8] {
            let (_, _, _, tag, ..) = read_node_record(&merged.node_table, index);
            assert_eq!(
                tag, TAG_SCOPE,
                "node {index} is a scope and must never be namespaced"
            );
        }
    }

    #[test]
    fn payload_bytes_are_copied_verbatim_not_reencoded() {
        let (tape_a, _) = fixture_tape(10);
        let (tape_b, _) = fixture_tape(20);
        let original_a_payload = tape_a.payload.clone();
        let original_b_payload = tape_b.payload.clone();

        let merged = merge_tapes(vec![
            TapeSource {
                scope_name: "generation",
                tape: tape_a,
            },
            TapeSource {
                scope_name: "quality_control",
                tape: tape_b,
            },
        ]);

        // The merged payload arena holds each source's payload bytes concatenated verbatim first
        // (source a, then source b, untouched), followed by the merge's own new top-level scope
        // names ("root", "generation", "quality_control" — interned after the sources' bytes).
        assert_eq!(
            &merged.payload[0..original_a_payload.len()],
            &original_a_payload[..]
        );
        assert_eq!(
            &merged.payload
                [original_a_payload.len()..original_a_payload.len() + original_b_payload.len()],
            &original_b_payload[..]
        );
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
        let empty_tape = EncodedTape {
            node_table: Vec::new(),
            payload: Vec::new(),
        };
        let merged = merge_tapes(vec![TapeSource {
            scope_name: "generation",
            tape: empty_tape,
        }]);

        // Node 0: merged root, first_child = 1 ("generation" scope) as usual.
        let (_, first_child, _, _, _, _) = read_node_record(&merged.node_table, 0);
        assert_eq!(first_child, 1);

        // Node 1: "generation" scope has no first_child (NO_NODE) — nothing to relink to.
        let (_, first_child, next_sibling, tag, ..) = read_node_record(&merged.node_table, 1);
        assert_eq!(
            first_child, NO_NODE,
            "an empty source's top-level scope must not point at a nonexistent former root"
        );
        assert_eq!(next_sibling, NO_NODE);
        assert_eq!(tag, TAG_SCOPE);
        assert_eq!(
            merged.node_table.len() / REC_SIZE,
            2,
            "only the merged root and the top-level scope exist — no former root, no content"
        );
    }
}
