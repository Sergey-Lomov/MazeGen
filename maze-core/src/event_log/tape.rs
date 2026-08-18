//! Arena-backed scope/event tree: [`EventLog`] (the mutable builder), [`ScopeGuard`] (RAII
//! scope handle), and [`DebugTape`] (the read-only result) with its [`NodeView`] walker.

use std::borrow::Cow;

pub(super) enum NodeKind<E> {
    Scope(Cow<'static, str>),
    Event(E),
}

pub(super) struct Node<E> {
    pub(super) parent: Option<u32>,
    pub(super) first_child: Option<u32>,
    pub(super) last_child: Option<u32>,
    pub(super) next_sibling: Option<u32>,
    pub(super) kind: NodeKind<E>,
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

    /// True when nothing has been `emit`/`enter`-ed yet — just the root scope. Lets a caller that
    /// built a log speculatively (e.g. only when `debug_events` is on) tell "no events happened"
    /// apart from "instrumentation was off", without inspecting the arena's internals itself.
    pub fn is_empty(&self) -> bool {
        self.nodes.len() == 1
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
    pub(super) nodes: Vec<Node<E>>,
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
#[path = "tape_tests.rs"]
mod tests;
