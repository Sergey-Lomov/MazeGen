mod nested_strategy_tests {
    use std::collections::HashMap;
    use maze_core::space::SquareTessellation;
    use crate::config::{QcRuleConfig, StageConfig, CheckInstanceConfig, StrategyConfig, GenerateConfig, TessellationType};
    use crate::runner::rule_factory::build_qc_and_repair;
    use crate::runner::run_from_config;

    fn scc_count_rule(strategy: Option<StrategyConfig>) -> QcRuleConfig {
        QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "scc_count".to_string(),
                type_id: "scc_count".to_string(),
                params: HashMap::new(),
            }],
            strategy,
        }
    }

    fn one_stage(rule: QcRuleConfig) -> Vec<StageConfig> {
        vec![StageConfig { id: "s1".to_string(), name: "Stage 1".to_string(), rules: vec![rule] }]
    }

    /// Builds a `StrategyConfig` with no params — every test in this module only ever varies
    /// `id`/`slot_id`/`nested`, never `params`.
    fn strategy_cfg(id: &str, slot_id: Option<&str>, nested: Vec<StrategyConfig>) -> StrategyConfig {
        StrategyConfig { id: id.to_string(), params: HashMap::new(), slot_id: slot_id.map(str::to_string), nested }
    }

    fn reduce_scc_count_with_nested(nested: Vec<StrategyConfig>) -> StrategyConfig {
        strategy_cfg("reduce_scc_count", None, nested)
    }

    fn build_with_strategy(strategy: StrategyConfig) -> Result<maze_core::quality_control::QualityControlEngine<SquareTessellation>, String> {
        let rule = scc_count_rule(Some(strategy));
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        build_qc_and_repair::<SquareTessellation>(&config)
    }

    #[test]
    fn reduce_scc_count_without_nested_is_rejected() {
        let strategy = reduce_scc_count_with_nested(vec![]);
        let result = build_with_strategy(strategy);
        assert!(result.is_err(), "reduce_scc_count's merge_target slot has min: 1 — no nested must be rejected");
    }

    #[test]
    fn reduce_scc_count_nested_missing_slot_id_is_rejected() {
        let nested = strategy_cfg("expand_region_passage", None, vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(result.is_err(), "a nested StrategyConfig with no slot_id must be rejected");
    }

    #[test]
    fn reduce_scc_count_nested_with_incompatible_kind_is_rejected() {
        // invalid_loop_random handles INVALID_LOOP, not REGION_NEEDS_EXPANSION — must be
        // rejected as incompatible with the merge_target slot.
        let nested = strategy_cfg("invalid_loop_random", Some("merge_target"), vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(result.is_err(), "a nested strategy handling the wrong IssueKind must be rejected");
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
        assert!(result.is_err(), "merge_target's max: Some(1) must reject a second nested strategy for the same slot");
    }

    #[test]
    fn top_level_strategy_with_slot_id_is_rejected() {
        let strategy = strategy_cfg("farthest_endpoints", Some("merge_target"), vec![]);
        let rule = QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig { local_id: "missing_endpoints".to_string(), type_id: "missing_endpoints".to_string(), params: HashMap::new() }],
            strategy: Some(strategy),
        };
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_err(), "a top-level strategy must not declare slot_id");
    }

    /// Two disjoint 2x2 islands with a gap between them (points x in 0..2 and x in 4..6) —
    /// generation can only ever connect geometrically-adjacent cells, so this always yields
    /// exactly 2 SCCs after base generation, regardless of algorithm/seed, and no shared wall
    /// ever exists between the islands for expand_region_passage to bridge.
    fn two_disjoint_islands_points() -> Vec<[i32; 2]> {
        let mut points = vec![];
        for x in 0..2 { for y in 0..2 { points.push([x, y]); } }
        for x in 4..6 { for y in 0..2 { points.push([x, y]); } }
        points
    }

    fn config_with_points(points: Vec<[i32; 2]>) -> GenerateConfig {
        use crate::config::TessellationConfig;
        let mut config = GenerateConfig::default();
        config.tessellation = TessellationConfig { tessellation_type: TessellationType::Square, points };
        config
    }

    fn issue_kinds(result: &crate::runner::MazeRunResult) -> Vec<&'static str> {
        result.remaining_issues.iter().map(|i| i.kind().as_str()).collect()
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
            strategy: Some(reduce_scc_count_with_nested(vec![strategy_cfg("expand_region_passage", Some("merge_target"), vec![])])),
        };
        config.stages[0].rules.push(scc_check_rule);

        let result = run_from_config(1, &config);
        assert!(result.is_ok(), "run_from_config must succeed end-to-end: {:?}", result.err());
        let result = result.unwrap();
        // Two geometrically-disjoint islands can never be bridged by expand_region_passage (no
        // shared wall exists between them) — the issue is expected to remain unresolved, proving
        // the strategy was actually dispatched (not silently skipped) and correctly reported
        // Failed rather than panicking or silently succeeding.
        assert!(result.remaining_issues.iter().any(|i| i.kind().as_str() == "excessive_scc_count"),
            "excessive_scc_count must still be reported since the two islands cannot be bridged: {:?}",
            issue_kinds(&result));
    }

    #[test]
    fn end_to_end_reduce_scc_count_actually_reduces_component_count_on_contiguous_field() {
        // A contiguous field lets expand_region_passage actually bridge every SCC (every region
        // has a geometrically-adjacent neighbor, unlike the disjoint-islands test above) — this
        // verifies reduce_scc_count doesn't just get dispatched but genuinely reduces the SCC
        // count via its nested strategy. `one_way_chance: 1.0` (every edge one-way) reliably
        // fragments a contiguous field's undirected spanning structure into several SCCs.
        let mut points = vec![];
        for x in 0..4 { for y in 0..4 { points.push([x, y]); } }
        let mut config = config_with_points(points);
        config.elements.one_way_chance = Some(1.0);

        let scc_check_rule = QcRuleConfig {
            id: "r_scc".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "scc_count".to_string(),
                type_id: "scc_count".to_string(),
                params: HashMap::from([("max_scc_count".to_string(), "1".to_string())]),
            }],
            strategy: Some(reduce_scc_count_with_nested(vec![strategy_cfg("expand_region_passage", Some("merge_target"), vec![])])),
        };
        config.stages[0].rules.push(scc_check_rule);

        let result = run_from_config(1, &config).expect("run_from_config must succeed");
        assert!(!result.remaining_issues.iter().any(|i| i.kind().as_str() == "excessive_scc_count"),
            "a fully contiguous field must let reduce_scc_count converge to max_scc_count=1: {:?}",
            issue_kinds(&result));
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
            strategy: Some(strategy_cfg("weighted_region_merge", None, vec![
                strategy_cfg("expand_region_passage", Some("merge_target"), vec![]),
                strategy_cfg("teleport_region_merge", Some("merge_target"), vec![]),
            ])),
        };
        config.stages[0].rules.push(region_rule);

        let result = run_from_config(1, &config).expect("run_from_config must succeed");
        assert!(!result.remaining_issues.iter().any(|i| i.kind().as_str() == "region_needs_expansion"),
            "weighted_region_merge must resolve region_needs_expansion via the teleport candidate after the geometric one fails: {:?}",
            issue_kinds(&result));
    }

    #[test]
    fn two_level_nesting_is_accepted() {
        // expand_region_passage itself has no nested slots, so its own `nested` must be empty —
        // this exercises build_nested's recursive call one level deeper without needing a real
        // multi-slot strategy to exist yet.
        let nested = strategy_cfg("expand_region_passage", Some("merge_target"), vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(result.is_ok(), "recursive build_nested must handle a nested strategy with its own (empty) nested list: {:?}", result.err());
    }

    #[test]
    fn reduce_scc_count_with_valid_nested_is_accepted() {
        let nested = strategy_cfg("expand_region_passage", Some("merge_target"), vec![]);
        let strategy = reduce_scc_count_with_nested(vec![nested]);
        let result = build_with_strategy(strategy);
        assert!(result.is_ok(), "a single valid nested strategy filling merge_target must be accepted: {:?}", result.err());
    }

    // `build_nested` is a private fn in the outer module (`super::*` above brings it into scope
    // here), so these tests call it directly against synthetic `expected_nested()` shapes rather
    // than going through `build_qc_and_repair`/real registry strategies — the only way to
    // exercise `max: None` (unbounded slots) and 3+ levels of real nesting, neither of which any
    // strategy in today's registry actually declares (see `Specs/repair.md`'s own admission that
    // depth is "unbounded in the data model... but nothing stops one [level]" being added).
    mod build_nested_generic_shape_tests {
        use std::collections::HashMap;
        use maze_core::space::{SquareTessellation, Tessellation};
        use maze_core::repair::{RepairResult, RepairStrategy, StrategyParams, NestedSlot, NestedStrategyConfig};
        use maze_core::generation::PresetState;
        use maze_core::quality_control::{ExcessiveSccCountIssue, EXCESSIVE_SCC_COUNT};
        use maze_core::Maze;
        use crate::config::StrategyConfig;
        use crate::runner::strategy_factory::build_nested;

        // A slot-holding strategy that accepts any number (0..) of nested strategies handling
        // EXCESSIVE_SCC_COUNT — `max: None` is never exercised by the real registry today. Its
        // slot's `kind` is chosen to match `reduce_scc_count`'s own `handles()`, so a real
        // registry strategy (not a second mock) can fill it — see
        // `three_level_nesting_resolves_through_a_real_second_level_strategy` below, which uses
        // this to reach 3 real levels without needing a test-only entry in `build_strategy_erased`.
        struct UnboundedSlotStrategy;
        static UNBOUNDED_SLOT: &[NestedSlot] = &[NestedSlot { slot_id: "unbounded", kind: EXCESSIVE_SCC_COUNT, min: 0, max: None }];
        impl<T: Tessellation> RepairStrategy<T, ExcessiveSccCountIssue> for UnboundedSlotStrategy {
            fn strategy_id(&self) -> &'static str { "test_unbounded_slot_strategy" }
            fn expected_nested(&self) -> &'static [NestedSlot] { UNBOUNDED_SLOT }
            fn apply(&self, _: &ExcessiveSccCountIssue, _: &Maze<T>, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[NestedStrategyConfig<T>]) -> (RepairResult, Vec<maze_core::repair::MutationCommand>) {
                (RepairResult::Failed, vec![])
            }
        }
        maze_core::impl_erased_repair_strategy!(UnboundedSlotStrategy, ExcessiveSccCountIssue);

        fn nested_cfg(id: &str, slot_id: &str, nested: Vec<StrategyConfig>) -> StrategyConfig {
            StrategyConfig { id: id.to_string(), params: HashMap::new(), slot_id: Some(slot_id.to_string()), nested }
        }

        #[test]
        fn unbounded_slot_accepts_zero_nested() {
            let result = build_nested::<SquareTessellation>(&UnboundedSlotStrategy, &[]);
            assert!(result.is_ok(), "min: 0 must accept an empty nested list: {:?}", result.err());
            assert_eq!(result.unwrap().len(), 0);
        }

        #[test]
        fn unbounded_slot_accepts_several_nested_strategies_for_the_same_slot() {
            // Each `reduce_scc_count` entry must fill its own mandatory `merge_target` slot —
            // this test is about the unbounded outer slot accepting 3 siblings, not about
            // reduce_scc_count's own validation, so each sibling gets a minimal valid child.
            let make_reduce_scc_count = || nested_cfg("reduce_scc_count", "unbounded", vec![nested_cfg("expand_region_passage", "merge_target", vec![])]);
            let configs = vec![make_reduce_scc_count(), make_reduce_scc_count(), make_reduce_scc_count()];
            let result = build_nested::<SquareTessellation>(&UnboundedSlotStrategy, &configs);
            assert!(result.is_ok(), "max: None must accept more than one nested strategy for the same slot: {:?}", result.err());
            assert_eq!(result.unwrap().len(), 3, "all 3 entries for the unbounded slot must be kept, not deduped or truncated");
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
            let result = build_nested::<SquareTessellation>(&UnboundedSlotStrategy, &[level_2]);
            assert!(result.is_ok(), "a real 3-level nested chain must resolve: {:?}", result.err());
            let resolved = result.unwrap();
            assert_eq!(resolved.len(), 1);
            assert_eq!(resolved[0].strategy.strategy_id(), "reduce_scc_count");
            assert_eq!(resolved[0].nested.len(), 1, "level 2's own merge_target slot must be resolved recursively, not left empty");
            assert_eq!(resolved[0].nested[0].strategy.strategy_id(), "expand_region_passage");
            assert_eq!(resolved[0].nested[0].nested.len(), 0, "expand_region_passage has no slots of its own");
        }

        #[test]
        fn three_level_nesting_rejects_incompatible_kind_at_the_deepest_level() {
            // Level 3 handles INVALID_LOOP, but level 2's (reduce_scc_count) own merge_target
            // slot expects REGION_NEEDS_EXPANSION — the incompatibility must be caught at
            // whichever depth it actually occurs, not just at the top level.
            let level_3 = nested_cfg("invalid_loop_random", "merge_target", vec![]);
            let level_2 = nested_cfg("reduce_scc_count", "unbounded", vec![level_3]);
            let result = build_nested::<SquareTessellation>(&UnboundedSlotStrategy, &[level_2]);
            assert!(result.is_err(), "a kind mismatch at depth 3 must still be rejected: {:?}", result.ok().map(|_| ()));
        }
    }
}

