mod nested_strategy_tests {
    use crate::config::{
        CheckInstanceConfig, GenerateConfig, QcRuleConfig, StageConfig, StrategyConfig,
        TessellationKind,
    };
    use crate::runner::rule_factory::build_qc_and_repair;
    use crate::runner::run_from_config;
    use maze_core::space::SquareTessellation;
    use std::collections::HashMap;

    fn scc_count_rule(strategy: Option<StrategyConfig>) -> QcRuleConfig {
        QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "scc_count".to_string(),
                type_id: "scc_count".to_string(),
                params: HashMap::new(),
            }],
            strategy,
            params: HashMap::new(),
        }
    }

    fn one_stage(rule: QcRuleConfig) -> Vec<StageConfig> {
        vec![StageConfig {
            id: "s1".to_string(),
            name: "Stage 1".to_string(),
            rules: vec![rule],
        }]
    }

    /// Builds a `StrategyConfig` with no params — every test in this module only ever varies
    /// `id`/`slot_id`/`nested`, never `params`.
    fn strategy_cfg(
        id: &str,
        slot_id: Option<&str>,
        nested: Vec<StrategyConfig>,
    ) -> StrategyConfig {
        StrategyConfig {
            id: id.to_string(),
            params: HashMap::new(),
            slot_id: slot_id.map(str::to_string),
            nested,
        }
    }

    fn reduce_scc_count_with_nested(nested: Vec<StrategyConfig>) -> StrategyConfig {
        strategy_cfg("reduce_scc_count", None, nested)
    }

    fn build_with_strategy(
        strategy: StrategyConfig,
    ) -> Result<maze_core::quality_control::QualityControlEngine<SquareTessellation>, String> {
        let rule = scc_count_rule(Some(strategy));
        let config = GenerateConfig {
            stages: one_stage(rule),
            ..Default::default()
        };
        build_qc_and_repair::<SquareTessellation>(&config)
    }

    #[test]
    fn reduce_scc_count_without_nested_is_rejected() {
        let strategy = reduce_scc_count_with_nested(vec![]);
        let result = build_with_strategy(strategy);
        assert!(
            result.is_err(),
            "reduce_scc_count's merge_target slot has min: 1 — no nested must be rejected"
        );
    }

    #[test]
    fn reduce_scc_count_nested_missing_slot_id_is_rejected() {
        let nested = strategy_cfg("expand_region_passage", None, vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(
            result.is_err(),
            "a nested StrategyConfig with no slot_id must be rejected"
        );
    }

    #[test]
    fn reduce_scc_count_nested_with_incompatible_kind_is_rejected() {
        // invalid_loop_random handles INVALID_LOOP, not REGION_NEEDS_EXPANSION — must be
        // rejected as incompatible with the merge_target slot.
        let nested = strategy_cfg("invalid_loop_random", Some("merge_target"), vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(
            result.is_err(),
            "a nested strategy handling the wrong IssueKind must be rejected"
        );
    }

    #[test]
    fn reduce_scc_count_nested_with_unknown_slot_id_is_rejected() {
        let nested = strategy_cfg("expand_region_passage", Some("no_such_slot"), vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(result.is_err(), "an unknown slot_id must be rejected");
    }

    #[test]
    fn reduce_scc_count_two_nested_for_single_slot_is_rejected() {
        let make_nested = || strategy_cfg("expand_region_passage", Some("merge_target"), vec![]);
        let strategy = reduce_scc_count_with_nested(vec![make_nested(), make_nested()]);
        let result = build_with_strategy(strategy);
        assert!(
            result.is_err(),
            "merge_target's max: Some(1) must reject a second nested strategy for the same slot"
        );
    }

    #[test]
    fn top_level_strategy_with_slot_id_is_rejected() {
        let strategy = strategy_cfg("farthest_endpoints", Some("merge_target"), vec![]);
        let rule = QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "missing_endpoints".to_string(),
                type_id: "missing_endpoints".to_string(),
                params: HashMap::new(),
            }],
            strategy: Some(strategy),
            params: HashMap::new(),
        };
        let config = GenerateConfig {
            stages: one_stage(rule),
            ..Default::default()
        };
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(
            result.is_err(),
            "a top-level strategy must not declare slot_id"
        );
    }

    /// Two disjoint 2x2 islands with a gap between them (points x in 0..2 and x in 4..6) —
    /// generation can only ever connect geometrically-adjacent cells, so this always yields
    /// exactly 2 SCCs after base generation, regardless of algorithm/seed, and no shared wall
    /// ever exists between the islands for expand_region_passage to bridge.
    fn two_disjoint_islands_points() -> Vec<[i32; 2]> {
        let mut points = vec![];
        for x in 0..2 {
            for y in 0..2 {
                points.push([x, y]);
            }
        }
        for x in 4..6 {
            for y in 0..2 {
                points.push([x, y]);
            }
        }
        points
    }

    fn config_with_points(points: Vec<[i32; 2]>) -> GenerateConfig {
        GenerateConfig {
            tessellation: crate::config::TessellationConfig {
                kind: TessellationKind::Square,
                params: serde_json::Map::new(),
            },
            level_fields: vec![points],
            ..Default::default()
        }
    }

    fn issue_kinds(result: &crate::runner::MazeRunResult) -> Vec<&'static str> {
        result
            .remaining_issues
            .iter()
            .map(|i| i.kind().as_str())
            .collect()
    }

    #[test]
    fn end_to_end_reduce_scc_count_converges_to_max_scc_count() {
        // scc_count with max_scc_count=1 flags EXCESSIVE_SCC_COUNT; reduce_scc_count (nested
        // under expand_region_passage) must still fail to fully merge the two disjoint islands
        // (no bridging candidate) — this test checks the simpler, always-true contract: the
        // pipeline runs without error and reports the SCC-count issue when unresolved, proving
        // the wiring (check -> rule -> reduce_scc_count -> nested expand_region_passage) is live
        // end-to-end.
        let mut config = config_with_points(two_disjoint_islands_points());

        let scc_check_rule = QcRuleConfig {
            id: "r_scc".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "scc_count".to_string(),
                type_id: "scc_count".to_string(),
                params: HashMap::from([("max_scc_count".to_string(), "1".to_string())]),
            }],
            strategy: Some(reduce_scc_count_with_nested(vec![strategy_cfg(
                "expand_region_passage",
                Some("merge_target"),
                vec![],
            )])),
            params: HashMap::new(),
        };
        config.stages[0].rules.push(scc_check_rule);

        let result = run_from_config(1, &config);
        assert!(
            result.is_ok(),
            "run_from_config must succeed end-to-end: {:?}",
            result.err()
        );
        let result = result.unwrap();
        // Two geometrically-disjoint islands can never be bridged by expand_region_passage (no
        // shared wall exists between them) — the issue is expected to remain unresolved, proving
        // the strategy was actually dispatched (not silently skipped) and correctly reported
        // Failed rather than panicking or silently succeeding.
        assert!(
            result
                .remaining_issues
                .iter()
                .any(|i| i.kind().as_str() == "excessive_scc_count"),
            "excessive_scc_count must still be reported since the two islands cannot be bridged: {:?}",
            issue_kinds(&result)
        );
    }

    #[test]
    fn end_to_end_reduce_scc_count_actually_reduces_component_count_on_contiguous_field() {
        // A contiguous field lets expand_region_passage actually bridge every SCC (every region
        // has a geometrically-adjacent neighbor, unlike the disjoint-islands test above) — this
        // verifies reduce_scc_count doesn't just get dispatched but genuinely reduces the SCC
        // count via its nested strategy. `one_way_chance: 1.0` (every edge one-way) reliably
        // fragments a contiguous field's undirected spanning structure into several SCCs.
        let mut points = vec![];
        for x in 0..4 {
            for y in 0..4 {
                points.push([x, y]);
            }
        }
        let mut config = config_with_points(points);
        config.elements.one_way_chance = Some(1.0);

        let scc_check_rule = QcRuleConfig {
            id: "r_scc".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "scc_count".to_string(),
                type_id: "scc_count".to_string(),
                params: HashMap::from([("max_scc_count".to_string(), "1".to_string())]),
            }],
            strategy: Some(reduce_scc_count_with_nested(vec![strategy_cfg(
                "expand_region_passage",
                Some("merge_target"),
                vec![],
            )])),
            params: HashMap::new(),
        };
        config.stages[0].rules.push(scc_check_rule);

        let result = run_from_config(1, &config).expect("run_from_config must succeed");
        assert!(
            !result
                .remaining_issues
                .iter()
                .any(|i| i.kind().as_str() == "excessive_scc_count"),
            "a fully contiguous field must let reduce_scc_count converge to max_scc_count=1: {:?}",
            issue_kinds(&result)
        );
    }

    #[test]
    fn end_to_end_weighted_region_merge_retries_after_geometric_failure_via_teleport() {
        // Two disjoint 2x2 islands, same shape as the reduce_scc_count disjoint-islands test
        // above — expand_region_passage is guaranteed to fail (no shared wall between islands),
        // teleport_region_merge is guaranteed to succeed (not geometry-bound, any other SCC
        // component is a valid candidate). This proves dispatch_weighted actually retries: the
        // only way REGION_NEEDS_EXPANSION gets resolved on this fixture is if the
        // geometry-bound candidate is tried, fails, is rolled back, and the teleport candidate is
        // then tried and succeeds — not just "generation converged somehow".
        let mut config = config_with_points(two_disjoint_islands_points());

        let region_rule = QcRuleConfig {
            id: "r_region".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "min_region_size".to_string(),
                type_id: "min_region_size".to_string(),
                params: HashMap::from([("min_region_size".to_string(), "3".to_string())]),
            }],
            strategy: Some(strategy_cfg(
                "weighted_region_merge",
                None,
                vec![
                    strategy_cfg("expand_region_passage", Some("merge_target"), vec![]),
                    strategy_cfg("teleport_region_merge", Some("merge_target"), vec![]),
                ],
            )),
            params: HashMap::new(),
        };
        config.stages[0].rules.push(region_rule);

        let result = run_from_config(1, &config).expect("run_from_config must succeed");
        assert!(
            !result
                .remaining_issues
                .iter()
                .any(|i| i.kind().as_str() == "region_needs_expansion"),
            "weighted_region_merge must resolve region_needs_expansion via the teleport candidate after the geometric one fails: {:?}",
            issue_kinds(&result)
        );
    }

    #[test]
    fn two_level_nesting_is_accepted() {
        // expand_region_passage itself has no nested slots, so its own `nested` must be empty —
        // this exercises build_nested's recursive call one level deeper without needing a real
        // multi-slot strategy to exist yet.
        let nested = strategy_cfg("expand_region_passage", Some("merge_target"), vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(
            result.is_ok(),
            "recursive build_nested must handle a nested strategy with its own (empty) nested list: {:?}",
            result.err()
        );
    }

    #[test]
    fn reduce_scc_count_with_valid_nested_is_accepted() {
        let nested = strategy_cfg("expand_region_passage", Some("merge_target"), vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(
            result.is_ok(),
            "a single valid nested strategy filling merge_target must be accepted: {:?}",
            result.err()
        );
    }

    // `build_nested` is a private fn in the outer module (`super::*` above brings it into scope
    // here), so these tests call it directly against synthetic `expected_nested()` shapes rather
    // than going through `build_qc_and_repair`/real registry strategies — the only way to
    // exercise `max: None` (unbounded slots) and 3+ levels of real nesting, neither of which any
    // strategy in today's registry actually declares (see `Specs/repair.md`'s own admission that
    // depth is "unbounded in the data model... but nothing stops one [level]" being added).
    mod build_nested_generic_shape_tests {
        use crate::config::StrategyConfig;
        use crate::runner::strategy_factory::build_nested;
        use maze_core::Maze;
        use maze_core::generation::PresetState;
        use maze_core::quality_control::{EXCESSIVE_SCC_COUNT, ExcessiveSccCountIssue};
        use maze_core::repair::{
            NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairResult, RepairStrategy,
            StrategyParams,
        };
        use maze_core::space::{SquareTessellation, Tessellation};
        use std::collections::HashMap;

        // A slot-holding strategy that accepts any number (0..) of nested strategies handling
        // EXCESSIVE_SCC_COUNT — `max: None` is never exercised by the real registry today. Its
        // slot's `kind` is chosen to match `reduce_scc_count`'s own `handles()`, so a real
        // registry strategy (not a second mock) can fill it — see
        // `three_level_nesting_resolves_through_a_real_second_level_strategy` below, which uses
        // this to reach 3 real levels without needing a test-only entry in `build_strategy_erased`.
        struct UnboundedSlotStrategy;
        static UNBOUNDED_SLOT: &[NestedSlot] = &[NestedSlot {
            slot_id: "unbounded",
            kind: EXCESSIVE_SCC_COUNT,
            min: 0,
            max: None,
            dispatch_kind: NestedDispatchKind::Unordered,
        }];
        impl<T: Tessellation> RepairStrategy<T, ExcessiveSccCountIssue> for UnboundedSlotStrategy {
            fn strategy_id(&self) -> &'static str {
                "test_unbounded_slot_strategy"
            }
            fn expected_nested(&self) -> &'static [NestedSlot] {
                UNBOUNDED_SLOT
            }
            fn apply(
                &self,
                _: &ExcessiveSccCountIssue,
                _: &Maze<T>,
                _: &mut dyn rand::RngCore,
                _: &StrategyParams,
                _: &PresetState,
                _: &[NestedStrategyConfig<T>],
            ) -> (RepairResult, Vec<maze_core::repair::MutationCommand>) {
                (RepairResult::Failed, vec![])
            }
        }
        maze_core::impl_erased_repair_strategy!(UnboundedSlotStrategy, ExcessiveSccCountIssue);

        fn nested_cfg(id: &str, slot_id: &str, nested: Vec<StrategyConfig>) -> StrategyConfig {
            StrategyConfig {
                id: id.to_string(),
                params: HashMap::new(),
                slot_id: Some(slot_id.to_string()),
                nested,
            }
        }

        #[test]
        fn unbounded_slot_accepts_zero_nested() {
            let result = build_nested::<SquareTessellation>(
                &UnboundedSlotStrategy,
                &[],
                &maze_core::quality_control::RuleParams::default(),
            );
            assert!(
                result.is_ok(),
                "min: 0 must accept an empty nested list: {:?}",
                result.err()
            );
            assert_eq!(result.unwrap().len(), 0);
        }

        #[test]
        fn unbounded_slot_accepts_several_nested_strategies_for_the_same_slot() {
            // Each `reduce_scc_count` entry must fill its own mandatory `merge_target` slot —
            // this test is about the unbounded outer slot accepting 3 siblings, not about
            // reduce_scc_count's own validation, so each sibling gets a minimal valid child.
            let make_reduce_scc_count = || {
                nested_cfg(
                    "reduce_scc_count",
                    "unbounded",
                    vec![nested_cfg("expand_region_passage", "merge_target", vec![])],
                )
            };
            let configs = vec![
                make_reduce_scc_count(),
                make_reduce_scc_count(),
                make_reduce_scc_count(),
            ];
            let result = build_nested::<SquareTessellation>(
                &UnboundedSlotStrategy,
                &configs,
                &maze_core::quality_control::RuleParams::default(),
            );
            assert!(
                result.is_ok(),
                "max: None must accept more than one nested strategy for the same slot: {:?}",
                result.err()
            );
            assert_eq!(
                result.unwrap().len(),
                3,
                "all 3 entries for the unbounded slot must be kept, not deduped or truncated"
            );
        }

        #[test]
        fn three_level_nesting_resolves_through_a_real_second_level_strategy() {
            // Level 1 (UnboundedSlotStrategy, a mock) -> level 2 (reduce_scc_count, a real
            // nested-capable registry strategy) -> level 3 (expand_region_passage, a real leaf
            // strategy filling reduce_scc_count's own merge_target slot). This is a real 3-level
            // chain one level deeper than any path `build_qc_and_repair`'s own tests exercise
            // today (those only ever put reduce_scc_count at the top level).
            let level_3 = nested_cfg("expand_region_passage", "merge_target", vec![]);
            let level_2 = nested_cfg("reduce_scc_count", "unbounded", vec![level_3]);
            let result = build_nested::<SquareTessellation>(
                &UnboundedSlotStrategy,
                &[level_2],
                &maze_core::quality_control::RuleParams::default(),
            );
            assert!(
                result.is_ok(),
                "a real 3-level nested chain must resolve: {:?}",
                result.err()
            );
            let resolved = result.unwrap();
            assert_eq!(resolved.len(), 1);
            assert_eq!(resolved[0].strategy.strategy_id(), "reduce_scc_count");
            assert_eq!(
                resolved[0].nested.len(),
                1,
                "level 2's own merge_target slot must be resolved recursively, not left empty"
            );
            assert_eq!(
                resolved[0].nested[0].strategy.strategy_id(),
                "expand_region_passage"
            );
            assert_eq!(
                resolved[0].nested[0].nested.len(),
                0,
                "expand_region_passage has no slots of its own"
            );
        }

        #[test]
        fn three_level_nesting_rejects_incompatible_kind_at_the_deepest_level() {
            // Level 3 handles INVALID_LOOP, but level 2's (reduce_scc_count) own merge_target
            // slot expects REGION_NEEDS_EXPANSION — the incompatibility must be caught at
            // whichever depth it actually occurs, not just at the top level.
            let level_3 = nested_cfg("invalid_loop_random", "merge_target", vec![]);
            let level_2 = nested_cfg("reduce_scc_count", "unbounded", vec![level_3]);
            let result = build_nested::<SquareTessellation>(
                &UnboundedSlotStrategy,
                &[level_2],
                &maze_core::quality_control::RuleParams::default(),
            );
            assert!(
                result.is_err(),
                "a kind mismatch at depth 3 must still be rejected: {:?}",
                result.ok().map(|_| ())
            );
        }
    }
}

