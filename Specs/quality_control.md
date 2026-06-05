# Quality Control

A read-only analysis pass that detects problems in a `Maze` and produces a list of `Issue` values. Runs before and after each repair iteration in the pipeline.

## Core Concepts

### IssueKind

```rust
pub type IssueKind = &'static str;
```

String identifier for a problem type. Always define as a named constant — never use string literals inline.

Built-in constants:

```rust
pub const MISSING_START: IssueKind = "missing_start";
pub const MISSING_FINISH: IssueKind = "missing_finish";
pub const UNREACHABLE_FINISH: IssueKind = "unreachable_finish";
```

### Issue

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub kind: IssueKind,
}

impl Issue {
    pub fn new(kind: IssueKind) -> Self;
}
```

### Check trait

```rust
pub trait Check<F: Field> {
    fn check(&self, maze: &Maze<F>, issues: &mut Vec<Issue>);
}
```

- **Read-only**: `maze` is immutable. A `Check` must not mutate any state.
- **No side effects**: `check` must not access global state, perform I/O, or produce non-deterministic output.
- A check may produce zero or more issues per call.
- A check may read `maze.analysis` to avoid redundant computation.

### QualityControlEngine

```rust
pub struct QualityControlEngine<F: Field> {
    checks: Vec<Box<dyn Check<F>>>,
}

impl<F: Field> QualityControlEngine<F> {
    pub fn new(checks: Vec<Box<dyn Check<F>>>) -> Self;
    pub fn run(&self, maze: &Maze<F>) -> Vec<Issue>;
}
```

- Runs checks in insertion order.
- Returns all issues collected across all checks, including duplicates.
- Issues from earlier checks appear before issues from later checks.
- Deduplication of issues with the same `IssueKind` is the pipeline's responsibility, not the engine's.

## Built-in Checks

### MissingStartCheck

Produces `Issue::new(MISSING_START)` if `maze.meta.start.is_none()`.

### MissingFinishCheck

Produces `Issue::new(MISSING_FINISH)` if `maze.meta.finish.is_none()`.

### UnreachableFinishCheck

Produces `Issue::new(UNREACHABLE_FINISH)` if both `maze.meta.start` and `maze.meta.finish` are `Some` but `finish` is not reachable from `start` via directed graph traversal (`graph.reachable_from(start)`).

Skips the check silently if either `start` or `finish` is `None` — those cases are covered by `MissingStartCheck` and `MissingFinishCheck`.

## Usage Example

```rust
let engine = QualityControlEngine::new(vec![
    Box::new(MissingStartCheck),
    Box::new(MissingFinishCheck),
]);
let issues = engine.run(&maze);
```

## Architectural Contract

Only code that owns the `Maze` may call `&mut self` accessors on `maze.analysis`. QC checks and repair strategies may read `maze.analysis` via shared reference but must not write to it.

`MazeAnalysis` caches derived data lazily. See `analysis.md` for the full contract. No QC checks currently read from it.
