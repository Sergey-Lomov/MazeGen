use super::*;

// GitHub issue #349: `scored_endpoints`'s cross_floor_weight/elevator_stop_weight are
// meaningless on a single-floor maze, so the web UI hides them via this tag — pins the wiring
// between the strategy's own param ids and the visibility override list, since a typo in
// either id would silently leave the param always-visible with no compiler signal.
#[test]
fn scored_endpoints_marks_floor_weights_multi_floor_only() {
    let strategies = available_strategies_list();
    let scored = strategies
        .iter()
        .find(|s| s.id == "scored_endpoints")
        .unwrap();
    for id in ["cross_floor_weight", "elevator_stop_weight"] {
        let param = scored.params.iter().find(|p| p.id == id).unwrap();
        assert_eq!(param.visibility, Some(EntityVisibility::MultiFloorOnly));
    }
}

// GitHub issue #381/#349 follow-up: `missing_teleports`'s cross-floor mode/balance only
// matter when a teleport can actually land on a different floor.
#[test]
fn missing_teleports_marks_cross_floor_params_multi_floor_only() {
    let strategies = available_strategies_list();
    let strategy = strategies
        .iter()
        .find(|s| s.id == "missing_teleports")
        .unwrap();
    for id in ["cross_floor_mode", "cross_floor_balance"] {
        let param = strategy.params.iter().find(|p| p.id == id).unwrap();
        assert_eq!(param.visibility, Some(EntityVisibility::MultiFloorOnly));
    }
}

#[test]
fn missing_loops_teleport_exposes_ordered_loop_params() {
    let strategy = available_strategies_list()
        .into_iter()
        .find(|s| s.id == "missing_loops_teleport")
        .expect("missing_loops_teleport must be registered");
    let ids: Vec<&str> = strategy.params.iter().map(|p| p.id).collect();
    assert_eq!(
        ids,
        vec![
            "entry_pick",
            "exit_pick",
            "desired_length",
            "allow_out_of_interval",
            "teleport_loop_one_way_chance",
            "reserve_percent",
            "attempts_limit",
        ]
    );

    let entry = strategy
        .params
        .iter()
        .find(|p| p.id == "entry_pick")
        .unwrap();
    assert!(matches!(
        entry.kind,
        ParamKindDto::Enum { default, .. } if default == "dead_end_priority"
    ));
    let exit = strategy
        .params
        .iter()
        .find(|p| p.id == "exit_pick")
        .unwrap();
    assert!(matches!(
        exit.kind,
        ParamKindDto::Enum { default, .. } if default == "dead_end_priority"
    ));
    let one_way = strategy
        .params
        .iter()
        .find(|p| p.id == "teleport_loop_one_way_chance")
        .unwrap();
    assert!(matches!(
        one_way.kind,
        ParamKindDto::Float { default, min, max }
            if default == 50.0 && min == 0.0 && max == 100.0
    ));
}

#[test]
fn dead_end_to_passage_exposes_its_one_way_chance() {
    let strategy = available_strategies_list()
        .into_iter()
        .find(|s| s.id == "dead_end_to_passage")
        .expect("dead_end_to_passage must be registered");
    assert_eq!(strategy.handles, INVALID_DEAD_END.as_str());
    assert_eq!(strategy.params.len(), 1);
    assert!(matches!(
        strategy.params[0],
        ParamDescriptor {
            id: "dead_end_one_way_chance",
            kind: ParamKindDto::Float { default, min, max },
            ..
        } if default == 0.0 && min == 0.0 && max == 100.0
    ));
}

#[test]
fn dead_end_to_vertical_passage_is_a_multi_floor_dead_end_fixer() {
    let strategy = available_strategies_list()
        .into_iter()
        .find(|s| s.id == "dead_end_to_vertical_passage")
        .expect("dead_end_to_vertical_passage must be registered");
    assert_eq!(strategy.handles, INVALID_DEAD_END.as_str());
    assert_eq!(strategy.visibility, Some(EntityVisibility::MultiFloorOnly));
    assert!(matches!(
        strategy.params.as_slice(),
        [ParamDescriptor {
            id: "dead_end_one_way_chance",
            kind: ParamKindDto::Float { default, min, max },
            ..
        }] if *default == 0.0 && *min == 0.0 && *max == 100.0
    ));
}