mod build_strategy_tests {
    use crate::runner::strategy_factory::build_strategy_erased;
    use maze_core::space::SquareTessellation;
    use std::collections::HashMap;

    // `build_strategy`'s match arms hand-pair a string literal with a `Box::new(SomeStruct)` —
    // nothing in the type system checks that `SomeStruct::strategy_id()` actually equals that
    // same string. A copy-paste error (wrong struct pointed at an arm's key, or two arms
    // swapped) would silently construct the wrong strategy for a given id, surfacing only
    // indirectly through unrelated-looking test failures or wrong runtime behavior — this test
    // catches that class of bug directly, at the exact point of introduction.
    const ALL_KNOWN_STRATEGY_IDS: &[&str] = &[
        "random_endpoints",
        "farthest_endpoints",
        "scored_endpoints",
        "invalid_loop_random",
        "invalid_loop_scored",
        "dead_end_group_select",
        "dead_end_to_passage",
        "dead_end_to_split",
        "dead_end_to_teleport",
        "dead_end_to_vertical_passage",
        "priority_dead_end",
        "missing_loops_random",
        "expand_region_passage",
        "teleport_region_merge",
        "vertical_passage_region_merge",
        "elevator_region_merge",
        "missing_regions",
        "reduce_scc_count",
        "weighted_region_merge",
        "weighted_dead_end",
        "remove_teleport",
        "teleport_group_select",
        "one_way_to_passage",
        "one_way_to_wall",
        "missing_one_ways_from_passage",
        "missing_one_ways_from_wall",
        "missing_teleports",
        "remove_split",
        "split_group_select",
        "add_split",
    ];

