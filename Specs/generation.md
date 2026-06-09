# Maze Generation Algorithm

## Overview

Maze generation produces a spanning tree (or near-spanning tree with optional one-way edges) over all nodes of a field. The algorithm is a **frontier-based growth** process driven by five parameters that control the character of the resulting structure.

## Parameters

| Parameter | Range | Default | Effect |
|-----------|-------|---------|--------|
| `depth_first` | 0.0–1.0 | 0.9 | Probability of picking the most-recently-added entry from the frontier (or reserve). 0 = random (BFS-like), 1 = LIFO (DFS-like). |
| `corridor_chance` | 0.0–1.0 | 0.7 | Probability that a chosen node makes exactly one connection. 1.0 = pure corridors, 0.0 = always a junction. |
| `branching` | 0.0–1.0 | 0.5 | Controls junction width via binomial distribution. 0 = always 2 connections, 1 = always maximum possible connections. Each additional connection beyond 2 is added independently with probability `branching`. |
| `directionality` | 0.0–1.0 | 0.0 | Probability of preferring a straight-ahead neighbor (aligned with the incoming direction) when making the **first** connection from a node. Applies to both corridor and junction nodes — for junctions, only the first candidate uses directionality; remaining candidates are random. Requires `Field::is_straight`. Has no effect when there is no parent. |
| `one_way_chance` | 0.0–1.0 | 0.04 | Probability that any given edge is directed (one-way) rather than bidirectional. Direction (src→dst or dst→src) is chosen with equal probability. |

## Algorithm

### Invariants

- Every node is chosen from the frontier **exactly once** before being processed.
- A node in `in_frontier` is **not eligible** as a connection candidate for other frontier nodes (it already has a future parent).
- The reserve contains only unvisited nodes that were skipped when their neighbor was processed.

### Main Loop

```
frontier = [start]
visited = {start}
reserve = []

loop:
  if frontier is empty:
    src = pop_reserve()          // same depth_first logic as frontier
    if none: break
    if src already visited: continue
    bridge = random visited neighbor of src
    add_edge(bridge, src)
    mark src visited
    push src to frontier (parent = bridge)
    on_step callback
    continue

  fi = choose_from_frontier()    // depth_first: last index vs random
  src = frontier[fi]
  remove src from frontier

  free_neighbors = neighbors(src) that are not visited and not in_frontier

  if rand < corridor_chance:
    connected = [choose_candidate(free_neighbors, parent, src)]  // directionality applied
  else:
    count = junction_count(len(free_neighbors))                  // binomial via branching
    connected = choose_junction_candidates(free_neighbors, count)

  for dst in connected:
    add_edge(src, dst)
    mark dst visited
    remove dst from reserve if present
    push dst to frontier (parent = src)

  for n in free_neighbors not in connected:
    add n to reserve if not already there

  if connected is not empty: on_step callback
```

### Reserve

The reserve stores unvisited nodes that were bypassed when their neighbor was processed. When the frontier empties but unvisited nodes remain (disconnected subgraph or nodes only reachable via frontier-excluded paths), a reserve node is popped and **bridged** to a random already-visited neighbor with a new edge. This restores connectivity without violating the single-parent invariant.

Reserve population uses the same `depth_first` selection as the frontier.

**Ordering constraint**: when the frontier empties, the algorithm scans the reserve looking for a node that has at least one visited neighbor. Nodes that have no visited neighbor yet are re-queued to the back of the reserve and tried later. The scan stops after exhausting all nodes present at scan start (bounded by the reserve size at that moment) — this prevents an infinite loop when the entire remaining reserve is unreachable from the visited set (e.g. a truly disconnected field). Any nodes left in such an unreachable cluster will not be connected.

### `junction_count` — binomial distribution

```
count = 2
for i in 0..max.saturating_sub(2):
    if rand() < branching: count += 1
```

- `branching = 0` → always 2
- `branching = 1` → always `max`
- intermediate values shift distribution toward higher counts
- **precondition**: `max >= 2` (callers must ensure this)

### Junction branch — edge cases for `free_neighbors` count

The junction branch (`corridor_chance` roll failed) handles small neighbor counts before calling `junction_count`:

- `max = 0` → empty `connected`; node makes no connections, all neighbors (none) go to reserve
- `max = 1` → `connected = [free_neighbors[0]]` unconditionally; `junction_count` not called
- `max >= 2` → `junction_count(max, ...)` determines connection count in range `[2, max]`

## Step Snapshots (`generate_maze_steps`)

Returns the full edge list after **each step** (each node processing that produces at least one edge). Steps are full snapshots, not deltas. Intended for visual debugging only — memory cost is O(nodes × edges) for large fields.

## WASM Interface

Parameters are passed via the `generation` field of `GenerateConfig` (all optional, fallback to defaults):

```json
{
  "generation": {
    "depth_first": 0.9,
    "corridor_chance": 0.7,
    "branching": 0.5,
    "directionality": 0.0,
    "one_way_chance": 0.04
  }
}
```

All values are clamped to `[0.0, 1.0]` in the WASM layer before use.