#[test]
fn dead_end_to_split_uses_the_shared_split_configuration() {
    let strategy = available_strategies_list()
        .into_iter()
        .find(|s| s.id == "dead_end_to_split")
        .expect("dead_end_to_split must be registered");
    assert_eq!(strategy.handles, INVALID_DEAD_END.as_str());
    assert!(matches!(
        strategy.params.as_slice(),
        [ParamDescriptor {
            id: "split_config",
            kind: ParamKindDto::SplitGenerationConfig,
            ..
        }]
    ));
}

#[test]
fn dead_end_to_teleport_is_available_as_a_nested_dead_end_fixer() {
    let strategy = available_strategies_list()
        .into_iter()
        .find(|s| s.id == "dead_end_to_teleport")
        .expect("dead_end_to_teleport must be registered");
    assert_eq!(strategy.handles, INVALID_DEAD_END.as_str());
    let ids: Vec<_> = strategy.params.iter().map(|param| param.id).collect();
    assert_eq!(
        ids,
        vec![
            "one_way_chance",
            "allow_cross_floor",
            "desired_length",
            "allow_out_of_interval",
            "exit_pick",
            "attempts_limit",
        ]
    );
    assert_eq!(
        strategy
            .params
            .iter()
            .find(|param| param.id == "allow_cross_floor")
            .unwrap()
            .visibility,
        Some(EntityVisibility::MultiFloorOnly)
    );
}

#[test]
fn dead_end_group_select_exposes_a_single_dead_end_fixer_slot() {
    let strategy = available_strategies_list()
        .into_iter()
        .find(|s| s.id == "dead_end_group_select")
        .expect("dead_end_group_select must be registered");
    assert_eq!(strategy.handles, INVALID_DEAD_END_GROUP.as_str());
    assert!(strategy.params.iter().any(|p| p.id == "priority"));
    assert_eq!(strategy.nested_slots.len(), 1);
    assert_eq!(strategy.nested_slots[0].slot_id, "fix_target");
    assert_eq!(strategy.nested_slots[0].kind, INVALID_DEAD_END.as_str());
}

#[test]
fn priority_dead_end_exposes_a_priority_dispatched_dead_end_slot() {
    let strategy = available_strategies_list()
        .into_iter()
        .find(|s| s.id == "priority_dead_end")
        .expect("priority_dead_end must be registered");
    assert_eq!(strategy.handles, INVALID_DEAD_END.as_str());
    assert!(strategy.params.is_empty());
    assert_eq!(strategy.nested_slots.len(), 1);
    assert_eq!(strategy.nested_slots[0].slot_id, "dead_end_repair_target");
    assert_eq!(strategy.nested_slots[0].kind, INVALID_DEAD_END.as_str());
    assert!(matches!(
        strategy.nested_slots[0].dispatch_kind,
        NestedDispatchKindDto::Priority
    ));
}

#[test]
fn weighted_dead_end_exposes_a_weighted_dispatched_dead_end_slot() {
    let strategy = available_strategies_list()
        .into_iter()
        .find(|s| s.id == "weighted_dead_end")
        .expect("weighted_dead_end must be registered");
    assert_eq!(strategy.handles, INVALID_DEAD_END.as_str());
    assert!(strategy.params.is_empty());
    assert_eq!(strategy.nested_slots.len(), 1);
    assert_eq!(strategy.nested_slots[0].slot_id, "dead_end_repair_target");
    assert_eq!(strategy.nested_slots[0].kind, INVALID_DEAD_END.as_str());
    assert!(matches!(
        strategy.nested_slots[0].dispatch_kind,
        NestedDispatchKindDto::Weighted
    ));
}

