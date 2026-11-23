/// GitHub issue #1038: per-zone generation parameter overrides, end to end through
/// `run_from_config`.
use maze_core::graph::EdgeKind;
use maze_runner::config::{ZoneOverrideDto, ZoneOverrideParamsDto};
use maze_runner::{GenerateConfig, run_from_config};

fn teleport_edges(config: &GenerateConfig) -> usize {
    let result = run_from_config(11, config).expect("generation must succeed");
    result
        .graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .count()
}

fn teleport_zone(cells: Vec<[i32; 3]>) -> ZoneOverrideDto {
    ZoneOverrideDto {
        zone_id: 1,
        cells,
        params: ZoneOverrideParamsDto {
            teleport_chance: Some(1.0),
            ..Default::default()
        },
    }
}

#[test]
fn a_zone_override_applies_only_inside_the_zone() {
    let mut config = GenerateConfig::default();
    assert_eq!(teleport_edges(&config), 0, "no teleports without overrides");

    config.zone_overrides = vec![teleport_zone(vec![])];
    assert_eq!(teleport_edges(&config), 0, "an empty zone changes nothing");

    let all: Vec<[i32; 3]> = config.level_fields[0]
        .iter()
        .map(|&[x, y]| [0, x, y])
        .collect();
    config.zone_overrides = vec![teleport_zone(all)];
    assert!(
        teleport_edges(&config) > 0,
        "a zone over the whole field must roll teleports"
    );
}

#[test]
fn a_smaller_zone_id_wins_over_a_larger_one_on_the_same_parameter() {
    let mut config = GenerateConfig::default();
    let all: Vec<[i32; 3]> = config.level_fields[0]
        .iter()
        .map(|&[x, y]| [0, x, y])
        .collect();
    let mut loser = teleport_zone(all.clone());
    loser.zone_id = 9;
    let mut winner = teleport_zone(all);
    winner.zone_id = 2;
    winner.params.teleport_chance = Some(0.0);
    config.zone_overrides = vec![loser, winner];
    assert_eq!(teleport_edges(&config), 0);
}

#[test]
fn a_non_consecutive_floors_override_parses_and_runs() {
    let params: ZoneOverrideParamsDto =
        serde_json::from_str(r#"{"allow_non_consecutive_elevator_floors": true}"#).unwrap();
    assert_eq!(params.allow_non_consecutive_elevator_floors, Some(true));
    let mut config = GenerateConfig::default();
    let all: Vec<[i32; 3]> = config.level_fields[0]
        .iter()
        .map(|&[x, y]| [0, x, y])
        .collect();
    config.zone_overrides = vec![ZoneOverrideDto {
        zone_id: 1,
        cells: all,
        params,
    }];
    run_from_config(11, &config).expect("generation must succeed");
}

fn vertical_edges(config: &GenerateConfig, seed: u64) -> usize {
    let result = run_from_config(seed, config).expect("generation must succeed");
    result
        .graph
        .edges()
        .filter(|e| matches!(e.kind, EdgeKind::VerticalPassage | EdgeKind::Elevator))
        .count()
}

#[test]
fn a_vertical_chance_override_creates_vertical_edges_inside_the_zone() {
    let mut config = GenerateConfig::default();
    config.level_fields = vec![
        config.level_fields[0].clone(),
        config.level_fields[0].clone(),
    ];
    let seeds = 1..=5u64;
    let base: usize = seeds.clone().map(|s| vertical_edges(&config, s)).sum();
    let cells: Vec<[i32; 3]> = config.level_fields[0]
        .iter()
        .map(|&[x, y]| [0, x, y])
        .collect();
    config.zone_overrides = vec![ZoneOverrideDto {
        zone_id: 1,
        cells,
        params: ZoneOverrideParamsDto {
            vertical_chance: Some(1.0),
            ..Default::default()
        },
    }];
    let with: usize = (1..=5u64).map(|s| vertical_edges(&config, s)).sum();
    assert!(
        with > base,
        "override must add vertical edges: base={base} with={with}"
    );
}
