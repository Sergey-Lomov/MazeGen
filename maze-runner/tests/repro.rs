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
    assert!(result.finish.is_some(), "farthest_endpoints must assign a finish");
    let kinds: Vec<&str> = result.remaining_issues.iter().map(|i| i.kind.as_str()).collect();
    assert!(kinds.is_empty(), "no remaining issues expected, got {kinds:?}");
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
    let _ = result;
}

/// Seed 287903: MissingRegionsStrategy fails to create Alternative despite large isolated regions.
#[test]
fn repro_287903_alternative_not_created() {
    let result = run_fixture("tests/fixtures/maze-debug-call-287903.json", 287903);

    for cls in [RegionClass::Path, RegionClass::Alternative, RegionClass::Trap, RegionClass::Unreachable] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result.remaining_issues.iter().map(|i| i.kind.as_str()).collect();
    println!("remaining_issues={kinds:?}");
}

/// Same seed/tessellation as 268 but requiring a Trap region instead of Alternative
/// (`trap_count=1`) -- checking whether the strategy reuses the existing 50-node Unreachable
/// blob or carves a fresh piece out of Path instead.
#[test]
fn repro_268_trap_reuse_vs_carve() {
    let result = run_fixture("tests/fixtures/maze-debug-call-268-trap.json", 268);

    for cls in [RegionClass::Path, RegionClass::Alternative, RegionClass::Trap, RegionClass::Unreachable] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result.remaining_issues.iter().map(|i| i.kind.as_str()).collect();
    println!("remaining_issues={kinds:?}");
}

/// Same seed/tessellation, but the required region is a 6-node Trap carved straight out of
/// Path (no pre-existing Unreachable candidate to reuse this time) -- checking whether
/// try_grow can actually carve it even though there's plenty of room.
#[test]
fn repro_268_carve_trap_from_path() {
    let result = run_fixture("tests/fixtures/maze-debug-call-268-carve.json", 268);

    for cls in [RegionClass::Path, RegionClass::Alternative, RegionClass::Trap, RegionClass::Unreachable] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result.remaining_issues.iter().map(|i| i.kind.as_str()).collect();
    println!("remaining_issues={kinds:?}");
}

/// QC experiment mode, 5x5 field with every inner edge preset to `wall` — 25 single-node SCC
/// regions. `scc_count` (max 1) + `reduce_scc_count` (nested `expand_region_passage`) should
/// merge them down to one region, same as a normal (non-experiment) run would.
#[test]
fn repro_qc_experiment_small_regions_not_merged() {
    let result = run_fixture("tests/fixtures/qc-experiment-small-regions.json", 42);

    for cls in [RegionClass::Path, RegionClass::Alternative, RegionClass::Trap, RegionClass::Unreachable] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result.remaining_issues.iter().map(|i| i.kind.as_str()).collect();
    println!("remaining_issues={kinds:?}");
    let scc_count = result.region_sizes.values().map(|v| v.len()).sum::<usize>();
    assert_eq!(scc_count, 1, "all 25 single-node regions must merge into one");
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

    for cls in [RegionClass::Path, RegionClass::Alternative, RegionClass::Trap, RegionClass::Unreachable] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result.remaining_issues.iter().map(|i| i.kind.as_str()).collect();
    println!("remaining_issues={kinds:?}");
    let scc_count = result.region_sizes.values().map(|v| v.len()).sum::<usize>();
    assert_eq!(scc_count, 1, "all 25 single-node regions must merge into one, even with every node auto-locked");
}

/// Seed 268: large Unreachable region (~50 nodes) present but MissingRegionsStrategy
/// fails to convert it into the required Alternative region.
#[test]
fn repro_268_alternative_not_created() {
    let result = run_fixture("tests/fixtures/maze-debug-call-268.json", 268);

    for cls in [RegionClass::Path, RegionClass::Alternative, RegionClass::Trap, RegionClass::Unreachable] {
        let sizes = result.region_sizes.get(&cls).cloned().unwrap_or_default();
        println!("final {cls:?}: count={} sizes={sizes:?}", sizes.len());
    }
    let kinds: Vec<&str> = result.remaining_issues.iter().map(|i| i.kind.as_str()).collect();
    println!("remaining_issues={kinds:?}");
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
    let kinds: Vec<&str> = result.remaining_issues.iter().map(|i| i.kind.as_str()).collect();
    assert!(kinds.is_empty(), "no remaining issues expected, got {kinds:?}");
    assert!(result.start.is_some(), "farthest_endpoints must assign a start");
    assert!(result.finish.is_some(), "farthest_endpoints must assign a finish");
}
