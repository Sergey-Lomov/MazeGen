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
| `cyclicity` | 0.0–1.0 | 0.0 | Per-node probability of adding an extra edge to an already-visited neighbor, creating a cycle. Evaluated independently of the normal corridor/junction selection. If triggered, one visited neighbor is chosen at random and connected; this happens regardless of whether `free_neighbors` is empty. The normal free-neighbor connections still proceed as usual after the cyclic edge is added. |
| `one_way_chance` | 0.0–1.0 | 0.04 | Probability that any given edge is directed (one-way) rather than bidirectional. Direction (src→dst or dst→src) is chosen with equal probability. |
| `teleport_chance` | 0.0–1.0 | 0.0 | Probability that, at each edge-addition opportunity this algorithm handles, the edge is a teleport (`EdgeKind::Teleport`, non-adjacent allowed) instead of a normal geometrically-adjacent connection. See "Teleport connections" below — the exact roll point and effect are algorithm-specific, not a separate pass. |
| `teleport_one_way_chance` | 0.0–1.0 | 0.0 | Probability that an added teleport is one-way rather than two-way. Only consulted when `teleport_chance` already hit — mirrors `one_way_chance`'s role but scoped to teleports. |

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

  cyclic_added = false
  if rand < cyclicity:
    cyclic_candidates = visited neighbors of src with no existing edge to/from src
    if cyclic_candidates not empty:
      add_edge(src, random cyclic_candidates)
      cyclic_added = true

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

  if connected is not empty or cyclic_added: on_step callback
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

## Teleport Connections

A **teleport** is a connection type (`EdgeKind::Teleport`, alongside `EdgeKind::Basic`) that links two tiles regardless of geometric adjacency — one-way or two-way, same as a `Basic` connection. Unlike an earlier design, teleports are **not** a separate post-generation pass: each generation algorithm rolls `teleport_chance` inline, at the same point it would otherwise commit to a normal geometrically-adjacent connection, and — on a hit — substitutes or adds a non-adjacent `Teleport` edge instead. This makes teleports full participants in the maze from the moment they're added: they are present from the repair pipeline's very first pass onward — cycle-removal strategies (`InvalidLoopRandomStrategy`, `InvalidLoopScoredStrategy`) can remove a `Teleport` edge exactly like a `Basic` one, since SCC/cycle code operates purely on graph traversal and never branches on edge kind. Repair strategies that *add* connections (e.g. region-merge) do not create teleports — that is a separate, not-yet-implemented capability.

Only `CustomVertexBased` and `CustomEdgeBased` support `teleport_chance`/`teleport_one_way_chance` — each has its own model, described in its own section below (`CustomVertexBased`'s model is described here; `CustomEdgeBased`'s is under its own heading further down). `RecursiveBacktracker`, `WilsonAlgorithm`, and `KruskalAlgorithm` are canonical textbook algorithms with no notion of directionality or non-adjacent connections; they add only plain bidirectional passages and ignore `elements` entirely (`one_way_chance`, `teleport_chance`, `teleport_one_way_chance` have no effect on them). Any one-way passages or teleports on top of a canonical algorithm's output must be introduced afterward via QC repair strategies.

