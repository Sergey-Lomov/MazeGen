/// GitHub issue #1039: zone scope of a QC rule, end to end through `run_from_config`.
use maze_core::graph::EdgeKind;
use maze_runner::config::{
    CheckInstanceConfig, QcRuleConfig, StageConfig, StrategyConfig, ZoneOverrideDto,
    ZoneOverrideParamsDto, ZoneScopeDto,
};
use maze_runner::{GenerateConfig, run_from_config};
use std::collections::HashMap;

const SEED: u64 = 11;

fn all_cells(config: &GenerateConfig) -> Vec<[i32; 3]> {
    config.level_fields[0]
        .iter()
        .map(|&[x, y]| [0, x, y])
        .collect()
}

/// A map saturated with teleports, with a rule capping them at zero and removing the offenders.
fn teleport_config(zone_scopes: Option<Vec<ZoneScopeDto>>) -> GenerateConfig {
    let mut config = GenerateConfig::default();
    config.zone_overrides = vec![ZoneOverrideDto {
        zone_id: 1,
        cells: all_cells(&config),
        params: ZoneOverrideParamsDto {
            teleport_chance: Some(1.0),
            ..Default::default()
        },
    }];
    config.stages = vec![StageConfig {
        id: "s1".to_string(),
        name: "Stage 1".to_string(),
        rules: vec![QcRuleConfig {
            id: "no_teleports".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "max_teleport_count".to_string(),
                type_id: "max_teleport_count".to_string(),
                params: HashMap::from([("max_teleports".to_string(), "0".to_string())]),
            }],
            strategy: Some(StrategyConfig {
                id: "teleport_group_select".to_string(),
                params: HashMap::new(),
                slot_id: None,
                nested: vec![StrategyConfig {
                    id: "remove_teleport".to_string(),
                    params: HashMap::new(),
                    slot_id: Some("fix_target".to_string()),
                    nested: vec![],
                }],
            }),
            params: HashMap::new(),
            zone_scopes,
        }],
    }];
    config
}

fn teleports(config: &GenerateConfig) -> usize {
    run_from_config(SEED, config)
        .expect("generation must succeed")
        .graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .count()
}

fn left_half(config: &GenerateConfig, id: &str) -> ZoneScopeDto {
    let mut cells = all_cells(config);
    cells.sort_by_key(|&[_, x, _]| x);
    cells.truncate(cells.len() / 2);
    ZoneScopeDto {
        id: id.to_string(),
        cells,
    }
}

#[test]
fn a_scoped_rule_repairs_only_its_zone() {
    let unscoped = teleports(&teleport_config(None));
    assert_eq!(unscoped, 0, "the unscoped rule removes every teleport");

    let mut config = teleport_config(None);
    let scope = left_half(&config, "zone:1");
    config.stages[0].rules[0].zone_scopes = Some(vec![scope]);
    let scoped = teleports(&config);

    config.stages[0].rules.clear();
    let untouched = teleports(&config);
    assert!(untouched > 0, "the map must have teleports to start with");
    assert!(
        scoped > 0 && scoped < untouched,
        "the scoped rule must remove some teleports and leave the rest: {scoped} of {untouched}"
    );
}

#[test]
fn a_rule_with_no_scopes_changes_nothing() {
    let mut config = teleport_config(Some(vec![]));
    let with_rule = teleports(&config);
    config.stages[0].rules.clear();
    assert_eq!(with_rule, teleports(&config));
}

#[test]
fn a_scope_over_the_whole_field_behaves_like_no_scope() {
    let config = teleport_config(None);
    let whole = ZoneScopeDto {
        id: "group:1".to_string(),
        cells: all_cells(&config),
    };
    let scoped = teleport_config(Some(vec![whole]));
    assert_eq!(teleports(&scoped), 0);
}

#[test]
fn zone_scopes_parse_from_json() {
    let rule: QcRuleConfig = serde_json::from_str(
        r#"{"id":"r","checks":[],"zone_scopes":[{"id":"zone:3","cells":[[0,1,2]]}]}"#,
    )
    .unwrap();
    let scopes = rule.zone_scopes.expect("scopes");
    assert_eq!(scopes[0].id, "zone:3");
    assert_eq!(scopes[0].cells, vec![[0, 1, 2]]);
    let rule: QcRuleConfig = serde_json::from_str(r#"{"id":"r","checks":[]}"#).unwrap();
    assert!(rule.zone_scopes.is_none());
}
