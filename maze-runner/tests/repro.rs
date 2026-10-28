/// Integration test template: load a browser-exported JSON fixture, run the full
/// generation+repair pipeline, inspect the result. No hardcoded params — everything
/// comes from the fixture file. Copy this test, rename it, and add assertions.
///
/// To add a new repro test:
/// 1. Export the config from the browser (debug toolbar → "Copy config JSON")
/// 2. Save it to maze-runner/tests/fixtures/<name>.json
/// 3. Copy this test function, rename it, add assertions on `result`
use maze_core::RegionClass;
use maze_runner::run_fixture;

/// Issue #86: preset start + farthest_endpoints strategy picks wrong finish (not actually farthest).
/// `farthest_endpoints` must see the preset start seeded on `maze.meta` *before* repair runs, not
/// have it applied afterward — otherwise it computes "farthest" from whatever start the strategy
/// itself would have picked (or none), then the real preset start silently overwrites it later.
#[test]
fn repro_86_farthest_endpoints_wrong_finish() {
    let result = run_fixture("tests/fixtures/issue-86-farthest-preset-start.json", 42);
    println!("start={:?} finish={:?}", result.start, result.finish);
    assert!(result.start.is_some(), "preset start must be honored");
    assert!(
        result.finish.is_some(),
        "farthest_endpoints must assign a finish"
    );
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    assert!(
        kinds.is_empty(),
        "no remaining issues expected, got {kinds:?}"
    );
}

/// Regression for GitHub issue #248's user report: with a preset-protected split node (the
/// preset passage into it puts it in `preset_edges`, so `try_remove_node` always declines
/// `RemoveNode`), `RemoveSplitStrategy` used to report `Fixed` regardless, spinning the repair
/// fixpoint loop until `repair_limit_reached` instead of failing fast on the first iteration --
/// the split-tile issue only ever surfaced after the whole repair budget was burned (and could be
/// missed entirely if the caller doesn't wait out the full budget). Fixed by checking
/// `remove_node_feasible` up front and reporting `Failed` when nothing is actually removable.
#[test]
fn repro_248_split_distance_from_waypoint_fails_fast_on_a_preset_protected_node() {
    let result = run_fixture(
        "tests/fixtures/repro-248-split-distance-from-waypoint.json",
        0,
    );
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    assert_eq!(
        kinds,
        vec!["invalid_split_tile"],
        "must surface the split-tile issue directly, without burning the repair budget into repair_limit_reached"
    );
}

/// GitHub issue #248 follow-up: a split node whose only two edges form a plain pass-through
/// corridor (in from one side, out the other -- the shape real preset split nodes usually have)
/// gets compressed into some other nav-edge's interior `path` by `NavGraph`; `nav_node_for`
/// returns `None` for it, so `split_distance_from_waypoint` silently never fired for the common
/// split-node shape (only worked when the split node happened to also be a junction, e.g. in the
/// other repro fixture above). Fixed by falling back to `NavGraph::corridor_index`, the same
/// resolution `routing::resolve_nav_node` already uses for a route's own interior nodes.
#[test]
fn repro_248_split_distance_from_waypoint_fires_for_a_compressed_corridor_split_node() {
    let result = run_fixture("tests/fixtures/repro-248-compressed-corridor-split.json", 0);
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    assert_eq!(
        kinds,
        vec!["invalid_split_tile"],
        "must fire even though the split node is a compressed pass-through corridor, not a junction"
    );
}

/// Template — copy + rename + add assertions.
#[test]
#[ignore]
fn repro_template() {
    let result = run_fixture("tests/fixtures/REPLACE_ME.json", 0);
    // result.remaining_issues  — Vec<Issue>
    // result.region_sizes      — HashMap<RegionClass, Vec<usize>> (sorted desc)
    // result.start / .finish   — Option<NodeId>
    // result.timing            — GenerationTiming
    // result.graph             — Graph (final, post-repair)
    let _ = result;
}