#[test]
fn every_other_param_is_always_visible() {
    for strategy in available_strategies_list() {
        for param in strategy.params {
            if strategy.id == "scored_endpoints"
                && (param.id == "cross_floor_weight" || param.id == "elevator_stop_weight")
            {
                continue;
            }
            if strategy.id == "missing_teleports"
                && (param.id == "cross_floor_mode" || param.id == "cross_floor_balance")
            {
                continue;
            }
            if strategy.id == "dead_end_to_teleport" && param.id == "allow_cross_floor" {
                continue;
            }
            if (strategy.id == "invalid_loop_random" || strategy.id == "invalid_loop_scored")
                && param.id == "vertical_passage_priority"
            {
                continue;
            }
            if strategy.id == "missing_loops_vertical" && param.id == "vertical_loop_one_way_chance"
            {
                continue;
            }
            assert_eq!(
                param.visibility, None,
                "strategy {} param {} should be always-visible",
                strategy.id, param.id
            );
        }
    }
}

#[test]
fn loop_strategies_mark_vertical_entities_multi_floor_only() {
    let strategies = available_strategies_list();

    for strategy_id in ["invalid_loop_random", "invalid_loop_scored"] {
        let strategy = strategies.iter().find(|s| s.id == strategy_id).unwrap();
        let param = strategy
            .params
            .iter()
            .find(|p| p.id == "vertical_passage_priority")
            .unwrap();
        assert_eq!(param.visibility, Some(EntityVisibility::MultiFloorOnly));
    }

    let vertical = strategies
        .iter()
        .find(|s| s.id == "missing_loops_vertical")
        .unwrap();
    let param = vertical
        .params
        .iter()
        .find(|p| p.id == "vertical_loop_one_way_chance")
        .unwrap();
    assert_eq!(param.visibility, Some(EntityVisibility::MultiFloorOnly));
}

// GitHub issue #349/#560 follow-up: every strategy that only makes sense with vertical passages/
// elevators (which don't exist on a single-floor maze) is hidden from the selection dialogs
// there — mirrors `only_vertical_passage_and_elevator_checks_are_multi_floor_only` in
// `checks_catalog.rs`.
#[test]
fn only_vertical_passage_and_elevator_strategies_are_multi_floor_only() {
    let strategies = available_strategies_list();
    let hidden: Vec<&str> = strategies
        .iter()
        .filter(|s| s.visibility == Some(EntityVisibility::MultiFloorOnly))
        .map(|s| s.id)
        .collect();
    let mut hidden_sorted = hidden.clone();
    hidden_sorted.sort();
    assert_eq!(
        hidden_sorted,
        vec![
            "add_elevator",
            "add_elevator_height_stop",
            "add_elevator_stop",
            "add_elevator_stop_count",
            "add_elevator_stop_for_gap",
            "add_vertical_passage",
            "dead_end_to_vertical_passage",
            "elevator_group_select",
            "elevator_region_merge",
            "elevator_stop_group_select",
            "missing_loops_vertical",
            "remove_elevator",
            "remove_elevator_stop",
            "remove_vertical_passage",
            "replace_elevator_with_passages",
            "vertical_passage_group_select",
            "vertical_passage_region_merge",
        ],
        "unexpected set of multi-floor-only strategies: {hidden:?}"
    );
}

// GitHub issue #486: element-adding strategies surface `reserve_percent`/`attempts_limit` as
// dispatcher-owned when run nested. The web UI hides those rows on a nested node keyed on this
// list; a suppressed id that isn't in the strategy's own `params` would be a dangling
// reference the web can't act on, so pin the invariant.
#[test]
fn every_suppressed_param_id_is_one_of_the_strategys_own_params() {
    for strategy in available_strategies_list() {
        for id in strategy.nested_suppressed_params {
            assert!(
                strategy.params.iter().any(|p| p.id == *id),
                "strategy {} suppresses param {} it does not declare",
                strategy.id,
                id
            );
        }
    }
}

#[test]
fn add_strategies_suppress_reserve_and_attempts_when_nested() {
    let strategies = available_strategies_list();
    for id in [
        "missing_one_ways_from_wall",
        "missing_one_ways_from_passage",
        "add_vertical_passage",
        "add_elevator_stop",
        "add_split",
    ] {
        let s = strategies.iter().find(|s| s.id == id).unwrap();
        assert_eq!(
            s.nested_suppressed_params,
            &["reserve_percent", "attempts_limit"],
            "strategy {id}"
        );
    }
}
