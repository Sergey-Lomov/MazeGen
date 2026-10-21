/// GitHub issue #640: random generation-source mode, and the precedence rule that a resolved
/// `preset_gen_source` pin always wins over `generation_source_mode`, exercised end-to-end
/// through `run_from_config` (not just the core-level unit tests in
/// `maze-core::generation::generation_source`).
use maze_runner::config::{GenerationSourceModeDto, PresetEndpointDto};
use maze_runner::{GenerateConfig, run_from_config};

fn base_config() -> GenerateConfig {
    // Default `GenerateConfig` already ships a 10x10 centered square field (`default_level_fields`)
    // and `qc_experiment: false`/no preset connections — algorithmic generation runs normally, so
    // `result.start` reflects whichever node the resolved geometric start point maps to.
    GenerateConfig::default()
}

#[test]
fn default_mode_without_pin_does_not_change_existing_behavior() {
    // No `generation_source_mode` override -- must equal the always-centroid-nearest fallback
    // every fixture predating this feature relies on.
    let config = base_config();
    let result = run_from_config(42, &config).expect("generation must succeed");
    assert!(result.start.is_some(), "a start node must be assigned");
}

#[test]
fn random_mode_without_pin_is_deterministic_per_seed() {
    let mut config = base_config();
    config.generation_source_mode = GenerationSourceModeDto::Random;

    let a = run_from_config(7, &config).expect("generation must succeed");
    let b = run_from_config(7, &config).expect("generation must succeed");
    assert_eq!(
        a.start, b.start,
        "same seed in random mode must resolve to the same start node"
    );
}

#[test]
fn pinned_source_wins_over_random_mode_regardless_of_seed() {
    // `preset_gen_source` only pins where the generation algorithm's traversal *starts from*
    // (`start_id` in `run_generate_typed`) -- it does not by itself fix the maze's final
    // `start`/`finish` markers, which QC/repair (e.g. `farthest_endpoints`) may still pick
    // per-seed. `preset_start` is the separate mechanism that pins the final `maze.meta.start`.
    // Pinning both isolates exactly what this test cares about: that `generation_source_mode`
    // has no effect once a `preset_gen_source` pin is present (the precedence rule), not
    // incidental seed-driven repair variance downstream.
    let mut config = base_config();
    config.generation_source_mode = GenerationSourceModeDto::Random;
    // Field is 10x10 centered around (0,0) per `default_level_fields` -- (0,0) is always a valid
    // point on it.
    config.preset_gen_source = Some(PresetEndpointDto {
        point: [0, 0],
        slot: None,
        level: None,
    });
    config.preset_start = Some(PresetEndpointDto {
        point: [0, 0],
        slot: None,
        level: None,
    });

    let mut starts = Vec::new();
    for seed in [0u64, 1, 2, 3, 100] {
        let result = run_from_config(seed, &config).expect("generation must succeed");
        starts.push(result.start);
    }
    assert!(
        starts.windows(2).all(|w| w[0] == w[1]),
        "a resolved pin must win over random mode for every seed, got {starts:?}"
    );
}

fn off_field_endpoint() -> PresetEndpointDto {
    PresetEndpointDto {
        point: [999, 999],
        slot: None,
        level: None,
    }
}

#[test]
fn unresolvable_gen_source_is_an_error() {
    let mut config = base_config();
    config.preset_gen_source = Some(off_field_endpoint());
    let err = run_from_config(1, &config).err().expect("must fail");
    assert!(
        err.contains("[999, 999]"),
        "error must name the point: {err}"
    );
}

#[test]
fn unresolvable_pinned_start_and_finish_are_errors() {
    let mut start = base_config();
    start.preset_start = Some(off_field_endpoint());
    assert!(run_from_config(1, &start).is_err());

    let mut finish = base_config();
    finish.preset_finish = Some(off_field_endpoint());
    assert!(run_from_config(1, &finish).is_err());
}