**Preset teleports are traversable by every algorithm, independent of `teleport_chance`** (GitHub issue #226). `build_preset_state` plants a preset `PresetConnectionState::Teleport`'s edge(s) directly into the graph before generation starts (see `Specs/preset-connections.md`) and records each source node's teleport destinations in `PresetState.preset_teleports: HashMap<NodeId, Vec<NodeId>>` — unlike `preset_connected` (for geometrically-adjacent preset pairs), a teleport pair isn't discoverable via `field.neighbors`, so every algorithm consults `preset_teleports` directly to treat a source node's preset-teleport destinations as extra traversable neighbors of that node, on top of its geometric ones:
- `RecursiveBacktracker`/`WilsonAlgorithm`: the destination joins the current node's neighbor/candidate pool unconditionally (bypassing `can_connect`, which only gates *adding* a new edge — irrelevant here since the edge already exists) and, once chosen, is marked visited without adding a duplicate edge.
- `KruskalAlgorithm`: needs no special-casing — it pre-unions every edge already present in the graph (including preset teleports) into its union-find structure before the main edge loop, so preset-teleported nodes start in the same set.
- `CustomEdgeBased`/`CustomVertexBased`: the destination joins the geometric candidate pool (gated only on being Unseen/unvisited, not `can_connect`) regardless of this step's own `teleport_chance` roll — a preset teleport's connectivity doesn't depend on the algorithm's own dynamic-teleport dice.

**Parallel edges are allowed by design**: a `Teleport` edge may coexist with a `Basic` (or other-kind) edge in the same direction between the same pair — e.g. a tile already reachable by a normal passage can also have a teleport into it. `Graph::add_edge`'s dedup is kind-aware (only refuses to add a duplicate of the *same* kind in the same direction); the public `Graph::edge_between(from, to)` still returns an arbitrary edge of any kind between the pair, so code needing a specific kind must filter `Graph::edges()` itself. There is no per-node exclusivity constraint — a node may participate in any number of teleport connections.

### `CustomVertexBased` teleport model

The teleport roll interacts with two different situations in the main loop:

1. **Frontier empty**: before the normal reserve-bridging logic runs, `teleport_chance` is rolled once. On a hit, a random unvisited node (from all nodes in the field, not restricted to the reserve) is teleported in from a random already-visited node — this replaces the reserve-bridge mechanism for this step entirely. On a miss, the reserve-bridging logic proceeds unchanged. If the roll hits but no unvisited node remains, generation ends (same as the reserve running out).
2. **Frontier non-empty**: immediately after `src` is popped from the frontier (before building the free-neighbor pool), `teleport_chance` is rolled once (`teleport_hit`). This affects two later steps for the same `src`:
   - **Cyclic roll**: if `cyclicity` also triggers this step, and `teleport_hit`, the cyclic-edge candidate pool widens from "visited geometric neighbors of `src`" to "any visited node in the graph," and the added cyclic edge becomes a `Teleport` instead of `Basic`. In this case the teleport roll is considered "spent" on the cyclic edge and does **not** also apply to the corridor/junction step below.
   - **Corridor/junction step** (only if the teleport roll was not spent on the cyclic edge): an extra `Teleport` connection to a random unvisited node (anywhere in the field) is added **alongside** whatever the corridor/junction logic already produces. For junctions, `junction_count` is rolled against one extra virtual slot (`max + 1` instead of `max`) so the teleport doesn't add branching beyond what would have been chosen anyway — `count - 1` geometric connections are taken, leaving exactly one slot for the teleport. If no unvisited node remains, the teleport is simply skipped (no substitute effect).

In both situations, once a hit is confirmed and a candidate exists, `teleport_one_way_chance` decides one-way vs two-way, and (if one-way) a further 50/50 pick decides direction — added via `EdgeKind::Teleport`.

## WASM Interface

Algorithm parameters are passed via the `initial` field of `GenerateConfig`:

```json
{
  "initial": {
    "method": "custom_vertex_based",
    "depth_first": 0.9,
    "corridor_chance": 0.7,
    "branching": 0.5,
    "directionality": 0.0,
    "cyclicity": 0.0
  },
  "elements": { "one_way_chance": 0.04, "teleport_chance": 0.0, "teleport_one_way_chance": 0.0 }
}
```

All numeric values are clamped to `[0.0, 1.0]` in the WASM layer before use.

## QC Experiment Mode

`GenerateConfig.qc_experiment: bool` (default `false`) skips the generation algorithm entirely — no `generate_maze` call is made. The graph fed into `build_maze`'s QC/repair pass is exactly what `build_preset_state` built from the preset connections (Passage/OneWay edges applied, nothing else) — lets a user hand-craft an arbitrary preset setup and observe how QC/repair reshapes it in isolation, without generation noise.

**No preset protection in this mode.** The `PresetState` passed to `build_maze` is `PresetState::empty()` (via `PresetState::for_repair(qc_experiment)`, `maze-core/src/generation/preset_state.rs`) rather than the one `build_preset_state` actually computed — repair is free to add or remove any edge, including ones the preset setup established (Wall-blocked pairs, Passage edges, locked nodes, manual or auto-computed). The graph itself still starts from the preset setup; only the *constraints* repair would otherwise honor are dropped. `maze-wasm::run_generate` and `maze-runner::run_generate_typed` both apply this identically, so native repro tests (`maze-runner/tests/repro.rs`) faithfully reproduce browser QC-experiment behavior.

Web UI: a "QC Only" toggle (`Switch`) on the generation card, next to Generate/Re-Generate, always available (no dev/debug gating) — see GitHub issue #96 (originally a separate button, GitHub issue #93). The toggle is a persistent part of generation config: `qcExperiment` (`maze-web/src/store/storeTypes.ts`) is serialized into the project file (`ProjectFile.generation.qcExperiment`, `maze-web/src/store/projectExport/types.ts`), so loading a project restores it and the next `generate`/`regenerate` call reproduces `qc_experiment` correctly without the user re-selecting the mode. Since the toggle can be flipped after a run without a new generation happening, a separate `lastUsedQcExperiment` flag records what the last actual `generate`/`regenerate`/`loadProject` call used; the debug-export payload (`buildExactGenerateCallPayload`) reads `lastUsedQcExperiment`, not the live toggle, so it faithfully reproduces the exact config the core actually last received.

---

## CustomEdgeBased Algorithm

### Overview

Edge-first growth model. A node is selected from the active set, then a neighbor is chosen via weighted sampling. Normally one edge is added per step; when `cyclicity` triggers, an additional edge to a visited neighbor may also be added. No explicit degree constraints — structure emerges from stochastic decisions.

Produces a spanning tree of the subgraph reachable from `start`. Geometrically disconnected clusters remain unconnected.

### Parameters

| Parameter | Range | Default | Effect |
|---|---|---|---|
| `corridor_length` | 0.0–1.0 | 0.5 | Probability of advancing to the last-connected destination as the next `src` (chain: A→B→C→…). 0 = no chaining, 1 = always continue from last destination. |
| `branching` | 0.0–1.0 | 0.5 | Weight boost for destinations with more unseen neighbors. Uses `sqrt` of the free-neighbor count. 0 = uniform, 1 = strongly prefer high-potential destinations. |
| `locality` | 0.0–1.0 | 0.0 | Bias toward `src` nodes closer to start (by tree depth). 0 = uniform selection, 1 = strongly prefer shallow nodes. **Not yet implemented in core or UI.** |
| `directionality` | 0.0–1.0 | 0.0 | Weight multiplier (up to 4×) for candidates geometrically straight ahead from `src`'s parent. Requires `Field::is_straight`. Has no effect when `src` has no parent or when corridor chaining fired this step. |
| `cyclicity` | 0.0–1.0 | 0.0 | Per-step probability of adding an extra edge to an already-visited neighbor, independent of the normal dst selection. If triggered and a visited neighbor exists, one is chosen at random and connected; `last_dst` is not updated (visited node cannot seed a corridor chain). The normal unseen-neighbor dst selection still proceeds as usual. |

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

### Teleport model

Immediately after `src` is chosen (before any candidate pool is built), two rolls are made: `teleport_flag` and `cyclic_flag = rand() < cyclicity`. A single derived flag, `use_geometric_pool = !teleport_flag || cyclic_flag`, then governs every later choice this step.

**Both `teleport_flag` and `cyclic_flag` are rolled at most once per node, not once per connection opportunity.** A node can become `src` several times before exhausting its geometric neighbors (each pop from `active` is a separate connection opportunity) — rolling `teleport_chance`/`cyclicity` fresh on every one of those visits would make the node's effective probability compound with its degree instead of applying once per node. `NodeEntry` tracks `teleport_rolled` and `cyclic_rolled` flags: the first time a node is popped as `src`, each flag is rolled (`rand() < teleport_chance` / `rand() < cyclicity`) and the corresponding `*_rolled` flag is set (regardless of hit or miss); every subsequent time the same node is popped as `src`, the flag is `false` unconditionally and no sample is drawn — the node falls back to the normal geometric pool (for teleport) or skips the cyclic-edge attempt (for cyclic) for its remaining connection opportunities.

- **Candidate pool**: if `use_geometric_pool`, the normal unseen-geometric-neighbors pool (as without teleports). Otherwise, the pool is every Unseen node in the graph except `src` (`can_connect`-filtered, no adjacency restriction, sorted for determinism) — i.e. `teleport_flag` fired and `cyclic_flag` did not, so the teleport replaces the normal dst choice entirely rather than adding to it. If this pool is empty, the step is skipped exactly like an empty geometric pool would be (`continue`/deactivate `src`).
- **Weighting**: the `branching` weight always applies. The `directionality` multiplier only applies when `use_geometric_pool && !corridor_fired` — non-adjacent candidates have no meaningful "straight ahead," so directionality is skipped for a pure-teleport dst choice.
- **Cyclic edge** (unchanged trigger point, `cyclic_flag`): if `teleport_flag` is also set, the cyclic partner is drawn from all visited nodes in the graph (not just geometric neighbors), and the edge is added as `EdgeKind::Teleport` via `teleport_one_way_chance`. If `teleport_flag` is not set, the cyclic edge behaves exactly as without teleports (`EdgeKind::Basic`, geometric visited neighbors only).
- **Edge addition**: if `use_geometric_pool`, the chosen dst is connected as `EdgeKind::Basic` via `one_way_chance` (unchanged). Otherwise the chosen dst is connected as `EdgeKind::Teleport` via `teleport_one_way_chance`.

Net effect: when `cyclicity` fires alongside a teleport roll, the teleport is "spent" on the cyclic edge and the step's normal dst choice stays on the geometric pool (mirroring `CustomVertexBased`'s "teleport spent on cycle" rule) — otherwise the teleport fully replaces (not augments) the normal dst choice.

**Dead-hit edge case**: a node's teleport roll can hit while the teleport candidate pool (every Unseen node in the graph) is empty — e.g. near the end of generation, when almost every node has already transitioned out of Unseen. In that case the step is skipped entirely (`continue`, node deactivated) with no edge added at all for that node's own roll. The node can still end up with an outgoing `Basic` edge later, but only as the *other* direction of a bidirectional connection initiated by a different node's own (non-teleport) roll — not as a consequence of its own hit.

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
  "directionality": 0.0,
  "cyclicity": 0.0
}
```

All values are clamped to `[0.0, 1.0]` before use. `one_way_chance`, `teleport_chance`, and `teleport_one_way_chance` are not part of `CustomEdgeBased`'s own parameters — they are configured separately via the `elements` section of the generation config (see "Teleport model" above for how `CustomEdgeBased` interprets them).