    #[test]
    fn every_known_id_builds_a_strategy_whose_own_strategy_id_matches() {
        let no_params = HashMap::new();
        let rule_params = maze_core::quality_control::RuleParams::default();
        for &id in ALL_KNOWN_STRATEGY_IDS {
            let strategy =
                build_strategy_erased::<SquareTessellation>(id, &no_params, &rule_params)
                    .unwrap_or_else(|e| panic!("build_strategy_erased({id:?}) failed: {e}"));
            assert_eq!(
                strategy.strategy_id(),
                id,
                "build_strategy_erased({id:?}) constructed a strategy whose own strategy_id() doesn't match — wrong match arm?"
            );
        }
    }

    #[test]
    fn unknown_id_is_rejected() {
        let rule_params = maze_core::quality_control::RuleParams::default();
        assert!(
            build_strategy_erased::<SquareTessellation>(
                "not_a_real_strategy",
                &HashMap::new(),
                &rule_params
            )
            .is_err()
        );
    }
}

mod build_check_tests {
    use crate::config::CheckInstanceConfig;
    use crate::runner::check_factory::{
        build_excessive_scc_count_check, build_invalid_elevator_check,
        build_invalid_elevator_group_check, build_invalid_loop_check,
        build_invalid_loop_group_check, build_invalid_one_way_check,
        build_invalid_split_node_check, build_invalid_split_route_check,
        build_invalid_split_tile_check, build_invalid_teleport_check,
        build_invalid_vertical_passage_group_check, build_missing_endpoints_check,
        build_missing_loops_check, build_missing_one_ways_check, build_missing_regions_check,
        build_missing_split_tiles_check, build_missing_teleports_check,
        build_missing_vertical_passages_check, build_one_way_group_proximity_check,
        build_region_needs_expansion_check, build_region_needs_shrink_check,
        build_split_group_check, build_split_node_connection_group_check,
        build_split_node_group_check, build_teleport_group_proximity_check,
        build_unreachable_finish_check,
    };
    use crate::runner::qc_kind_registry::check_kind_for_type;
    use maze_core::space::{SquareTessellation, Tessellation};
    use std::collections::HashMap;
    use std::sync::Arc;