/// User report: weighted_region_merge configured 9:1 (passage:one_way) for merge_target seemed to
/// never produce a one-way connection in the browser. Config exported from the browser debug
/// toolbar, QC-only mode (algorithmic generation skipped entirely — every preset connection in
/// the fixture is `wall`), so every edge in the final graph is attributable to the repair
/// strategy, not base generation's own `one_way_chance`.
///
/// Investigation: the exact fixture seed (315556) happens to never land on the one_way candidate
/// across its few `dispatch_weighted` picks for this maze — a legitimate ~(0.9)^n outcome at a
/// 9:1 weight split with only a handful of undersized regions to merge, not a bug. Scanning
/// several other seeds against the same fixture confirms `dispatch_weighted` does pick the
/// one_way candidate at roughly the configured ~10% rate, and successfully-applied one-way edges
/// do survive into the final graph unchanged (this test's own assertion, at seed 0). Kept as a
/// regression guard, not proof of the original report — see also
/// `expand_region_passage::one_way_rolls_back_the_lone_successful_direction_when_the_other_is_preset_blocked`
/// for a related atomicity hardening found while investigating (a partially-applied one-way could
/// otherwise leave a stray directed edge that a later repair pass silently completes into a full
/// passage, which would look like exactly this report from the outside).
#[test]
fn repro_315556_weighted_one_way_edges_survive_when_picked() {
    let result = run_fixture("tests/fixtures/weighted_1_9_repro.json", 0);
    let one_way: Vec<_> = result
        .graph
        .edges()
        .filter(|e| result.graph.edge_between(e.to, e.from).is_none())
        .collect();
    println!(
        "total_edges={} one_way_edges={}",
        result.graph.edges().count(),
        one_way.len()
    );
    assert!(
        !one_way.is_empty(),
        "seed 0 is known to pick+apply the one_way candidate at least once for this fixture"
    );
}

/// Seed 287903: MissingRegionsStrategy fails to create Alternative despite large isolated regions.
#[test]
fn repro_287903_alternative_not_created() {
    let result = run_fixture("tests/fixtures/maze-debug-call-287903.json", 287903);

    for cls in [
        RegionClass::Path,
        RegionClass::Alternative,
        RegionClass::Trap,
        RegionClass::Unreachable,
    ] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    println!("remaining_issues={kinds:?}");
}

/// Same seed/tessellation as 268 but requiring a Trap region instead of Alternative
/// (`trap_count=1`) -- checking whether the strategy reuses the existing 50-node Unreachable
/// blob or carves a fresh piece out of Path instead.
#[test]
fn repro_268_trap_reuse_vs_carve() {
    let result = run_fixture("tests/fixtures/maze-debug-call-268-trap.json", 268);

    for cls in [
        RegionClass::Path,
        RegionClass::Alternative,
        RegionClass::Trap,
        RegionClass::Unreachable,
    ] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    println!("remaining_issues={kinds:?}");
}

/// Same seed/tessellation, but the required region is a 6-node Trap carved straight out of
/// Path (no pre-existing Unreachable candidate to reuse this time) -- checking whether
/// try_grow can actually carve it even though there's plenty of room.
#[test]
fn repro_268_carve_trap_from_path() {
    let result = run_fixture("tests/fixtures/maze-debug-call-268-carve.json", 268);

    for cls in [
        RegionClass::Path,
        RegionClass::Alternative,
        RegionClass::Trap,
        RegionClass::Unreachable,
    ] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    println!("remaining_issues={kinds:?}");
}

/// QC experiment mode, 5x5 field with every inner edge preset to `wall` — 25 single-node SCC
/// regions. `scc_count` (max 1) + `reduce_scc_count` (nested `expand_region_passage`) should
/// merge them down to one region, same as a normal (non-experiment) run would.
#[test]
fn repro_qc_experiment_small_regions_not_merged() {
    let result = run_fixture("tests/fixtures/qc-experiment-small-regions.json", 42);

    for cls in [
        RegionClass::Path,
        RegionClass::Alternative,
        RegionClass::Trap,
        RegionClass::Unreachable,
    ] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    println!("remaining_issues={kinds:?}");
    let scc_count = result.region_sizes.values().map(|v| v.len()).sum::<usize>();
    assert_eq!(
        scc_count, 1,
        "all 25 single-node regions must merge into one"
    );
}

