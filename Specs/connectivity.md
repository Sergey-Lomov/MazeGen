# Connectivity Analysis

Strongly connected components (SCC) of the maze graph. Two nodes belong to the same component if and only if each is reachable from the other via directed edges.

A one-way edge between two groups keeps them in separate components even if all nodes are mutually reachable in some direction. For example: group A (0⇄1), group B (2⇄3), edge 0→2 — A can reach B but B cannot reach A, so they are two distinct SCCs.

## Location

`maze_core::graph::scc`

## Core Concepts

### ComponentId

```rust
pub type ComponentId = usize;
```

Index into `ConnectedComponents::components`.

### ConnectedComponents

```rust
#[derive(Debug, Clone)]
pub struct ConnectedComponents {
    /// Each entry is one SCC: a sorted list of NodeIds.
    pub components: Vec<Vec<NodeId>>,
    /// Maps each NodeId to its component index.
    pub node_component: HashMap<NodeId, ComponentId>,
}

impl ConnectedComponents {
    pub fn component_of(&self, node: NodeId) -> Option<ComponentId>;
}
```

- `components[i]` contains all NodeIds of the i-th SCC, sorted.
- Component ordering: Tarjan finishes sink components first, so `components[0]` is a sink SCC (no outgoing edges to other SCCs).
- `node_component` enables O(1) lookup by NodeId.

## Builder

```rust
pub fn build_scc(graph: &Graph) -> ConnectedComponents
```

Uses Tarjan's algorithm (iterative, single DFS pass via explicit work stack). Recursion is avoided to prevent call-stack overflow on large graphs. Node iteration order is sorted by NodeId for determinism.

## Caching

`ConnectedComponents` is stored lazily in `MazeAnalysis`. See `analysis.md`.

```rust
impl MazeAnalysis {
    pub fn scc(&mut self, graph: &Graph) -> &ConnectedComponents;
}
```

## Visualization

In the web client, components are rendered as a semi-transparent color mask over maze tiles. Each component gets a distinct pastel color (HSL with hue spread across components, high lightness, moderate saturation). The layer sits above maze tiles but below all graph overlays. Toggle: **Components** in LayersPanel.

## WASM Export

`MazeSnapshot` includes:
```typescript
components: number[][]  // each sub-array is a sorted list of NodeIds for one SCC
```
