//! Narration-level events for the "preset setup" debug-tape source (GitHub issue #225) — one
//! event per preset connection `build_preset_state` resolves into the graph before any generation
//! algorithm runs. Deliberately its own top-level source (see `Specs/event_log.md`'s "Preset Setup
//! Source" section) rather than an event duplicated into every instrumented algorithm's own event
//! enum: preset seeding happens once, before generation is even dispatched, and is identical
//! regardless of which algorithm eventually runs — narrating it once, in one place, is what "one
//! preset setup, one narration" actually means.
//!
//! Three event kinds, one per `PresetConnectionState` outcome that actually establishes an edge
//! (`Wall` blocks a pair without adding anything, so it emits nothing):
//! - [`PresetSetupEvent::PassageEstablished`] — a bidirectional `Passage` preset.
//! - [`PresetSetupEvent::OneWayEstablished`] — a `OneWayForward`/`OneWayBackward` preset, `from`/
//!   `to` already resolved to the actual direction the passage allows.
//! - [`PresetSetupEvent::TeleportEstablished`] — a `Teleport` preset, `two_way` distinguishing a
//!   `TeleportDirection::TwoWay` pair (one event covers both directed graph edges) from a one-way
//!   `Forward`/`Backward` teleport.

use crate::ids::NodeId;
use crate::event_log::{DebugEvent, EncodeEventPayload, EventLog};

mod wire_tags {
    pub const PASSAGE_ESTABLISHED: u16 = 1;
    pub const ONE_WAY_ESTABLISHED: u16 = 2;
    pub const TELEPORT_ESTABLISHED: u16 = 3;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetSetupEvent {
    PassageEstablished { from: NodeId, to: NodeId },
    OneWayEstablished { from: NodeId, to: NodeId },
    TeleportEstablished { from: NodeId, to: NodeId, two_way: bool },
}

impl DebugEvent for PresetSetupEvent {
    /// Every event this source ever emits is mutating — each one is a preset edge the graph
    /// already carries before generation starts, and every replay consumer's first reconstructed
    /// frame must show it.
    fn is_mutating(&self) -> bool {
        true
    }
}

impl EncodeEventPayload for PresetSetupEvent {
    fn type_id(&self) -> u16 {
        match self {
            PresetSetupEvent::PassageEstablished { .. } => wire_tags::PASSAGE_ESTABLISHED,
            PresetSetupEvent::OneWayEstablished { .. } => wire_tags::ONE_WAY_ESTABLISHED,
            PresetSetupEvent::TeleportEstablished { .. } => wire_tags::TELEPORT_ESTABLISHED,
        }
    }

    fn encode_payload(&self, out: &mut Vec<u8>) {
        match self {
            PresetSetupEvent::PassageEstablished { from, to }
            | PresetSetupEvent::OneWayEstablished { from, to } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
            }
            PresetSetupEvent::TeleportEstablished { from, to, two_way } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
                out.push(if *two_way { 1 } else { 0 });
            }
        }
    }
}

/// Scope name this source's top-level child scope is labeled with once merged via
/// [`crate::event_log::merge_tapes`] — read by the web replay engine to pick the right decoder for
/// this source, mirroring `"generation"`/`"quality_control"`'s own scope names.
pub const PRESET_SETUP_SCOPE_NAME: &str = "preset_setup";

/// Emits one [`PresetSetupEvent`] into `log` for a preset connection that actually established an
/// edge — called from `build_preset_state`'s own per-connection loop, so each event carries the
/// same `from`/`to`/direction the loop already resolved, no post-hoc graph reconstruction needed.
pub(super) fn emit(log: &mut EventLog<PresetSetupEvent>, event: PresetSetupEvent) {
    log.emit(event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_log::TAG_SCOPE;

    #[test]
    fn every_variant_is_mutating() {
        assert!(PresetSetupEvent::PassageEstablished { from: 1, to: 2 }.is_mutating());
        assert!(PresetSetupEvent::OneWayEstablished { from: 1, to: 2 }.is_mutating());
        assert!(PresetSetupEvent::TeleportEstablished { from: 1, to: 2, two_way: true }.is_mutating());
    }

    #[test]
    fn every_variant_has_a_unique_nonzero_wire_tag() {
        let tags = [
            PresetSetupEvent::PassageEstablished { from: 1, to: 2 }.type_id(),
            PresetSetupEvent::OneWayEstablished { from: 1, to: 2 }.type_id(),
            PresetSetupEvent::TeleportEstablished { from: 1, to: 2, two_way: false }.type_id(),
        ];
        for tag in tags {
            assert_ne!(tag, TAG_SCOPE);
        }
        assert_eq!(tags.iter().collect::<std::collections::HashSet<_>>().len(), tags.len());
    }

    #[test]
    fn passage_encodes_from_then_to() {
        let event = PresetSetupEvent::PassageEstablished { from: 5, to: 9 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes.len(), 16);
        assert_eq!(u64::from_le_bytes(bytes[0..8].try_into().unwrap()), 5);
        assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 9);
    }

    #[test]
    fn one_way_encodes_from_then_to_already_directed() {
        let event = PresetSetupEvent::OneWayEstablished { from: 3, to: 4 };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes.len(), 16);
        assert_eq!(u64::from_le_bytes(bytes[0..8].try_into().unwrap()), 3);
        assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 4);
    }

    #[test]
    fn teleport_encodes_from_to_then_two_way_flag() {
        let one_way = PresetSetupEvent::TeleportEstablished { from: 1, to: 2, two_way: false };
        let mut bytes = Vec::new();
        one_way.encode_payload(&mut bytes);
        assert_eq!(bytes.len(), 17);
        assert_eq!(bytes[16], 0);

        let two_way = PresetSetupEvent::TeleportEstablished { from: 1, to: 2, two_way: true };
        let mut bytes = Vec::new();
        two_way.encode_payload(&mut bytes);
        assert_eq!(bytes[16], 1);
    }
}