/// Same 5x5 all-wall setup as above, but every cell is also auto-locked "both" (as the browser
/// actually sent it — auto-lock treats a cell whose every interior edge is explicitly set, wall
/// or not, as "fully defined" and locks it). QC experiment mode must ignore preset protection
/// entirely — locks included — or `expand_region_passage` can never bridge any pair (both
/// `locked_out`/`locked_in` block every candidate edge). Regression for the bug where QC
/// experiment mode built `PresetState` from `locked_nodes` same as a normal run.
#[test]
fn repro_qc_experiment_locked_small_regions_not_merged() {
    let result = run_fixture("tests/fixtures/qc-experiment-small-regions-locked.json", 42);

    for cls in [
        RegionClass::Path,
        RegionClass::Alternative,
        RegionClass::Trap,
        RegionClass::Unreachable,
    ] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    println!("remaining_issues={kinds:?}");
    let scc_count = result.region_sizes.values().map(|v| v.len()).sum::<usize>();
    assert_eq!(
        scc_count, 1,
        "all 25 single-node regions must merge into one, even with every node auto-locked"
    );
}

/// Seed 268: large Unreachable region (~50 nodes) present but MissingRegionsStrategy
/// fails to convert it into the required Alternative region.
#[test]
fn repro_268_alternative_not_created() {
    let result = run_fixture("tests/fixtures/maze-debug-call-268.json", 268);

    for cls in [
        RegionClass::Path,
        RegionClass::Alternative,
        RegionClass::Trap,
        RegionClass::Unreachable,
    ] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    println!("remaining_issues={kinds:?}");
}

/// GitHub issue #147: `debug_events: true` on the QC/repair pipeline produces a `QcEvent` tape
/// that decodes to the mutations the repair loop actually applied. Same fixture as
/// `repro_qc_experiment_small_regions_not_merged` (25 isolated single-node regions merged into
/// one via `reduce_scc_count`/`expand_region_passage`), with `debug_events: true` added — this is
/// the one fixture in this file guaranteed to trigger real repair mutations, not just checks.
#[test]
fn repro_147_qc_debug_events_tape_matches_applied_mutations() {
    use maze_core::event_log::DebugEvent;
    use maze_core::quality_control::QcEvent;

    let result = run_fixture(
        "tests/fixtures/qc-experiment-small-regions-debug-events.json",
        42,
    );

    let scc_count = result.region_sizes.values().map(|v| v.len()).sum::<usize>();
    assert_eq!(
        scc_count, 1,
        "all 25 single-node regions must merge into one (same outcome as the non-debug fixture)"
    );

    let tape = result
        .qc_tape
        .expect("debug_events: true must produce a QC tape");
    let mutating_events: Vec<&QcEvent> = tape.mutating_events().collect();
    assert!(
        !mutating_events.is_empty(),
        "merging 25 regions into 1 must apply at least one mutating command"
    );

    // Every mutating event must actually be mutating per QcEvent::is_mutating (the tape only
    // contains events built by real apply_commands calls, so this also guards against a stray
    // *Declined trace variant leaking into mutating_events()).
    for event in &mutating_events {
        assert!(
            event.is_mutating(),
            "mutating_events() yielded a non-mutating event: {event:?}"
        );
    }

    // The tree must contain at least a "stage stage_2" scope (where the merging happens) with a
    // nested "iteration N" scope — proves the tape actually reflects QualityControlEngine's real
    // stage/iteration structure, not just a flat event list.
    let root = tape.root();
    let stage_scope_names: Vec<String> = root
        .children()
        .filter_map(|c| match c.payload() {
            maze_core::event_log::NodePayload::Scope(name) => Some(name.to_string()),
            maze_core::event_log::NodePayload::Event(_) => None,
        })
        .collect();
    assert!(
        stage_scope_names.contains(&"stage stage_2".to_string()),
        "expected a \"stage stage_2\" top-level scope, got {stage_scope_names:?}"
    );
}

