//! Debug event log: a tree of scopes and events built during generation, stored as a flat
//! arena (`Vec`-backed, parent/first_child/next_sibling links) so it can later be exposed
//! zero-copy across the WASM boundary (see issue #124).
//!
//! Events are split into two kinds via [`DebugEvent::is_mutating`]: mutating events are
//! replayed to reconstruct state, trace events are narration-only. Insertion order in the
//! backing `Vec` is DFS pre-order by construction (see the invariant note on [`DebugTape`]),
//! so linear (emission) order for mutating events is recovered by a plain forward scan.
//!
//! Split into three independent concerns, each in its own submodule:
//! - [`tape`] — the arena/tree itself ([`EventLog`], [`ScopeGuard`], [`DebugTape`], [`NodeView`]).
//! - [`deltas`] — traits a concrete event enum implements to report named debug-value changes.
//! - [`wire`] — the canonical binary encoding of a single tape ([`EncodedTape`]).
//! - [`merge`] — combining several already-encoded tapes into one arena ([`merge_tapes`]).

mod deltas;
mod merge;
mod tape;
mod wire;
pub mod wire_primitives;

pub use deltas::{
    DebugMapDelta, DebugMapOp, DebugValueDelta, DebugValueKind, DebugValueOp, DebugVertexDelta, DebugVertexOp, EventedEventKind,
};
pub use merge::{merge_tapes, TapeSource, LOCAL_TAG_MASK, SOURCE_MASK, SOURCE_SHIFT};
pub use tape::{DebugEvent, EventLog, NodePayload, NodeView, ScopeGuard};
pub use wire::{EncodeEventPayload, EncodedTape, NODE_RECORD_SIZE, NO_NODE, TAG_SCOPE};

// `DebugTape` lives in `tape` (its arena data is stored there) but grows methods in `wire`
// (`encode`) — re-exported from here since it's the one type spanning multiple submodules.
pub use tape::DebugTape;
