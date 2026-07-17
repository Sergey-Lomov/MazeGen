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
            let mut g = log.enter("a");
            {
                let mut g2 = g.enter("b");
                let _g3 = g2.enter("c");
            }
        }
        let tape = log.finish();
        assert_eq!(tape.iter().count(), 0, "no events were emitted anywhere in the tree");
    }

    // --- enter_numbered() (GitHub issue #133) ---

    #[test]
    fn enter_numbered_increments_per_cursor_and_base_name() {
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let mut g = log.enter_numbered("step");
            g.emit(TestEvent::Mutating(1));
        }
        {
            let mut g = log.enter_numbered("step");
            g.emit(TestEvent::Mutating(2));
        }
        {
            let mut g = log.enter_numbered("roll");
            g.emit(TestEvent::Mutating(3));
        }

        let tape = log.finish();
        let names: Vec<&str> = tape
            .root()
            .children()
            .map(|c| match c.payload() {
                NodePayload::Scope(name) => name,
                NodePayload::Event(_) => panic!("expected only scopes"),
            })
            .collect();
        assert_eq!(names, vec!["step 1", "step 2", "roll 1"]);
    }

    #[test]
    fn enter_numbered_counts_independently_per_parent_scope() {
        // "step" scopes opened directly under two different parent cursors (root vs. a nested
        // "outer" scope) must number independently — the counter is keyed by (parent cursor,
        // base name), not by base name alone.
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let mut top_step = log.enter_numbered("step");
            top_step.emit(TestEvent::Mutating(1));
        }
        {
            let mut outer = log.enter_numbered("outer");
            let mut nested_step = outer.enter_numbered("step");
            nested_step.emit(TestEvent::Mutating(2));
        }

        let tape = log.finish();
        let root_children: Vec<_> = tape.root().children().collect();
        assert_eq!(root_children.len(), 2);
        assert!(matches!(root_children[0].payload(), NodePayload::Scope("step 1")));
        assert!(matches!(root_children[1].payload(), NodePayload::Scope("outer 1")));

        let nested_step = root_children[1].children().next().unwrap();
        assert!(
            matches!(nested_step.payload(), NodePayload::Scope("step 1")),
            "\"step\" nested under \"outer\" is a different parent cursor than root, so it numbers independently of the top-level \"step 1\""
        );
    }

    // --- resuming a parent ScopeGuard after a nested scope closes (GitHub issue #162) ---

    #[test]
    fn parent_guard_reusable_between_and_after_sibling_child_scopes() {
        // Mirrors Wilson's "walk" > "step 1", "step 2", ... shape (issue #145): a parent scope
        // stays open across several sibling child scopes, with emits into the parent both
        // between and after them, all through the same `parent` guard.
        let mut log: EventLog<TestEvent> = EventLog::new();
        {
            let mut parent = log.enter("walk");
            parent.emit(TestEvent::Trace(0)); // before the first child
            for i in 1..=3 {
                {
                    let mut child = parent.enter_numbered("step");
                    child.emit(TestEvent::Mutating(i));
                } // child dropped here, releasing the borrow on `parent`
                parent.emit(TestEvent::Trace(i + 100)); // between/after each child
            }
        }

        let tape = log.finish();
        let walk = tape.root().children().next().unwrap();
        assert!(matches!(walk.payload(), NodePayload::Scope("walk")));

        let walk_children: Vec<_> = walk.children().collect();
        assert_eq!(walk_children.len(), 7, "1 leading event + 3 * (child scope + trailing event)");

        assert!(matches!(walk_children[0].payload(), NodePayload::Event(TestEvent::Trace(0))));
        for i in 1..=3u32 {
            let base = ((i - 1) * 2 + 1) as usize;
            let step_scope = walk_children[base];
            let expected_name = format!("step {i}");
            assert!(matches!(step_scope.payload(), NodePayload::Scope(name) if name == expected_name));
            let step_children: Vec<_> = step_scope.children().collect();
            assert_eq!(step_children.len(), 1);
            assert!(matches!(step_children[0].payload(), NodePayload::Event(TestEvent::Mutating(v)) if *v == i));

            // The trailing per-iteration event lands as `walk`'s direct child, not `step i`'s —
            // proof that `parent.emit` after the child drops reaches the right scope.
            assert!(matches!(
                walk_children[base + 1].payload(),
                NodePayload::Event(TestEvent::Trace(v)) if *v == i + 100
            ));
        }
    }
}
