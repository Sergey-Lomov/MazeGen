# Canonical Baselines & Per-Stage Benchmarks

Safety net for refactors that must not change observable behavior (GitHub issue #753, part of the
tessellation API epic #752). Two independent tools in `maze-runner`, both driven by the fixtures in
`maze-runner/tests/fixtures/baseline/`.

## Fixtures

One pair per tessellation (square, hex, tri, Cairo), each on a large single-level field
(~800–1800 cells), all sharing one QC config (structure, elements and waypoint stages) and three
split patterns with face indices valid for every tessellation:

- `baseline-<tess>-gen.json` — `CustomVertexBased` generation with split patterns, one-ways and
  teleports enabled. Cyclicity (0.004) and teleport chance (0.003) are kept low on purpose: denser
  cycles overflow simple-cycle analysis (`cycle_analysis_overflowed`), which silently disables
  both loop checks.
- `baseline-<tess>-qc.json` — a QC experiment (`qc_experiment: true`) whose `preset_connections`
  and `split_points` encode the graph the matching `-gen` fixture generated. This is the **fixed
  graph**: QC, repair and split-pattern results recorded on it don't depend on generation.

Stage order is structure → waypoints → elements: endpoints are assigned before the element
rules run, so waypoint-distance rules (`one_way_waypoint_distance`, `split_distance_from_waypoint`)
see a start and finish. The config is tuned so that every rule's strategy is dispatched during
repair on at least one fixed graph (enforced by a test, see below). Rules that depend on
connectivity (`teleport_graph_distance`: an unreachable exit is never flagged) or on endpoints
fire only during repair, not in the check-only pass on the still-disconnected fixed graph. It uses
graph thresholds only (`teleport_graph_distance`, `max_teleport_count`, waypoint distances,
region sizes, loop lengths/counts) — no geometric-length check — so the intentional
`cell_scale` threshold change of #759 doesn't move these baselines. One geometric dependency
remains: `expand_region_passage` ranks candidate pairs by `Tessellation::cartesian` distance; a geometry port
that preserves relative distances keeps it unchanged.

## Canonical form (`maze_runner::canonical`)

Expressed in cells, never `NodeId`s, face indices or symmetry indices:

- **Cell id** — `"<level>:<x>,<y>/<slot>"`: the `levels_ordered()` index, the point's wire
  coordinates, and the node's position within `nodes_at` (0 = the point's original node).
  `CellIndex::cell` panics for a node outside the indexed field — a raw `NodeId` never leaks into
  a snapshot.
- **Edge** — `"<from> > <to> <kind>"`, one per directed edge; a two-way connection appears as both
  of its directed edges. Edge lists are sorted.
- **Issue** — kind, sorted source checks, display details, and the `resolve_issue_payload` payload
  with every node/edge mapped to cells and every group list sorted (order-independent).
- **Split adaptation candidate** — sorted face list, `"n<node>:<requirement>-><target>"` with
  target a cell, `sib<node>` or `none`; a candidate set is a sorted, deduplicated list. Rotation
  and mirror indices are deliberately absent.

`canonical_baseline(config, seed)` records:

| Fixture | Sections |
|---------|----------|
| generation (`qc_experiment: false`) | `generation`: start cell, start reassignment, edges |
| QC experiment | `qc`: check-only issues on the fixed graph; `repair`: post-repair edges, start, finish, `dispatched` (rule id → strategy dispatch count, from the timing tree), remaining issues; `split_candidates` (when patterns are declared) |

`split_candidates` probes the slot-0 node of every 20th point (canonical cell order) against every
pattern, with presets empty, under four scenarios: `free` (nothing visited), `cyclic` (a fixed
coordinate-hashed visited subset, cyclicity fired), `parent` (same subset plus the first `Basic`
graph neighbor as parent) and `bridge` (same subset plus the last `Basic` neighbor as bridge).
Keys are `"<cell> p<pattern> <scenario>"`; scenarios without candidates are omitted.

## Baseline test

