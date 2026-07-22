//! Traits/enums a concrete event enum implements to declare how its mutating variants affect
//! named "debug value" sets/maps/slots — see issues #131, #145 and `Specs/event_log.md`.

/// Insert/remove operation on a named [`DebugValueDelta::debug_value_deltas`] set — see issue #131.
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

/// Tags which concrete event enum an [`crate::event_log::EncodedTape`] was built from — one variant per algorithm
/// that has `EventLog` instrumentation (not one per generation-algorithm variant in general, most
/// of which aren't instrumented at all). This is the single source of truth for "whose tape is
/// this" once the concrete `E` has been erased to bytes — see GitHub issue #161: consumers that
/// only understand some event kinds (e.g. the web replay engine, RB-only so far) filter on this
/// tag rather than re-matching on the generation algorithm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventedEventKind {
    PresetSetup,
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
