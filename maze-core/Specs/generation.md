# Generation

## Purpose

Build maze structure by adding edges to a Graph. Operates on a Graph that already has nodes (built by `Field::build_nodes`). Does not know about coordinates — uses `Field::neighbors` for adjacency.

## Algorithm

Randomized DFS (recursive backtracker). Produces a spanning tree — every node reachable from start, no cycles.

```
visited: HashSet<NodeId>
stack: Vec<NodeId> = [start]
visited.insert(start)
rng = SmallRng::seed_from_u64(seed)

loop:
  current = stack.last()
  unvisited = field.neighbors(current).filter(not in visited)
  if unvisited is empty:
    stack.pop()
  else:
    chosen = unvisited[rng.random_range(0..len)]
    graph.add_bidirectional_edge(current, chosen, EdgeKind::Basic)
    visited.insert(chosen)
    stack.push(chosen)
```

Each corridor is represented as two directed edges (both directions). Result has `2 * (node_count - 1)` edges total.

## Generation Parameters

```rust
pub struct GenerationParams {
    pub depth_first:     f64,  // 0.0–1.0, default 0.9
    pub corridor_chance: f64,  // 0.0–1.0, default 0.7
    pub branching:       f64,  // 0.0–1.0, default 0.5
    pub directionality:  f64,  // 0.0–1.0, default 0.0
    pub one_way_chance:  f64,  // 0.0–1.0, default 0.04
}
```

- `depth_first` — probability of selecting the most-recently-added frontier node vs. a random one. 1.0 = pure DFS (long corridors), 0.0 = pure BFS/random (wide branching).
- `corridor_chance` — probability of treating a junction as a corridor (single child). Lower values produce more branching junctions.
- `branching` — per-extra-branch probability at a junction. At 0.0 junctions always produce exactly 2 branches; at 1.0 all free neighbors are connected.
- `directionality` — probability of preferring a straight-line neighbor when extending a corridor. Higher values produce longer straight passages.
- `one_way_chance` — probability of adding an edge as one-way (single direction) instead of bidirectional.

## API

```rust
pub fn generate_maze<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    params: GenerationParams,
)

pub fn generate_maze_steps<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    params: GenerationParams,
) -> Vec<GenerationStep>
```

`generate_maze_steps` returns a snapshot of all edges after each step — used for debug visualization.

## Contracts

- Graph must contain all nodes before calling (call `field.build_nodes` first).
- `seed` is mandatory — no default. Same seed + same field + same params = identical maze.
- `start` is the DFS origin. All nodes reachable from start will be connected.
- Result is a spanning tree: `node_count - 1` corridors, up to `2 * (node_count - 1)` directed edges (fewer when `one_way_chance > 0`), fully connected.

## RNG

`rand::rngs::SmallRng` (xoshiro256) seeded via `SeedableRng::seed_from_u64(seed)`. Fast, deterministic, no external entropy.

## Future

Rules (bridges, teleports, one-way, doors) will add edges with non-Basic EdgeKind after generation. Generation itself stays algorithm-only — no rule logic here.
