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

Each step carries:
- `edges` — full edge list at this step
- `active_nodes` — node ids currently in the frontier/active set (highlighted in blue overlay)
- `current_src` — node id chosen as source this step, or `null` (highlighted in yellow overlay)

The client prepends a synthetic first step `{ edges: [], active_nodes: [], current_src: null }` so step 0 shows the empty graph before any edges are added. Start/finish markers are hidden for all steps except the last.

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

---

## CustomEdgeBased Algorithm

### Overview

Edge-first growth model. A node is selected from the active set, then a neighbor is chosen via weighted sampling. One edge is added per step. No explicit degree constraints — structure emerges from stochastic decisions.

Produces a spanning tree of the subgraph reachable from `start`. Geometrically disconnected clusters remain unconnected.

### Parameters

| Parameter | Range | Default | Effect |
|---|---|---|---|
| `corridor_length` | 0.0–1.0 | 0.5 | Probability of advancing to the last-connected destination as the next `src` (chain: A→B→C→…). 0 = no chaining, 1 = always continue from last destination. |
| `branching` | 0.0–1.0 | 0.5 | Weight boost for destinations with more unseen neighbors. Uses `sqrt` of the free-neighbor count. 0 = uniform, 1 = strongly prefer high-potential destinations. |
| `locality` | 0.0–1.0 | 0.0 | Bias toward `src` nodes closer to start (by tree depth). 0 = uniform selection, 1 = strongly prefer shallow nodes. |
| `directionality` | 0.0–1.0 | 0.0 | Weight multiplier (up to 4×) for candidates geometrically straight ahead from `src`'s parent. Requires `Field::is_straight`. Has no effect when `src` has no parent or when corridor chaining fired this step. |

### Invariants

- `NodeState ∈ {Unseen, Active, Visited}` — single source of truth, no separate HashSets
- `node_state[n] == Active` ⟺ `n ∈ active`
- Each node transitions `Unseen → Active → Visited` exactly once
- `last_dst` is reset to `None` when the referenced node is removed from active

### Source Selection (`choose_src`)

Two-state machine:

1. **Corridor attempt**: if `last_dst` exists and `rng.random() < corridor_length`, use `last_dst` as next `src` if it still has unseen neighbors. This creates a chain A→B→C→… where each newly connected node becomes the next source.
2. **Locality weighted sampling**: weight for each node = `exp(-locality * depth / max_depth_in_active)`. Dynamic normalization by current max depth prevents center-biased growth over time.

### Destination Weighting

For each unseen neighbor `dst` of `src`:

```
free = count of unseen neighbors of dst
w = 1.0 + branching * sqrt(free)
if not corridor_fired and parent(src) exists and is_straight(parent(src), src, dst):
    w *= 1.0 + directionality * 3.0
```

`sqrt` normalization prevents hub nodes (high tessellation degree) from dominating. `corridor_fired` is true when the corridor attempt succeeded this step — in that case directionality is skipped so the two effects remain orthogonal.

### Termination and Disconnected Nodes

The algorithm terminates when `active` becomes empty. Unlike `CustomVertexBased`, there is **no reserve mechanism** and no recovery path for unreachable nodes. Any node not reachable from `start` via unseen-neighbor chains will never be added to `active` and will remain isolated — no edge will be created for it.

This differs from `CustomVertexBased`, which bridges isolated clusters back to the visited set via the reserve. `CustomEdgeBased` produces a spanning tree strictly of the reachable subgraph.

### WASM JSON Format

```json
{
  "method": "custom_edge_based",
  "corridor_length": 0.5,
  "branching": 0.5,
  "locality": 0.0,
  "directionality": 0.0
}
```

All values are clamped to `[0.0, 1.0]` before use. `one_way_chance` is not part of `CustomEdgeBased` parameters — it is configured separately via the `elements` section of the generation config.