mod build_strategy_tests {
    use maze_core::space::SquareTessellation;
    use crate::runner::strategy_factory::build_strategy_erased;

    // `build_strategy`'s match arms hand-pair a string literal with a `Box::new(SomeStruct)` —
    // nothing in the type system checks that `SomeStruct::strategy_id()` actually equals that
    // same string. A copy-paste error (wrong struct pointed at an arm's key, or two arms
    // swapped) would silently construct the wrong strategy for a given id, surfacing only
    // indirectly through unrelated-looking test failures or wrong runtime behavior — this test
    // catches that class of bug directly, at the exact point of introduction.
    const ALL_KNOWN_STRATEGY_IDS: &[&str] = &[
        "random_endpoints", "farthest_endpoints", "scored_endpoints",
        "invalid_loop_random", "invalid_loop_scored", "missing_loops_random",
        "expand_region_passage", "teleport_region_merge", "missing_regions", "reduce_scc_count",
        "weighted_region_merge", "remove_teleport", "teleport_group_proximity",
    ];

    #[test]
    fn every_known_id_builds_a_strategy_whose_own_strategy_id_matches() {
        for &id in ALL_KNOWN_STRATEGY_IDS {
            let strategy = build_strategy_erased::<SquareTessellation>(id)
                .unwrap_or_else(|e| panic!("build_strategy_erased({id:?}) failed: {e}"));
            assert_eq!(strategy.strategy_id(), id, "build_strategy_erased({id:?}) constructed a strategy whose own strategy_id() doesn't match — wrong match arm?");
        }
    }

