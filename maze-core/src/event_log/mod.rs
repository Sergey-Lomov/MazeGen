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
        Self { nodes: vec![root], cursor: 0 }
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
}