    // Same rationale as `build_strategy_tests::every_known_id_builds_a_strategy_whose_own_strategy_id_matches`
    // above, but for `build_check`: its match arms hand-pair a string literal with a
    // `Box::new(SomeCheck { .. })`, and nothing in the type system checks that
    // `SomeCheck::check_type_id()` actually equals that same string. Also exercises
    // `check_kind_for_type` (generated by `qc_kind_registry!`, GitHub issue #407) — a check added
    // to a `build_*_check` arm but missing from the registry table would otherwise go unnoticed
    // until a live config exercised the missing arm (and `check_kind_for_type` panics on an
    // unknown id).
    const ALL_KNOWN_CHECK_TYPE_IDS: &[&str] = &[
        "missing_endpoints",
        "unreachable_finish",
        "min_loops_count",
        "min_loop_density",
        "loop_length",
        "external_escape_diversity",
        "loop_distance_from_start",
        "loop_distance_from_finish",
        "max_loop_density",
        "max_loops_count",
        "scc_count",
        "min_region_size",
        "min_region_ratio",
        "max_region_size",
        "max_region_ratio",
        "min_region_count",
        "teleport_duplicates_connection",
        "teleport_waypoint_distance",
        "teleport_geometric_length",
        "teleport_graph_distance",
        "teleport_super_hub_avoidance",
        "teleport_split_intersection",
        "teleport_group_proximity",
        "one_way_waypoint_distance",
        "one_way_group_geometric_proximity",
        "one_way_group_graph_proximity",
        "one_way_group_super_hub",
        "max_one_way_count",
        "max_one_way_ratio",
        "min_one_way_count",
        "min_one_way_ratio",
        "min_teleport_count",
        "min_teleport_ratio",
        "max_teleport_count",
        "max_teleport_density",
        "split_count",
        "split_density",
        "split_distance_from_waypoint",
        "split_teleport_intersection",
        "split_node_connection_count",
        "split_node_connection_per_neighbor",
        "split_node_connection_per_face",
        "max_split_tile_node_count",
        "max_split_count",
        "max_split_density",
        "split_group_geometric_proximity",
        "split_group_graph_proximity",
        "split_node_connection_traversal_distance",
        "min_vertical_passage_count",
        "min_vertical_passage_ratio",
        "max_vertical_passage_count",
        "max_vertical_passage_ratio",
        "vertical_passage_group_geometric_proximity",
        "vertical_passage_group_graph_proximity",
        "elevator_stop_count",
        "elevator_span",
        "max_elevator_count",
        "max_elevator_density",
    ];