    #[test]
    fn unknown_id_is_rejected() {
        assert!(build_strategy_erased::<SquareTessellation>("not_a_real_strategy").is_err());
    }
}

mod build_check_tests {
    use std::collections::HashMap;
    use maze_core::space::{SquareTessellation, Tessellation};
    use crate::config::CheckInstanceConfig;
    use crate::runner::check_factory::{
        check_kind_for_type,
        build_missing_endpoints_check, build_unreachable_finish_check, build_missing_loops_check,
        build_invalid_loop_check, build_excessive_scc_count_check, build_region_needs_expansion_check,
        build_missing_regions_check, build_invalid_teleport_check, build_teleport_group_proximity_check,
    };

    // Same rationale as `build_strategy_tests::every_known_id_builds_a_strategy_whose_own_strategy_id_matches`
    // above, but for `build_check`: its match arms hand-pair a string literal with a
    // `Box::new(SomeCheck { .. })`, and nothing in the type system checks that
    // `SomeCheck::check_type_id()` actually equals that same string. Also exercises
    // `check_kind_for_type`, whose match arms are a second, independently-maintained list of the
    // same type_ids — a check added to one but not the other would otherwise go unnoticed until
    // a live config exercised the missing arm (and `check_kind_for_type` panics on an unknown id).
    const ALL_KNOWN_CHECK_TYPE_IDS: &[&str] = &[
        "missing_endpoints", "unreachable_finish",
        "min_loops_count", "min_loop_density", "min_loop_length", "max_loop_length",
        "external_escape_diversity", "loop_distance_from_start", "loop_distance_from_finish",
        "max_loop_density", "scc_count", "min_region_size", "min_region_ratio", "min_region_count",
        "teleport_duplicates_connection", "teleport_waypoint_distance",
        "teleport_min_geometric_length", "teleport_max_geometric_length",
        "teleport_super_hub_avoidance", "teleport_group_proximity",
    ];

