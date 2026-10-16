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
| `one_way_chance` | 0.0–1.0 | 0.0 | Probability that any given edge is directed (one-way) rather than bidirectional. Direction (src→dst or dst→src) is chosen with equal probability. |
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
    src = find_reachable_reserve_candidate()   // full pass, see "Reserve" section
    if none: break
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

Reserve population uses the same `depth_first` selection as the frontier — the weighted pick applies to which *reachable* candidate wins when several qualify (see "Ordering constraint" below), not to the order candidates are drawn for eligibility checking.

**Multi-floor reserve population (GitHub issue #337 follow-up)**: on a multi-floor field, every ordinary growth step also pushes `src`'s `MultiLevelField::vertical_neighbors(src)` (its potential `VerticalPassage` partner node(s) on the floor(s) directly above/below, whether or not an edge to them exists yet) into the reserve, the same way an unconnected geometric free neighbor is queued. Without this, a floor that never won the per-step `vertical_chance` roll during ordinary growth has no path back into the frontier at all — every node on it stays permanently unvisited once the active floor's own growth finishes, since geometric reserve-population never crosses floors. This queuing is a pure addition alongside the existing geometric-neighbor queuing above — it does not change which geometric neighbors get queued or how.

**Ordering constraint**: when the frontier empties, the algorithm performs a single deterministic linear pass over the entire reserve, checking each node exactly once for at least one visited neighbor — on a multi-floor field this check also considers `vertical_neighbors`, not just geometric `neighbors`, so a candidate whose only visited neighbor is a vertical partner is found rather than being skipped forever. Every node already visited by the time it's scanned is dropped; every unvisited node with no visited neighbor (by either kind) is kept for a later pass. If the pass finds one or more reachable candidates, the winner is chosen via the same `depth_first`-weighted pick as the frontier, and every other reachable candidate found this pass goes back into the reserve alongside the not-yet-reachable ones. Scanning the whole reserve exactly once, rather than popping candidates one at a time via a weighted-random draw with re-queuing, guarantees termination in bounded time and guarantees every reachable candidate present at scan start is actually found — a randomized pop-and-requeue loop cannot guarantee either, since the same not-yet-reachable candidate can resurface before every other candidate has had a turn (GitHub issue #356).

**Restart on total exhaustion (GitHub issue #417)**: if the pass finds no reachable candidate, the reserve mechanism alone is exhausted, but generation does not necessarily end — any node in the field that is still unvisited (regardless of whether it was ever queued into the reserve; a node whose neighbors were all frontier-excluded at the time it would have been queued may never have entered the reserve at all) makes it a candidate to seed a fresh growth component. A random unvisited node is picked (uniform, via `state.rng`) and treated the same way `start` is at the very beginning of the run: marked visited and pushed to the frontier with no parent and no bridge edge (`StartVisited` is emitted for it, same event the run's actual `start` uses in `GenState::new`) — no attempt is made to connect it to the already-visited set. Ordinary growth then continues from this new root exactly as from the original `start`, so the maze ends up with multiple disjoint spanning-tree components instead of one. Generation only truly ends (returns `false`) when no unvisited node remains anywhere in the field.

**Bridge kind selection**: once a reserve `src` is found, its geometric and vertical visited-neighbor candidates are collected separately. `vertical_chance` is rolled (same field as the ordinary per-step roll, `Specs/generation.md`'s "Vertical Connections" section) to decide whether the bridge is attempted as a `VerticalPassage` or as an ordinary geometric edge: a hit uses a vertical candidate if any exist; a miss falls back to a vertical candidate if no geometric candidate exists, **unless `vertical_chance == 0.0`** — that value is a hard disable (GitHub issue #416): no vertical connection is ever created, including as a fallback, even if it leaves a floor with no geometric bridge option unreachable. For the same reason, the reserve-search's own reachability scan only counts a vertical neighbor toward `has_visited_neighbor` when `vertical_chance > 0.0`, so a vertical-only-reachable candidate is never selected as `src` in the first place when vertical connections are disabled. A vertical bridge is added via the same one-way/direction rolls as an ordinary growth-time `VerticalPassage` (`one_way_vertical_passage_chance`/`vertical_up_down_balance`); the split-node path (`try_split_src`) only ever runs for a geometric bridge — it has no notion of a cross-floor edge.

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

Only `CustomVertexBased` supports `teleport_chance`/`teleport_one_way_chance` — its model is described below. `RecursiveBacktracker`, `WilsonAlgorithm`, and `KruskalAlgorithm` are canonical textbook algorithms with no notion of directionality or non-adjacent connections; they add only plain bidirectional passages and ignore `elements` entirely (`one_way_chance`, `teleport_chance`, `teleport_one_way_chance` have no effect on them). Any one-way passages or teleports on top of a canonical algorithm's output must be introduced afterward via QC repair strategies.

**Preset teleports are traversable by every algorithm, independent of `teleport_chance`** (GitHub issue #226). `build_preset_state` plants a preset `PresetConnectionState::Teleport`'s edge(s) directly into the graph before generation starts (see `Specs/preset-connections.md`) and records each source node's teleport destinations in `PresetState.preset_teleports: HashMap<NodeId, Vec<NodeId>>` — unlike `preset_connected` (for geometrically-adjacent preset pairs), a teleport pair isn't discoverable via `field.neighbors`, so every algorithm consults `preset_teleports` directly to treat a source node's preset-teleport destinations as extra traversable neighbors of that node, on top of its geometric ones:
- `RecursiveBacktracker`/`WilsonAlgorithm`: the destination joins the current node's neighbor/candidate pool unconditionally (bypassing `can_connect`, which only gates *adding* a new edge — irrelevant here since the edge already exists) and, once chosen, is marked visited without adding a duplicate edge.
- `KruskalAlgorithm`: needs no special-casing — it pre-unions every edge already present in the graph (including preset teleports) into its union-find structure before the main edge loop, so preset-teleported nodes start in the same set.
- `CustomVertexBased`: the destination joins the geometric candidate pool (gated only on being Unseen/unvisited, not `can_connect`) regardless of this step's own `teleport_chance` roll — a preset teleport's connectivity doesn't depend on the algorithm's own dynamic-teleport dice.

**Parallel edges are allowed by design**: a `Teleport` edge may coexist with a `Basic` (or other-kind) edge in the same direction between the same pair — e.g. a tile already reachable by a normal passage can also have a teleport into it. `Graph::add_edge`'s dedup is kind-aware (only refuses to add a duplicate of the *same* kind in the same direction); the public `Graph::edge_between(from, to)` still returns an arbitrary edge of any kind between the pair, so code needing a specific kind must filter `Graph::edges()` itself. There is no per-node exclusivity constraint — a node may participate in any number of teleport connections.

### `CustomVertexBased` teleport model

The teleport roll interacts with two different situations in the main loop:

1. **Frontier empty**: before the normal reserve-bridging logic runs, `teleport_chance` is rolled once. On a hit, a random unvisited node (from all nodes in the field, not restricted to the reserve) is teleported in from a random already-visited node — this replaces the reserve-bridge mechanism for this step entirely. On a miss, the reserve-bridging logic proceeds unchanged. If the roll hits but no unvisited node remains, generation ends (same as the reserve running out).
2. **Frontier non-empty**: immediately after `src` is popped from the frontier (before building the free-neighbor pool), `teleport_chance` is rolled once (`teleport_hit`). This affects two later steps for the same `src`:
   - **Cyclic roll**: if `cyclicity` also triggers this step, and `teleport_hit`, the cyclic-edge candidate pool widens from "visited geometric neighbors of `src`" to "any visited node in the graph," and the added cyclic edge becomes a `Teleport` instead of `Basic`. In this case the teleport roll is considered "spent" on the cyclic edge and does **not** also apply to the corridor/junction step below.
   - **Corridor/junction step** (only if the teleport roll was not spent on the cyclic edge): an extra `Teleport` connection to a random unvisited node (anywhere in the field) is added **alongside** whatever the corridor/junction logic already produces. For junctions, `junction_count` is rolled against one extra virtual slot (`max + 1` instead of `max`) so the teleport doesn't add branching beyond what would have been chosen anyway — `count - 1` geometric connections are taken, leaving exactly one slot for the teleport. If no unvisited node remains, the teleport is simply skipped (no substitute effect).

In both situations, once a hit is confirmed and a candidate exists, `teleport_one_way_chance` decides one-way vs two-way, and (if one-way) a further 50/50 pick decides direction — added via `EdgeKind::Teleport`.

### Teleport-cyclic geometric fallback (GitHub issue #337)

When `cyclic_fired && teleport_hit`, the teleport-widened candidate pool ("any visited node in the graph") is tried first. If that pool is empty, the algorithm now falls back to the ordinary geometric-neighbor pool (visited geometric neighbors of `src`) instead of skipping the cyclic edge outright — `teleport_spent_on_cycle` is `false` in this fallback case, so the teleport roll remains available for the corridor/junction step. This fallback applies on every maze regardless of floor count (it is not part of the multi-floor RNG-parity gating below) — it was introduced for consistency with the vertical-cyclic model described next. Since the widened pool is always a superset of the geometric pool under identical `visited`/`can_connect`/edge-existence filters, the fallback path is only ever reached when the geometric pool is *also* empty, in which case the cyclic edge fails cleanly with no candidate and no roll wasted.

## Vertical Connections (GitHub issue #337)

`CustomVertexBased` is the only algorithm that can connect floors of a `MultiLevelField` — the same reason it is the only one with a notion of `EdgeKind::Teleport`. Two new edge kinds exist for this: `EdgeKind::VerticalPassage` (a single edge between two adjacent floors, one-way or two-way) and `EdgeKind::Elevator` (a fully-connected fan across several — not necessarily adjacent — floors, always two-way).

`RecursiveBacktracker`, `WilsonAlgorithm`, and `KruskalAlgorithm` have no notion of `VerticalPassage`/`Elevator` at all — their neighbor lookups (`split_aware_neighbors`, and Kruskal's whole-field edge enumeration) are same-floor only (`MultiLevelField::neighbors`, not `vertical_neighbors`). On a multi-floor field they simply treat each floor as its own geometrically disconnected region: Kruskal produces one MST per floor naturally (each floor is its own DSU component); `RecursiveBacktracker`/`WilsonAlgorithm` produce one disjoint spanning-tree component per floor via their GitHub issue #417 restart mechanism (see below) — without that restart they would generate only the floor containing `start` and leave the rest empty.

### RNG-parity policy

`vertical_chance` and `cross_floor_teleport_balance` are only rolled when `field.level_count() > 1`. Floor count is a static property of the whole config, known before generation starts — unlike `teleport_chance`/`cyclicity`/`split_chance`, which are per-step runtime branches that must always be rolled ("always consumed regardless of value") to keep the RNG sequence identical across runs that take different branches. Skipping a statically-unreachable roll on a single-floor maze is not runtime branching, so it doesn't violate that principle — and it keeps every existing single-floor golden test byte-identical without regeneration.

### New parameters

All 8 new parameters live in `ElementsConfig` (not `GenerationParams`) alongside `cross_floor_teleport_balance` and the other cross-cutting connection-type params — `GenerationParams` is reserved for `CustomVertexBased`'s structural/growth-shape params (`depth_first`, `corridor_chance`, `branching`, `directionality`, `cyclicity`). All of them are consulted only by `CustomVertexBased` and only meaningful on a multi-floor field, but they're grouped with `ElementsConfig`'s other connection-type fields for consistency, same as `cross_floor_teleport_balance`.

| Parameter | Range | Default | Effect |
|---|---|---|---|
| `vertical_chance` | 0.0–1.0 | 0.0 | Probability, rolled on every growth-opportunity on a multi-floor maze (after the cyclic roll, before the corridor/junction step), of attempting a vertical connection. |
| `vertical_passage_elevator_balance` | 0.0–1.0 | 0.5 | Balance between `VerticalPassage` (0) and `Elevator` (1), rolled once `vertical_chance` hits. |
| `one_way_vertical_passage_chance` | 0.0–1.0 | 0.0 | `VerticalPassage`-only: probability the edge is one-way instead of two-way. `Elevator` has no per-edge one-way roll — it is always fully two-way. |
| `vertical_up_down_balance` | 0.0–1.0 | 0.5 | Direction balance (0 = down, 1 = up) for one-way `VerticalPassage` edges only. |
| `elevator_span_min` / `elevator_span_max` | ≥1 | 2 / 2 | Inclusive clamp on an elevator's floor count, **including the source floor itself**. |
| `elevator_branching` | 0.0–1.0 | 0.5 | Growth factor from `elevator_span_min` toward the run's actual `max_slots` (clamped by `elevator_span_max`) — same binomial shape as `junction_count`, but parameterized by `elevator_span_min` instead of a fixed `2`. |
| `allow_non_consecutive_elevator_floors` | bool | false | When false, an elevator's unvisited floor pool is clamped to the longest contiguous run (by floor order) before the branching roll — `floor_count` is never drawn from an unreachable range. When true, any unvisited floor is eligible regardless of gaps. |

`cross_floor_teleport_balance` (0.0–1.0, default 0.0) lives in `ElementsConfig` alongside `teleport_chance` — balance between preferring a teleport target on another floor (1) vs. the same floor (0), rolled once `teleport_chance` already hit and only when `field.level_count() > 1`.

### Roll order in the main per-node step

`cyclicity` now rolls **before** `teleport_chance` (the reverse of the pre-#337 order), immediately followed by `vertical_chance` (floor-count-gated) — the vertical roll needs to know `cyclic_fired` up front to decide whether its own hit is spent on the cyclic edge or used for a growth connection:

- `cyclic_fired && vertical_hit`: vertical first tries to realize the *cyclic* edge (a passage to the sole visited neighbor, or an elevator whose floor set includes exactly one visited floor). Success spends both rolls entirely. Failure falls back to the ordinary geometric/teleport cyclic path (see above), with `vertical_hit` still available for teleport's own bookkeeping but not reused for a second vertical attempt this step.
- `cyclic_fired && !vertical_hit`: unchanged geometric/teleport cyclic path.
- `!cyclic_fired && vertical_hit`: vertical goes into growth-connect, added alongside whatever the corridor/junction step produces (mirrors how teleport is added alongside corridor/junction) — junction's `junction_count` roll is not widened for vertical the way it is for teleport.

### `VerticalPassage`

The target floor (which of the two adjacent floors, if either) is resolved **by position in `levels_ordered()`**, never by raw `LevelId` arithmetic (`LevelId` is a stable minted id, never reused or renumbered — see `Specs/space.md`). A boundary floor (first/last in order) has only one adjacent floor; there the target is that floor unconditionally, no choice to make. Target *node* resolution goes exclusively through `MultiLevelField::node_at(level, point)` (`point` from `field.cell_of(src)`) — never a coordinate comparison of the generation code's own. If `node_at` returns `None` (floors don't share a cell shape at that point) or the resolved node fails the growth/cyclic context check (already visited in growth context; no visited neighbor in cyclic context), the `VerticalPassage` attempt fails.

The one-way roll (`one_way_vertical_passage_chance`) and, if one-way, the direction roll (`vertical_up_down_balance`) apply *after* the target is already fixed — they decide which way the edge points between `src` and that already-resolved target, not which floor the target is on. This works identically on a boundary floor (single possible target) and an interior floor (two candidates) — no special-casing needed for the direction roll itself.

### `Elevator`

An elevator connects `floor_count` floors (including `src`'s own) as a fully-connected fan: every unordered pair among the chosen floors gets a two-way edge (`floor_count × (floor_count - 1)` directed edges total). Building the fan is transactional in floor-set selection — the set of floors is fully decided *before* any edge is added, so a single pair failing to connect (preset lock) never changes the reported `floor_count` or retroactively shrinks the chosen set; it just leaves that one pair without a connection, the same way a single corridor/junction candidate can be blocked by a preset without unwinding the whole step.

Floor-count selection algorithm, run before any edge mutation:

1. `unvisited_candidates` — every other floor where `node_at(level, point)` resolves to an unvisited node. Floors without a cell at that point are excluded from the pool, not treated as a failure by themselves.
2. `has_cyclic_visited` — true only in cyclic context, when at least one other floor's `node_at` resolves to a *visited* node. When multiple qualify, the one earliest in `levels_ordered()` position is picked deterministically (no extra RNG roll).
3. If `allow_non_consecutive_elevator_floors` is false, the unvisited pool is clamped to its longest contiguous run (by floor order) *before* the branching roll, so `floor_count` can never be chosen outside what's actually reachable.
4. `max_slots = unvisited_pool.len() + (1 if has_cyclic_visited) + 1` (the final `+1` is `src`'s own floor), clamped to `elevator_span_max`.
5. If `max_slots < elevator_span_min`, the elevator fails:
   - Cyclic context → falls back to the ordinary geometric cyclic path.
   - Growth context → falls back to `VerticalPassage` (see the symmetric fallback rule below), unless `vertical_passage_elevator_balance == 1.0` (fully committed to elevator), in which case the step ends with no vertical connection at all.
   - Either way, the `vertical_passage_elevator_balance` roll that chose Elevator is not re-rolled — the fallback reuses the already-spent `vertical_hit`.
6. `floor_count` — a `junction_count`-style branching roll from `elevator_span_min` up to `max_slots` (0 rolls if they're equal).
7. The chosen floor set: if `has_cyclic_visited`, the guaranteed visited floor from step 2 fills one slot, the remaining `floor_count - 1` are unvisited (from the contiguous-run-clamped pool); otherwise all `floor_count - 1` are unvisited. The guaranteed cyclic floor is exempt from the consecutive-run constraint even when `allow_non_consecutive_elevator_floors` is false — the set can have a gap between the cyclic floor and the unvisited run.
8. A 2-floor elevator (`elevator_span_min <= 2`) is a valid, unexceptional outcome at generation time — QC normalization of a 2-floor elevator down to a `VerticalPassage` is a quality-control concern (see the analytics/QC epic issues), not something generation itself does.

### Preset `VerticalPassage`/`Elevator` discovery during growth (GitHub issue #371)

A preset `VerticalPassage`/`Elevator` connection (`Specs/preset-connections.md`) is planted directly into the graph before generation starts (`build_preset_state`), with both endpoints added to `preset_connected` — the same set same-floor preset `Passage`/`OneWay` connections use. Since the partner endpoint lives on a different floor, it is geometrically invisible to `field.neighbors` and would never surface through the ordinary same-floor `all_free`/`free_regular`/`free_preset` candidate pool on its own; `run_ordinary_step_body_for_node` additionally pulls in `field.vertical_neighbors(src)` (filtered to `preset_connected` partners only) alongside the geometric and teleport candidate pools, so a preset-connected vertical partner is discovered and routed through the same `free_preset` handling teleport/same-floor preset partners get — marked visited and pushed straight to the frontier, no roll, no new edge (the edge already exists). This keeps floor traversal driven entirely by ordinary frontier growth instead of ever depending on `handle_empty_frontier`'s reserve-bridge fallback for a preset-guaranteed connection.

Both of `handle_empty_frontier`'s reserve-bridge candidate pools — the `has_visited_neighbor` reachability scan and the `vertical_neighbors` bridge-selection pool itself — additionally exclude any vertical neighbor already connected to the candidate by an existing edge (`graph.edge_between` checked both directions). Without this, a preset-connected floor that reached the reserve by some other path (or, before the `free_preset` fix above, every preset-connected floor) could have the fallback add a second, redundant `VerticalPassage` on top of the preset's own edge — reproducible even with `vertical_chance == 0.0`, since the fallback's `use_vertical` branch (`geometric_neighbors.is_empty() && !vertical_neighbors.is_empty()`) fires independent of the roll whenever a reserve candidate's only visited neighbor is vertical.

### Symmetric `VerticalPassage` ↔ `Elevator` fallback

A failed `VerticalPassage` growth attempt falls back to trying `Elevator`, and vice versa — but never more than one bounce: a `VerticalPassage` attempt reached via an `Elevator`-fail fallback does not itself fall back to `Elevator` again. Each direction is blocked when the balance is fully committed against it: `vertical_passage_elevator_balance == 0.0` blocks the passage→elevator fallback (user locked the balance to pure-passage), and `== 1.0` blocks the elevator→passage fallback. In cyclic context, `VerticalPassage` failure falls back to the ordinary geometric cyclic path (not to `Elevator`) since a cyclic `Elevator` attempt would already have been tried first if a visited floor existed for it.

### Cross-floor teleport balance

Applied to both of `CustomVertexBased`'s teleport roll points (the `handle_empty_frontier` reserve-bridge and the ordinary per-step connect), only when `field.level_count() > 1`. After `teleport_chance` hits, `cross_floor_teleport_balance` is rolled and the unvisited-node candidate pool is partitioned by floor (relative to the connection's fixed endpoint — `bridge` in the reserve-bridge case, `src` in the ordinary case). The roll prefers the other-floor group (`< balance`) or the same-floor group; if the preferred group is empty, it falls back to the other group — this fallback applies even at the extreme balance values (`0.0`/`1.0`): an extreme value expresses a strong preference, not a hard ban on the alternative.

## WASM Interface

Algorithm parameters are passed via the `initial` field of `GenerateConfig`. `GenerateConfig.level_fields: Vec<Vec<[i32, i32]>>` (GitHub issue #338; optional, defaults to a single 10×10 square level) is each floor's own field points, one entry per floor — `dispatch_generate` builds the `MultiLevelField` from it directly before generation runs (`maze-wasm/src/tessellation_dispatch.rs`'s `build_multi_level_field`). The number of floors generated is `level_fields.len()`; there is no separate count field on the wire. `tessellation` (kind/orientation) is still a single maze-wide value shared by every floor (`Specs/floors.md`). Presets, locked nodes, and split points (`preset_connections`/`locked_nodes`/`split_points`) still only ever resolve against floor 0 (`MultiLevelField::single_level_id()`, `Specs/space.md`) regardless of floor count — a floor beyond the first starts with no preset constraints at all:

```json
{
  "level_fields": [
    [[-5, -5], [-5, -4]],
    [[-3, -3], [-3, -2]]
  ],
  "initial": {
    "method": "custom_vertex_based",
    "depth_first": 0.9,
    "corridor_chance": 0.7,
    "branching": 0.5,
    "directionality": 0.0,
    "cyclicity": 0.0
  },
  "elements": {
    "one_way_chance": 0.0,
    "teleport_chance": 0.0,
    "teleport_one_way_chance": 0.0,
    "cross_floor_teleport_balance": 0.0,
    "vertical_chance": 0.0,
    "vertical_passage_elevator_balance": 0.5,
    "one_way_vertical_passage_chance": 0.0,
    "vertical_up_down_balance": 0.5,
    "elevator_span_min": 2,
    "elevator_span_max": 2,
    "elevator_branching": 0.5,
    "allow_non_consecutive_elevator_floors": false
  }
}
```

The 8 `vertical_*`/`elevator_*` fields and `cross_floor_teleport_balance` are optional `ElementsConfig` fields (defaulted as shown above if omitted) and only meaningful for `custom_vertex_based` on a multi-floor field — see "Vertical Connections" above.

All numeric values are clamped to `[0.0, 1.0]` in the WASM layer before use.

### `CustomVertexBased` Settings Panel

Web UI: `CustomVertexBased`'s generation params (Growth, One-way, Teleport, Split, and — on a multi-floor field — Vertical categories) live in a dedicated right-side panel (`VertexBasedSettingsPanel`, `maze-web/src/components/features/VertexBasedSettingsPanel.tsx`), opened via a gear icon next to the algorithm row on the generation card (GitHub issue #351). Each category can be collapsed/expanded independently; a category's info icon opens a `CategoryInfoModal` listing that category's params with their descriptions.

Whether the panel is open is a persistent part of generation config, following the same pattern as `qcExperiment` above: `vertexSettingsPanelOpen` (`maze-web/src/store/generationTypes.ts`) is serialized into the project file (`ProjectFile.generation.vertexSettingsPanelOpen`, `maze-web/src/store/projectExport/types.ts`), so loading a project restores the panel to the state it was saved in. Old project files predating this field default to closed (`optBool` fallback in `parseAndValidate`). The panel auto-closes (`vertexSettingsPanelOpen` reset to `false`) whenever `setGenerationMethod` switches the algorithm away from `custom_vertex_based`, since the panel has nothing to show for any other method.

## Generation progress feedback

The web generation action runs WASM generation in a module worker so the main thread can render progress feedback. The Generate/Re-Generate button uses independent timing defaults: `spinnerShowDelay = 200 ms` and `spinnerMinVisible = 750 ms`. A generation that completes before the show delay leaves the button unchanged. If it is still running at the delay, one spinner replaces the button title; it remains visible for at least the minimum duration and is hidden immediately afterward. The button is disabled while the operation is running. Timers are cleaned up on unmount, and generation tokens prevent stale completions from changing the current button state.

## QC Experiment Mode

`GenerateConfig.qc_experiment: bool` (default `false`) skips the generation algorithm entirely — no `generate_maze` call is made. The graph fed into `build_maze`'s QC/repair pass is exactly what `build_preset_state` built from the preset connections (Passage/OneWay edges applied, nothing else) — lets a user hand-craft an arbitrary preset setup and observe how QC/repair reshapes it in isolation, without generation noise.

**No preset protection in this mode.** The `PresetState` passed to `build_maze` is `PresetState::empty()` (via `PresetState::for_repair(qc_experiment)`, `maze-core/src/generation/preset_state.rs`) rather than the one `build_preset_state` actually computed — repair is free to add or remove any edge, including ones the preset setup established (Wall-blocked pairs, Passage edges, locked nodes, manual or auto-computed). The graph itself still starts from the preset setup; only the *constraints* repair would otherwise honor are dropped. `maze-wasm::run_generate` and `maze-runner::run_generate_typed` both apply this identically, so native repro tests (`maze-runner/tests/repro.rs`) faithfully reproduce browser QC-experiment behavior.

Web UI: a "QC Only" toggle (`Switch`) on the generation card, next to Generate/Re-Generate, always available (no dev/debug gating) — see GitHub issue #96 (originally a separate button, GitHub issue #93). The toggle is a persistent part of generation config: `qcExperiment` (`maze-web/src/store/storeTypes.ts`) is serialized into the project file (`ProjectFile.generation.qcExperiment`, `maze-web/src/store/projectExport/types.ts`), so loading a project restores it and the next `generate`/`regenerate` call reproduces `qc_experiment` correctly without the user re-selecting the mode. Since the toggle can be flipped after a run without a new generation happening, a separate `lastUsedQcExperiment` flag records what the last actual `generate`/`regenerate`/`loadProject` call used; the debug-export payload (`buildExactGenerateCallPayload`) reads `lastUsedQcExperiment`, not the live toggle, so it faithfully reproduces the exact config the core actually last received.

---

## Restart on a Geometrically Disconnected Region (GitHub issue #417)

`CustomVertexBased`, `RecursiveBacktracker`, and `WilsonAlgorithm` all fill in geometrically disconnected regions of the field as separate, unbridged spanning-tree components rather than ending generation with unvisited cells left over. Once ordinary growth from `start` is exhausted (empty frontier/reserve for `CustomVertexBased`, an empty DFS stack for `RecursiveBacktracker`, no walk that can reach `visited` for `WilsonAlgorithm`) but unvisited nodes remain anywhere on the field, a random unvisited node is picked and marked visited directly — no edge, no parent, treated exactly like the run's own `start` — becoming the root of a new component that ordinary growth then continues from. This repeats until every node is visited; only then does generation actually end. The resulting graph can have multiple disjoint components with no path between them — connecting them back together (if desired) is `build_maze`'s repair pass's concern, not generation's.

Each algorithm's restart trigger and mechanism differs to fit its own growth model:

- **`CustomVertexBased`**: see "Restart on total exhaustion" under "Reserve" above — triggers when the reserve scan's linear pass finds no reachable candidate.
- **`RecursiveBacktracker`**: triggers when the DFS stack unwinds to empty. A random unvisited node (from every node in the field, not just ones that were ever pushed onto the stack) becomes the new stack's sole entry. No event is narrated for the restart root's own visit — same as the original `start`, which also isn't narrated (`RecursiveBacktrackerEvent` has no dedicated "start" event; a node's visit is only narrated when something else chooses it as a candidate).
- **`WilsonAlgorithm`**: a loop-erased random walk can only stop by reaching an already-visited node — a walk started inside a not-yet-reachable region would run forever if that region happens to have no dead end (every node has at least one neighbor). To make the restart decision without ever risking an unbounded walk, `generate` precomputes field-geometric connected components once up front (BFS over `split_aware_neighbors` plus preset-teleport edges in both directions — the same candidate pool a walk's search phase itself uses), before any walk runs. The main loop then only ever starts a walk from an unvisited node whose component already contains a visited node; when no such candidate exists, every remaining unvisited node belongs to a genuinely separate component, and one is picked at random and seeded directly into `visited` (emitting `WilsonEvent::StartVisited`, the same event the run's actual `start` uses) instead of attempting a walk. This can make `WilsonEvent::StartVisited` appear more than once directly under the root scope — once for the original `start`, and once per additional component restarted into.