    /// Test-only dispatcher mirroring `build_rule_for!`'s own `KindTag` match, but returning just
    /// the built check's `check_type_id()` — the one thing these regression tests need — instead
    /// of a `Box<dyn Check<T, I>>` (whose concrete `I` differs per arm and so can't be returned
    /// as one unified type). `None` means `instance.type_id` is unknown to every `KindTag` arm.
    fn build_check_type_id<T: Tessellation>(
        instance: &CheckInstanceConfig,
        instance_id: String,
    ) -> Option<&'static str> {
        let rule_params = maze_core::quality_control::RuleParams::default();
        macro_rules! try_ctor {
            ($ctor:ident) => {
                if let Some(check) = $ctor::<T>(instance, instance_id.clone(), &rule_params) {
                    return Some(check.check_type_id());
                }
            };
        }
        try_ctor!(build_missing_endpoints_check);
        try_ctor!(build_unreachable_finish_check);
        try_ctor!(build_missing_loops_check);
        try_ctor!(build_invalid_loop_check);
        try_ctor!(build_invalid_loop_group_check);
        try_ctor!(build_excessive_scc_count_check);
        try_ctor!(build_region_needs_expansion_check);
        try_ctor!(build_region_needs_shrink_check);
        try_ctor!(build_missing_regions_check);
        try_ctor!(build_invalid_teleport_check);
        try_ctor!(build_teleport_group_proximity_check);
        try_ctor!(build_invalid_one_way_check);
        try_ctor!(build_one_way_group_proximity_check);
        try_ctor!(build_missing_one_ways_check);
        try_ctor!(build_missing_teleports_check);
        try_ctor!(build_missing_split_tiles_check);
        try_ctor!(build_invalid_split_tile_check);
        try_ctor!(build_invalid_split_node_check);
        try_ctor!(build_split_node_connection_group_check);
        try_ctor!(build_split_node_group_check);
        try_ctor!(build_split_group_check);
        try_ctor!(build_invalid_split_route_check);
        try_ctor!(build_missing_vertical_passages_check);
        try_ctor!(build_invalid_vertical_passage_group_check);
        try_ctor!(build_invalid_elevator_check);
        try_ctor!(build_invalid_elevator_group_check);
        None
    }

    #[test]
    fn every_known_id_builds_a_check_whose_own_check_type_id_matches() {
        for &id in ALL_KNOWN_CHECK_TYPE_IDS {
            let instance = CheckInstanceConfig {
                local_id: "0".to_string(),
                type_id: id.to_string(),
                params: HashMap::new(),
            };
            let check_type_id =
                build_check_type_id::<SquareTessellation>(&instance, "instance".to_string())
                    .unwrap_or_else(|| {
                        panic!("build_check_type_id({id:?}) found no matching KindTag arm")
                    });
            assert_eq!(
                check_type_id, id,
                "build_check_type_id({id:?}) constructed a check whose own check_type_id() doesn't match — wrong match arm?"
            );
            // Must also resolve in check_kind_for_type's independent match — panics on unknown id.
            let _ = check_kind_for_type(id);
        }
    }

    #[test]
    fn unknown_id_is_rejected() {
        let instance = CheckInstanceConfig {
            local_id: "0".to_string(),
            type_id: "not_a_real_check".to_string(),
            params: HashMap::new(),
        };
        assert!(
            build_check_type_id::<SquareTessellation>(&instance, "instance".to_string()).is_none()
        );
    }

    #[test]
    fn teleport_group_proximity_parses_a_fractional_distance_string() {
        // Regression guard: "distance" used to be parsed as i64, silently dropping any
        // fractional config value (e.g. "1.1") to the 0.0 default via .ok() -- teleports meant
        // to be flagged at distance 1 were never caught because the effective threshold fell
        // back to 0. Now parsed as f64: build a check with distance="1.1" from a raw config
        // string (as the web layer would send it) and confirm it actually flags a gap of 1.
        use maze_core::graph::EdgeKind;
        use maze_core::space::{MultiLevelField, SquarePoint, square_rect};
        use maze_core::{Graph, IdGenerator, Maze};
        use rand::SeedableRng;

        let mut params = HashMap::new();
        params.insert("distance".to_string(), "1.1".to_string());
        let instance = CheckInstanceConfig {
            local_id: "0".to_string(),
            type_id: "teleport_group_proximity".to_string(),
            params,
        };
        let rule_params = maze_core::quality_control::RuleParams::default();
        let check = build_teleport_group_proximity_check::<SquareTessellation>(
            &instance,
            "instance".to_string(),
            &rule_params,
        )
        .expect("build_teleport_group_proximity_check must accept a fractional distance string");

        // Two teleports whose entries sit exactly 1 tile-hop apart -- must be flagged against
        // threshold 1.1 (1 < 1.1), but would NOT be flagged against the old silently-truncated
        // fallback of 0.0.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| {
            field
                .nodes_at(level, SquarePoint { x, y: 0 })
                .first()
                .copied()
                .unwrap()
        };
        g.build_initial_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.build_initial_edge(p(0), p(2), EdgeKind::Teleport);
        g.build_initial_edge(p(1), p(3), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "distance=1.1 must flag a pair of teleports 1 tile-hop apart, proving the fractional value wasn't truncated to 0 or 1"
        );
    }
}

