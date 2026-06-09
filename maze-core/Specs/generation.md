# Generation

## Purpose

Build maze structure by adding edges to a Graph. Operates on a Graph that already has nodes (built by `Field::build_nodes`). Does not know about coordinates — uses `Field::neighbors` for adjacency.

## Overview

Three algorithms available: `CustomVertexBased` (default), `RecursiveBacktracker`, and `WilsonAlgorithm`. All share an `add_edge` helper that applies `ElementsConfig.one_way_chance`:

```
fn add_edge(graph, src, dst, elements, rng):
  if rng.random::<f64>() < elements.one_way_chance:
    if rng.random::<bool>(): graph.add_edge(src, dst)
    else:                     graph.add_edge(dst, src)
  else:
    graph.add_bidirectional_edge(src, dst)
```

Note: one-way edges consume two RNG samples; bidirectional consumes one. This means maze topology changes between runs with `one_way_chance > 0` and `one_way_chance == 0`, even at the same seed.

## Algorithms

### Custom Vertex-Based (`GenerationAlgorithm::CustomVertexBased`)

Frontier-based algorithm with configurable parameters. Maintains a frontier set and a reserve set; supports configurable depth-first vs. breadth-first bias, corridor vs. junction probability, extra branching, and directional preference.

### Wilson's Algorithm (`GenerationAlgorithm::WilsonAlgorithm`)

Loop-erased random walk. Produces a uniformly random spanning tree — every possible maze has equal probability. Visually the most organic: no visible patterns, corridors vary in length and direction naturally.

Algorithm: mark `start` as visited. While unvisited nodes remain, pick one at random and perform a random walk until hitting any visited node, erasing loops as they form. Commit the resulting path to the maze. Repeat.

```
visited = {start}
unvisited = all_nodes \ {start}

while unvisited not empty:
  walk_start = unvisited[random]
  next: HashMap<NodeId, NodeId> = {}
  current = walk_start
  loop:
    chosen = field.neighbors(current)[random]
    next[current] = chosen
    if visited.contains(chosen): break
    current = chosen
  node = walk_start
  while not visited.contains(node):
    add_edge(graph, node, next[node], elements, rng)
    visited.insert(node)
    node = next[node]
  unvisited.retain(not in visited)
```

### Recursive Backtracker (`GenerationAlgorithm::RecursiveBacktracker`)

Classic randomized DFS. Stack-based traversal: always extends from the most recently visited node; backtracks when no unvisited neighbors remain. Produces perfect mazes with long winding corridors. No algorithm-specific parameters.

```
visited: HashSet<NodeId> = {start}
stack: Vec<NodeId> = [start]
rng = SmallRng::seed_from_u64(seed)

while stack not empty:
  current = stack.last()
  unvisited = field.neighbors(current).filter(not in visited)
  if unvisited is empty:
    stack.pop()
  else:
    chosen = unvisited[rng.random_range(0..len)]
    add_edge(graph, current, chosen, elements, rng)
    visited.insert(chosen)
    stack.push(chosen)
```

## Parameters

### `GenerationParams` (Custom Vertex-Based only)

`GenerationParams` is `pub` within `maze-core` but is **not re-exported** from the crate root (`lib.rs`). External crates access it only through `GenerationAlgorithm::CustomVertexBased(...)` or `GenerationConfig`. Direct construction requires `use maze_core::generation::GenerationParams`.

```rust
pub struct GenerationParams {
    pub depth_first:     f64,  // 0.0–1.0, default 0.9
    pub corridor_chance: f64,  // 0.0–1.0, default 0.7
    pub branching:       f64,  // 0.0–1.0, default 0.5
    pub directionality:  f64,  // 0.0–1.0, default 0.0
}
```

- `depth_first` — probability of selecting the most-recently-added frontier node vs. a random one. 1.0 = pure DFS (long corridors), 0.0 = pure BFS/random (wide branching).
- `corridor_chance` — probability of treating a junction as a corridor (single child). Lower values produce more branching junctions.
- `branching` — per-extra-branch probability at a junction. At 0.0 junctions always produce exactly 2 branches; at 1.0 all free neighbors are connected.
- `directionality` — probability of preferring a straight-line neighbor when extending a corridor. Higher values produce longer straight passages.

### `ElementsConfig` (all algorithms)

```rust
pub struct ElementsConfig {
    pub one_way_chance: f64,  // 0.0–1.0, default 0.04
}
```

- `one_way_chance` — probability of placing an edge as one-way (single direction) instead of bidirectional. Applied by every algorithm when adding an edge.

### `GenerationConfig`

```rust
pub struct GenerationConfig {
    pub algorithm: GenerationAlgorithm,
    pub elements:  ElementsConfig,
}
```

## API

```rust
pub fn generate_maze<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
)

pub fn generate_maze_steps<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
) -> Vec<GenerationStep>
```

`generate_maze_steps` returns a snapshot of all edges after each step — used for debug visualization.

## Contracts

- Graph must contain all nodes before calling (call `field.build_nodes` first).
- `seed` is mandatory — no default. Same seed + same field + same params = identical maze.
- `start` is the DFS origin. All nodes reachable from start will be connected.
- Result is a spanning tree: `node_count - 1` corridors, `2 * (node_count - 1)` directed edges when `one_way_chance == 0`, fewer when `one_way_chance > 0` (one-way edges contribute 1 directed edge instead of 2).
- Connectivity guarantee: with `one_way_chance == 0` the result is strongly connected. With `one_way_chance > 0` the result is weakly connected (a path exists ignoring edge direction), but strong connectivity is not guaranteed.

## RNG

`rand::rngs::SmallRng` (xoshiro256) seeded via `SeedableRng::seed_from_u64(seed)`. Fast, deterministic, no external entropy.

## Future

Rules (bridges, teleports, one-way, doors) will add edges with non-Basic EdgeKind after generation. Generation itself stays algorithm-only — no rule logic here.