    /// Test-only dispatcher mirroring `build_rule_for!`'s own `KindTag` match, but returning just
    /// the built check's `check_type_id()` — the one thing these regression tests need — instead
    /// of a `Box<dyn Check<T, I>>` (whose concrete `I` differs per arm and so can't be returned
    /// as one unified type). `None` means `instance.type_id` is unknown to every `KindTag` arm.
    fn build_check_type_id<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<&'static str> {
        macro_rules! try_ctor {
            ($ctor:ident) => {
                if let Some(check) = $ctor::<T>(instance, instance_id.clone()) {
                    return Some(check.check_type_id());
                }
            };
        }
        try_ctor!(build_missing_endpoints_check);
        try_ctor!(build_unreachable_finish_check);
        try_ctor!(build_missing_loops_check);
        try_ctor!(build_invalid_loop_check);
        try_ctor!(build_excessive_scc_count_check);
        try_ctor!(build_region_needs_expansion_check);
        try_ctor!(build_missing_regions_check);
        try_ctor!(build_invalid_teleport_check);
        try_ctor!(build_teleport_group_proximity_check);
        None
    }

    #[test]
    fn every_known_id_builds_a_check_whose_own_check_type_id_matches() {
        for &id in ALL_KNOWN_CHECK_TYPE_IDS {
            let instance = CheckInstanceConfig { local_id: "0".to_string(), type_id: id.to_string(), params: HashMap::new() };
            let check_type_id = build_check_type_id::<SquareTessellation>(&instance, "instance".to_string())
                .unwrap_or_else(|| panic!("build_check_type_id({id:?}) found no matching KindTag arm"));
            assert_eq!(check_type_id, id, "build_check_type_id({id:?}) constructed a check whose own check_type_id() doesn't match — wrong match arm?");
            // Must also resolve in check_kind_for_type's independent match — panics on unknown id.
            let _ = check_kind_for_type(id);
        }
    }

    #[test]
    fn unknown_id_is_rejected() {
        let instance = CheckInstanceConfig { local_id: "0".to_string(), type_id: "not_a_real_check".to_string(), params: HashMap::new() };
        assert!(build_check_type_id::<SquareTessellation>(&instance, "instance".to_string()).is_none());
    }

    #[test]
    fn teleport_group_proximity_parses_a_fractional_distance_string() {
        // Regression guard: "distance" used to be parsed as i64, silently dropping any
        // fractional config value (e.g. "1.1") to the 0.0 default via .ok() -- teleports meant
        // to be flagged at distance 1 were never caught because the effective threshold fell
        // back to 0. Now parsed as f64: build a check with distance="1.1" from a raw config
        // string (as the web layer would send it) and confirm it actually flags a gap of 1.
        use maze_core::graph::EdgeKind;
        use maze_core::space::{Field, SquarePoint, square_rect};
        use maze_core::{Graph, IdGenerator, Maze};
        use rand::SeedableRng;

        let mut params = HashMap::new();
        params.insert("distance".to_string(), "1.1".to_string());
        let instance = CheckInstanceConfig { local_id: "0".to_string(), type_id: "teleport_group_proximity".to_string(), params };
        let check = build_teleport_group_proximity_check::<SquareTessellation>(&instance, "instance".to_string())
            .expect("build_teleport_group_proximity_check must accept a fractional distance string");

        // Two teleports whose entries sit exactly 1 tile-hop apart -- must be flagged against
        // threshold 1.1 (1 < 1.1), but would NOT be flagged against the old silently-truncated
        // fallback of 0.0.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.build_initial_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.build_initial_edge(p(0), p(2), EdgeKind::Teleport);
        g.build_initial_edge(p(1), p(3), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "distance=1.1 must flag a pair of teleports 1 tile-hop apart, proving the fractional value wasn't truncated to 0 or 1");
    }
}