/// Coverage for the rule-level `protect_route` wiring (GitHub issue #253) — the factory-layer
/// guards rejecting a local `protect_route` override on a migrated check/strategy, and the
/// end-to-end invariant that a rule's resolved `RuleParams` reaches every one of its own
/// checks/strategy identically. See `Specs/quality_control.md`'s "Rule-level parameters" section.
mod rule_level_params_tests {
    use crate::config::{
        CheckInstanceConfig, GenerateConfig, QcRuleConfig, StageConfig, StrategyConfig,
    };
    use crate::runner::rule_factory::build_qc_and_repair;
    use maze_core::space::SquareTessellation;
    use std::collections::HashMap;

    fn one_stage(rule: QcRuleConfig) -> Vec<StageConfig> {
        vec![StageConfig {
            id: "s1".to_string(),
            name: "Stage 1".to_string(),
            rules: vec![rule],
        }]
    }

    fn build(
        rule: QcRuleConfig,
    ) -> Result<maze_core::quality_control::QualityControlEngine<SquareTessellation>, String> {
        let config = GenerateConfig {
            stages: one_stage(rule),
            ..Default::default()
        };
        build_qc_and_repair::<SquareTessellation>(&config)
    }

    #[test]
    fn local_protect_route_on_a_migrated_check_is_rejected() {
        // teleport_waypoint_distance is one of the checks migrated to rule-level protect_route
        // (GitHub issue #253) — a leftover local override in its own params must be a hard error,
        // not silently ignored (see rule_factory.rs's build_rule_for! guard).
        let mut params = HashMap::new();
        params.insert("protect_route".to_string(), "false".to_string());
        let rule = QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "0".to_string(),
                type_id: "teleport_waypoint_distance".to_string(),
                params,
            }],
            strategy: None,
            params: HashMap::new(),
        };
        let err = match build(rule) {
            Err(e) => e,
            Ok(_) => panic!("expected build to fail"),
        };
        assert!(
            err.contains("protect_route"),
            "error must name the offending param: {err}"
        );
    }

    #[test]
    fn local_protect_route_on_a_migrated_strategy_is_rejected() {
        // teleport_group_select is one of the strategies migrated to rule-level protect_route —
        // a leftover local override in its own StrategyConfig.params must be a hard error (see
        // strategy_factory.rs's build_strategy_erased guard).
        let mut strategy_params = HashMap::new();
        strategy_params.insert("protect_route".to_string(), "false".to_string());
        let rule = QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "0".to_string(),
                type_id: "teleport_group_proximity".to_string(),
                params: HashMap::new(),
            }],
            strategy: Some(StrategyConfig {
                id: "teleport_group_select".to_string(),
                params: strategy_params,
                slot_id: None,
                nested: vec![],
            }),
            params: HashMap::new(),
        };
        let err = match build(rule) {
            Err(e) => e,
            Ok(_) => panic!("expected build to fail"),
        };
        assert!(
            err.contains("protect_route"),
            "error must name the offending param: {err}"
        );
    }

    #[test]
    fn local_protect_route_on_a_non_migrated_check_is_still_accepted_as_an_unknown_local_param() {
        // A check with no protect_route field at all (e.g. min_region_count, not in
        // protect_route's applies_to list) must not be affected by the migrated-param guard —
        // this only proves the guard is scoped to actual consumers, not every check.
        let rule = QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "0".to_string(),
                type_id: "min_region_count".to_string(),
                params: HashMap::new(),
            }],
            strategy: None,
            params: HashMap::new(),
        };
        assert!(
            build(rule).is_ok(),
            "a check unrelated to protect_route must build normally"
        );
    }

    #[test]
    fn unknown_rule_level_param_key_is_rejected() {
        let mut rule_params = HashMap::new();
        rule_params.insert("protect_rooute".to_string(), "false".to_string());
        let rule = QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "0".to_string(),
                type_id: "teleport_waypoint_distance".to_string(),
                params: HashMap::new(),
            }],
            strategy: None,
            params: rule_params,
        };
        let err = match build(rule) {
            Err(e) => e,
            Ok(_) => panic!("expected build to fail"),
        };
        assert!(
            err.contains("protect_rooute"),
            "error must name the offending key: {err}"
        );
    }

    #[test]
    fn rule_level_protect_route_reaches_every_check_and_the_strategy_identically() {
        // Rule with two teleport checks (both protect_route consumers) plus teleport_group_select
        // as strategy (also a consumer) — protect_route: false set once at rule level must be the
        // resolved value for all three, proving they share one RuleParams instance rather than
        // each independently defaulting.
        let mut rule_params = HashMap::new();
        rule_params.insert("protect_route".to_string(), "false".to_string());
        let rule = QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "0".to_string(),
                type_id: "teleport_group_proximity".to_string(),
                params: HashMap::new(),
            }],
            strategy: Some(StrategyConfig {
                id: "teleport_group_select".to_string(),
                params: HashMap::new(),
                slot_id: None,
                // teleport_group_select's fix_target slot requires exactly one nested strategy
                // (min: 1, max: Some(1)) handling INVALID_TELEPORT — remove_teleport is the sole
                // registry strategy for that kind.
                nested: vec![StrategyConfig {
                    id: "remove_teleport".to_string(),
                    params: HashMap::new(),
                    slot_id: Some("fix_target".to_string()),
                    nested: vec![],
                }],
            }),
            params: rule_params,
        };
        // Building successfully (no rejected local override, no unknown key) together with the
        // dedicated check_factory/strategy_factory unit tests asserting `rule_params.protect_route`
        // is threaded into each constructed check/strategy is the structural guarantee — this test
        // additionally confirms the whole rule (multiple checks + strategy, same kind) builds as
        // one unit against a single resolved RuleParams, not per-member resolution.
        assert!(
            build(rule).is_ok(),
            "rule-level protect_route=false must build successfully for a rule combining a protect_route-consuming check and strategy"
        );
    }
}

