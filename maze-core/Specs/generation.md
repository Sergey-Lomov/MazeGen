# Generation

## Purpose

Build maze structure by adding edges to a Graph. Operates on a Graph that already has nodes (built by `Field::build_graph`). Does not know about coordinates — uses `Field::neighbors` for adjacency.

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
    graph.add_edge(current, chosen, EdgeKind::Basic)
    visited.insert(chosen)
    stack.push(chosen)
```

## API

```rust
pub fn generate_maze<F: Field>(graph: &mut Graph, field: &F, seed: u64, start: NodeId)
```

## Contracts

- Graph must contain all nodes before calling (call `field.build_graph` first).
- `seed` is mandatory — no default. Same seed + same field = identical maze.
- `start` is the DFS origin. All nodes reachable from start will be connected.
- Result is a spanning tree: `node_count - 1` edges, fully connected.

## RNG

`rand::rngs::SmallRng` (xoshiro256) seeded via `SeedableRng::seed_from_u64(seed)`. Fast, deterministic, no external entropy.

## Future

Rules (bridges, teleports, one-way, doors) will add edges with non-Basic EdgeKind after generation. Generation itself stays algorithm-only — no rule logic here.