`maze-runner/tests/baselines.rs` runs every fixture with seed `753` (one test per fixture, listed
in `baseline_tests!`; `every_fixture_has_a_baseline_test` fails if a fixture on disk is missing
from that list) and compares against `maze-runner/tests/baselines/<fixture>.json`, reporting the
first differing JSON path. `every_rule_strategy_is_dispatched_somewhere` fails when a configured
rule's strategy is dispatched in no QC fixture — a rule that never fires is a blind spot, since a
refactor breaking its detection would leave every baseline unchanged. Unit tests in
`canonical.rs` pin cell ids and the order independence of payloads and candidates. Later
tickets must keep these exact; an intentional difference must be explained before regenerating:

```sh
UPDATE_BASELINES=1 cargo test -p maze-runner --test baselines
```

## Expected baseline evolution across epic #752

- **#755 (configured instance, `{kind, params}`)** — fixtures switch to the new wire format;
  canonical cell ids stay anchored on the existing tessellations' wire coordinates (the runner
  maps each `CellId` back to them), so every baseline must match exactly.
- **#756 (per-cell neighbor contract)**, **#757 (shape templates)** — no behavior change; every
  baseline must match exactly.
- **#758 (split logic on shape templates, canonical circular face order)** — the fixtures' split
  patterns carry `shape` and canonical `face_index` values, translated from the old `faces_of`
  positions so each keeps its geometric meaning: square `[N, S, E, W] → [1, 3, 0, 2]`, hex
  identity, triangle through the pointing-up binding (`[1, 2, 0]`; any bijection is equivalent
  under the full triangle group), Cairo through the `R` orientation's binding
  (`[0, 1, 3, 2, 4]`). Observed, in two steps:
  - Split logic on shape templates (old `faces_of` order kept): `qc`/`repair` matched exactly for
    every tessellation, `split_candidates` matched exactly for square and hex, triangle candidate
    sets became strict supersets at every probed key (reflections). Cairo matched exactly on `R`
    cells and differed on `L`/`U`/`D` cells: the old slot-identity "rotation" was not a rigid
    motion between orientations, because the face slots run in a different circular order there.
    `generation` changed for every tessellation: the variant list is deduplicated (the old
    rotation × mirror product listed many orientations twice), so the uniform pick sees a
    different candidate count.
  - Canonical circular `faces_of` (square, triangle, Cairo; hex was already circular): `qc` and
    `split_candidates` unchanged; `repair` and `generation` changed for square, triangle and Cairo
    through the new neighbor iteration order.

  Both steps were checked with invariants on 12–40 seeds per tessellation before the update:
  generation stays weakly connected after repair at the same rate as before, and the set of
  remaining QC issue kinds after repair is unchanged (`excessive_scc_count`,
  `region_needs_expansion` always, `unreachable_finish` at a comparable rate).
- **#759 (core geometry)** — adds the geometry snapshot stage to the benchmark. Baselines change
  only where geometry is observable (see `expand_region_passage` above); explain any difference
  before updating.

## Benchmark (`maze-runner/src/bin/bench.rs`)

```sh
cargo run --release -p maze-runner --bin bench              # compare
cargo run --release -p maze-runner --bin bench -- --record  # rewrite the baseline
```

Stages: `generation` on `-gen` fixtures; `qc` (every check once, no repair) and `repair` (full
QC+repair loop) on `-qc` fixtures. Geometry snapshot is added later in the epic. Each
measurement is the median of `--runs` samples (default 15, minimum 10) after one warm-up; setup is
untimed, except that `qc` and `repair` include building the QC engine (and `qc` copying the
field/graph) — sub-millisecond next to the stage. A stage shorter than 100 ms (generation) is
repeated within each sample and the sample is the per-run mean, so timer/scheduler noise doesn't
dominate. `maze-runner/bench/baseline.json` stores per measurement the median, the spread
(interquartile range / median) and the threshold `max(5%, spread)`. Comparison exits non-zero
when any median exceeds its baseline by more than its threshold. Timings are machine-specific:
compare only against a baseline recorded on the same machine.