/// Coverage for `run_from_config`'s `level_fields` handling (GitHub issue #338 — per-floor field
/// shape): the multi-level assembly loop (`level_fields[1..]` each becoming its own `add_level`'d
/// `Field`, independent of `level_fields[0]`'s shape/size) and the three empty-input guards, none
/// of which were exercised by any existing fixture/test (every prior config used exactly one
/// `level_fields` entry).
mod level_fields_tests {
    use crate::config::{GenerateConfig, TessellationConfig, TessellationKind};
    use crate::runner::run_from_config;

    fn config_with_level_fields(level_fields: Vec<Vec<[i32; 2]>>) -> GenerateConfig {
        GenerateConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::Square,
                params: serde_json::Map::new(),
            },
            level_fields,
            ..Default::default()
        }
    }

    #[test]
    fn two_differently_sized_levels_both_contribute_their_own_node_count() {
        // Floor 0: a 2-cell field. Floor 1: an independently-shaped 3-cell field, disjoint in
        // coordinate space from floor 0 (would collide with floor 0's own points otherwise, since
        // per-level Field construction doesn't offset coordinates). Total graph nodes must be the
        // sum of both levels' own point counts (2 + 3 = 5) — proving level_fields[1] is actually
        // built as its own independent Field and added, not skipped or merged into level 0.
        let level0 = vec![[0, 0], [1, 0]];
        let level1 = vec![[10, 10], [11, 10], [12, 10]];
        let config = config_with_level_fields(vec![level0, level1]);

        let result =
            run_from_config(1, &config).expect("multi-level config must generate successfully");

        assert_eq!(
            result.graph.nodes().count(),
            5,
            "graph must contain every node from both levels"
        );
    }

    #[test]
    fn empty_level_fields_is_rejected() {
        let config = config_with_level_fields(vec![]);
        let err = match run_from_config(1, &config) {
            Err(e) => e,
            Ok(_) => panic!("empty level_fields must be rejected"),
        };
        assert!(
            err.contains("level_fields must not be empty"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn empty_first_level_is_rejected() {
        let config = config_with_level_fields(vec![vec![], vec![[0, 0]]]);
        let err = match run_from_config(1, &config) {
            Err(e) => e,
            Ok(_) => panic!("empty level_fields[0] must be rejected"),
        };
        assert!(
            err.contains("level_fields[0] must not be empty"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn empty_later_level_is_rejected() {
        let config = config_with_level_fields(vec![vec![[0, 0], [1, 0]], vec![]]);
        let err = match run_from_config(1, &config) {
            Err(e) => e,
            Ok(_) => panic!("an empty later level_fields entry must be rejected"),
        };
        assert!(
            err.contains("level_fields entry must not be empty"),
            "unexpected error: {err}"
        );
    }
}

/// Coverage for Cairo's native runner dispatch (GitHub issue #710). Cairo uses the same
/// multi-level generation pipeline as the existing tessellations, while its integer coordinate
/// space rejects unused pairs such as (0, 0).
mod cairo_dispatch_tests {
    use crate::config::{GenerateConfig, TessellationConfig, TessellationKind};
    use crate::runner::run_from_config;
    use maze_core::space::{CairoPoint, CairoTessellation};

    fn cairo_config(level_fields: Vec<Vec<[i32; 2]>>) -> GenerateConfig {
        GenerateConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::Cairo,
                params: serde_json::Map::new(),
            },
            level_fields,
            ..Default::default()
        }
    }

    #[test]
    fn generation_dispatches_cairo_single_level() {
        let points: Vec<[i32; 2]> = CairoTessellation::rect(3, 3)
            .into_iter()
            .map(|p| [p.x, p.y])
            .collect();
        let result = run_from_config(710, &cairo_config(vec![points]))
            .expect("Cairo generation must use the native pipeline");

        assert_eq!(result.graph.nodes().count(), 18);
        assert!(
            result.graph.edges().count() > 0,
            "Cairo generation must build graph edges"
        );
    }

    #[test]
    fn json_wire_config_accepts_cairo_tessellation() {
        let config: GenerateConfig = serde_json::from_str(
            r#"{
                "tessellation": { "kind": "cairo", "params": {} },
                "level_fields": [[[2, 1], [2, 3]]]
            }"#,
        )
        .expect("the Cairo wire tag must deserialize");

        assert!(matches!(config.tessellation.kind, TessellationKind::Cairo));
        run_from_config(710, &config).expect("a deserialized Cairo config must run");
    }

    #[test]
    fn generation_dispatches_cairo_multi_level() {
        let points: Vec<[i32; 2]> = CairoTessellation::rect(2, 1)
            .into_iter()
            .map(|p| [p.x, p.y])
            .collect();
        let result = run_from_config(710, &cairo_config(vec![points.clone(), points]))
            .expect("multi-level Cairo generation must succeed");

        assert_eq!(result.graph.nodes().count(), 8);
    }

    /// GitHub issue #715: the final Cairo regression fixture deliberately uses a translated,
    /// non-rectangular point set on two floors.  This is the closest native equivalent of the
    /// browser's custom-field flow: the same wire coordinates go through dispatch, generation,
    /// and the post-generation pipeline, twice with the same seed.
    #[test]
    fn generation_is_deterministic_for_negative_custom_cairo_points_on_multiple_floors() {
        let mut points: Vec<[i32; 2]> = CairoTessellation::rect(3, 2)
            .into_iter()
            .map(|p| [p.x - 12, p.y - 12])
            .collect();
        // Make the field genuinely custom rather than a complete cairo_rect: remove one cell
        // while keeping the remaining shape connected.
        points.remove(2);
        assert!(points.iter().all(|[x, y]| *x < 0 && *y < 0));
        assert!(
            points
                .iter()
                .all(|[x, y]| CairoTessellation::is_valid_cell(CairoPoint::new(*x, *y)))
        );

        let config = cairo_config(vec![points.clone(), points]);
        let first = run_from_config(715, &config).expect("custom multi-floor Cairo must run");
        let second = run_from_config(715, &config).expect("the same Cairo seed must run again");

        assert_eq!(first.graph.nodes().count(), 2 * 11);
        assert!(first.graph.edges().count() > 0);
        assert_eq!(first.start, second.start);
        assert_eq!(first.finish, second.finish);

        let mut first_edges: Vec<_> = first
            .graph
            .edges()
            .map(|edge| (edge.from, edge.to, edge.kind))
            .collect();
        let mut second_edges: Vec<_> = second
            .graph
            .edges()
            .map(|edge| (edge.from, edge.to, edge.kind))
            .collect();
        first_edges.sort_unstable();
        second_edges.sort_unstable();
        assert_eq!(first_edges, second_edges);
    }

    #[test]
    fn generation_rejects_empty_and_invalid_cairo_fields() {
        let empty = match run_from_config(710, &cairo_config(vec![vec![]])) {
            Err(error) => error,
            Ok(_) => panic!("empty Cairo fields must be rejected"),
        };
        assert!(empty.contains("level_fields[0] must not be empty"));

        let invalid = match run_from_config(710, &cairo_config(vec![vec![[0, 0]]])) {
            Err(error) => error,
            Ok(_) => panic!("invalid Cairo points must be rejected"),
        };
        assert!(invalid.contains("field contains an invalid cell"));
    }
}