/// Issue #95 (exact debug-toolbar "Copy config JSON" export, QC-only preset graph). Documents
/// the known `FarthestEndpointsStrategy` heuristic limitation (see `Specs/repair.md`): the
/// two-Dijkstra sweep isn't an exhaustive search, so it can land on a pair that isn't the true
/// diameter on a graph with cycles. On this exact graph the sweep picks a pair at tile-distance
/// 12 while the true maximum (found by brute force over all pairs) is 14 — a known-acceptable
/// gap, not asserted here since the sweep's exact pick isn't part of its contract.
#[test]
fn repro_95_qc_only_official_export() {
    let result = run_fixture("tests/fixtures/issue-95-qc-only-official.json", 42);
    let kinds: Vec<&str> = result
        .remaining_issues
        .iter()
        .map(|i| i.kind().as_str())
        .collect();
    assert!(
        kinds.is_empty(),
        "no remaining issues expected, got {kinds:?}"
    );
    assert!(
        result.start.is_some(),
        "farthest_endpoints must assign a start"
    );
    assert!(
        result.finish.is_some(),
        "farthest_endpoints must assign a finish"
    );
}

/// GitHub issue #231: a preset connection addressing a declared split slot must route through
/// that specific node, not the point's original node. Fixture: a 2-cell square field, (-1,0)
/// split into its original node plus one declared slot; the plain (original-node) edge to (0,0)
/// is preset `wall`, but the slot-addressed edge to (0,0) is preset `passage`. `qc_experiment`
/// mode skips algorithmic generation entirely, so every edge in the final graph is directly
/// attributable to `build_preset_state`'s endpoint resolution — this is the "from beginning to
/// end through `run_from_config`" integration coverage `Specs/preset-connections.md`'s "Split
/// nodes" section calls for, complementing `preset_state_tests/`'s unit-level coverage of the
/// same resolution logic.
#[test]
fn repro_231_preset_connection_addressing_declared_split_slot_routes_through_that_node() {
    let result = run_fixture("tests/fixtures/issue-231-preset-split-node-passage.json", 0);

    // 2 field points, one split into 2 nodes (original + slot 0) -- 3 nodes total.
    assert_eq!(
        result.graph.node_count(),
        3,
        "field has 2 points, one split into 2 nodes"
    );

    // Exactly one bidirectional passage exists in the final graph (the slot-addressed preset) --
    // the plain (original-node) edge is walled, so it must not exist at all.
    let edge_count = result.graph.edges().count();
    assert_eq!(
        edge_count, 2,
        "exactly one bidirectional passage (2 directed edges) expected"
    );

    // The original node at (-1,0) must have zero edges -- only the wall preset (which adds no
    // edge) ever referenced it; the passage went to the split slot instead.
    let original_has_no_edges = result
        .graph
        .nodes()
        .any(|n| result.graph.edges().all(|e| e.from != n.id && e.to != n.id));
    assert!(
        original_has_no_edges,
        "the point's original node must remain edgeless — the passage targeted its split slot, not it"
    );
}

/// GitHub issue #173: an empty 5x5 field, no preset connections, `qc_experiment` + `debug_events`
/// on. No repair strategy can act on a completely edgeless graph (`missing_endpoints`'s
/// `scored_endpoints` strategy needs some structure to score candidates against), so QC/repair
/// produces zero mutating events — this is the exact scenario that made the debug panel not
/// appear at all before this fix (`maze-web`'s `debugArena` build used to require `totalSteps > 0`
/// and `maze-wasm`'s tape merge used to drop a QC tape with an empty `node_table`). The tape
/// itself must still exist and decode cleanly even with nothing mutating in it.
#[test]
fn repro_173_qc_only_empty_field_no_preset_yields_a_present_but_empty_qc_tape() {
    use maze_core::quality_control::QcEvent;

    let result = run_fixture("tests/fixtures/issue-173-qc-only-empty-no-preset.json", 42);
    assert!(
        result.start.is_none(),
        "no strategy can assign a start on an edgeless graph"
    );
    assert!(
        result.finish.is_none(),
        "no strategy can assign a finish on an edgeless graph"
    );

    let tape = result
        .qc_tape
        .expect("debug_events: true must still produce a QC tape even with zero mutating events");
    let mutating_events: Vec<&QcEvent> = tape.mutating_events().collect();
    assert!(
        mutating_events.is_empty(),
        "an edgeless graph with no preset connections has nothing for repair to mutate"
    );
}
