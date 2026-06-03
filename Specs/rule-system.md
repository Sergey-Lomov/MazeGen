# Rule System

A post-generation pipeline that mutates `Graph` and `MazeMeta` deterministically. Rules run after the maze graph is fully generated and before the result is packaged into `Maze`.

## Core Concepts

### Rule trait

```rust
pub trait Rule {
    fn apply(&self, graph: &mut Graph, meta: &mut MazeMeta, rng: &mut dyn RngCore);
}
```

- A rule may mutate `graph`, `meta`, or both.
- `rng` is provided by the caller — rules must not create their own RNG instances.
- Rules must be deterministic: given the same `graph`, `meta`, and `rng` state, `apply` must produce the same result.
- Rules must not depend on external or global state.

### RuleEngine

```rust
pub struct RuleEngine {
    rules: Vec<Box<dyn Rule>>,
}

impl RuleEngine {
    pub fn new(rules: Vec<Box<dyn Rule>>) -> Self;
    pub fn run(&self, graph: &mut Graph, meta: &mut MazeMeta, rng: &mut impl RngCore);
}
```

- Executes rules sequentially in insertion order.
- Uses a single shared `Rng` instance across all rules — this is what guarantees cross-rule determinism.
- Returns `()`. No rollback, no snapshot.

## Built-in Rules

### AssignStartRule

```rust
pub struct AssignStartRule;
```

- If `meta.start` is `Some`: no-op.
- If `meta.start` is `None`: collects all node ids, sorts them, picks one at random using `rng`.
- If graph is empty: leaves `meta.start` as `None`.

Sorting before selection guarantees determinism regardless of node insertion order.

### AssignFinishRule

```rust
pub struct AssignFinishRule;
```

- If `meta.finish` is `Some`: no-op.
- If `meta.finish` is `None` and `meta.start` is `Some`:
  - Computes `graph.reachable_from(start)` (BFS, outgoing edges only).
  - Removes `start` from candidates.
  - If no candidates remain: leaves `meta.finish` as `None`.
  - Otherwise picks a candidate at random using `rng`.
- If `meta.finish` is `None` and `meta.start` is `None`:
  - Falls back to all nodes in the graph, sorted.
  - This branch is only reached if `AssignFinishRule` runs before `AssignStartRule` — not the intended usage.

**Reachability semantics:** finish is always chosen from nodes reachable via outgoing edges from start. This matches gameplay reachability (directed movement). `AssignFinishRule` assumes a connected graph; on disconnected graphs finish may be `None`.

**Recommended order:** `AssignStartRule` must run before `AssignFinishRule`.

### NoOpRule

```rust
pub struct NoOpRule;
```

Does nothing. Useful as a placeholder or in pipeline tests.

## Determinism Contract

A rule pipeline is fully deterministic if:
1. The same graph structure is provided.
2. The same `MazeMeta` initial state is provided.
3. The same seed is used to construct the `Rng` passed to `run`.
4. Rules are added in the same order.

Both `AssignStartRule` and `AssignFinishRule` sort their candidate lists before sampling, making them independent of node insertion order in the graph.

## Integration Example

```rust
let mut meta = MazeMeta::empty();
let mut rng = SmallRng::seed_from_u64(seed);
let engine = RuleEngine::new(vec![
    Box::new(AssignStartRule),
    Box::new(AssignFinishRule),
]);
engine.run(&mut graph, &mut meta, &mut rng);
let maze = Maze { field, graph, meta };
```

## Future Extensions (not implemented)

- Rule phases (pre / post / validation)
- Rule priority or dependency declarations
- Region rules, teleport rules, one-way edge rules
- Validation rules (read-only, return errors instead of mutating)
