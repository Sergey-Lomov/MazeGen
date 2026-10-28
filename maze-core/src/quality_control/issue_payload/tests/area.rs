use super::*;

// --- AreaDeficit resolver (hover-highlight follow-up to GitHub issue #408) — covers
// missing_vertical_passages/missing_teleports/missing_elevators/area_missing_elevator_stops, the
// four sibling RepairArea-shaped deficit issues that previously all fell through to
// IssuePayload::None. ---

/// A two-floor field with no nodes wired into any graph — these tests only need `field.levels_ordered()`
/// positions to resolve `RepairArea::Level`, not a real graph.
fn two_level_field() -> (
    MultiLevelField<crate::space::SquareTessellation>,
    crate::space::LevelId,
    crate::space::LevelId,
) {
    use crate::space::{Field, SquareTessellation, square_rect};
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new(Arc::default(), []);
    let bottom = mf.add_level(
        Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids).unwrap(),
    );
    let top = mf.add_level(
        Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids).unwrap(),
    );
    (mf, bottom, top)
}

#[test]
fn missing_vertical_passages_issue_resolves_whole_maze_and_level_entries_keyed_by_source_check() {
    let (field, bottom, top) = two_level_field();
    let (graph, scc) = empty_graph_and_scc();
    let issue = MissingVerticalPassagesIssue::new_from_check(
        "min_vertical_passage_count",
        vec![(RepairArea::WholeMaze, 2), (RepairArea::Level(top), 1)],
    );

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let_payload!(AreaDeficit { areas } = payload);
    assert_eq!(areas.len(), 1);
    let entries = &areas["min_vertical_passage_count"];
    assert_eq!(
        entries,
        &vec![None, Some(1)],
        "WholeMaze resolves to None, Level(top) resolves to its levels_ordered() index"
    );
    let _ = bottom; // only used to build the two-level field
}

#[test]
fn missing_teleports_issue_resolves_level_entry_to_its_levels_ordered_index() {
    let (field, bottom, _top) = two_level_field();
    let (graph, scc) = empty_graph_and_scc();
    let issue = MissingTeleportsIssue::new_from_check(
        "min_teleport_count",
        vec![(RepairArea::Level(bottom), 3)],
    );

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let_payload!(AreaDeficit { areas } = payload);
    assert_eq!(areas["min_teleport_count"], vec![Some(0)]);
}

#[test]
fn missing_elevators_issue_whole_maze_only_resolves_to_a_none_entry() {
    // GitHub issue #401's whole-maze-only scope — no specific floor to highlight, same
    // "no per-element highlight" precedent as ExcessiveSccCount, still routed through AreaDeficit.
    let (graph, scc) = empty_graph_and_scc();
    let issue = MissingElevatorsIssue::new_from_check(
        "min_elevator_count",
        vec![(RepairArea::WholeMaze, 4)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(AreaDeficit { areas } = payload);
    assert_eq!(areas["min_elevator_count"], vec![None]);
}

#[test]
fn area_missing_elevator_stops_issue_resolves_level_entry_to_its_levels_ordered_index() {
    let (field, _bottom, top) = two_level_field();
    let (graph, scc) = empty_graph_and_scc();
    let issue = AreaMissingElevatorStopsIssue::new_from_check(
        "min_elevator_stops_per_area_count",
        vec![(RepairArea::Level(top), 2)],
    );

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let_payload!(AreaDeficit { areas } = payload);
    assert_eq!(areas["min_elevator_stops_per_area_count"], vec![Some(1)]);
}

#[test]
fn area_deficit_fans_the_same_area_list_to_every_source_check() {
    // These four issue kinds don't track per-entry source-check attribution (unlike
    // InvalidLoopIssue's invalid_sources) -- merging two checks' issues must attribute the full
    // area list to both checks uniformly.
    use crate::quality_control::issue::IssueMerge;
    let (field, bottom, _top) = two_level_field();
    let (graph, scc) = empty_graph_and_scc();
    let mut issue = MissingTeleportsIssue::new_from_check(
        "min_teleport_count",
        vec![(RepairArea::Level(bottom), 2)],
    );
    issue.merge(MissingTeleportsIssue::new_from_check(
        "min_teleport_ratio",
        vec![(RepairArea::Level(bottom), 5)],
    ));

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let_payload!(AreaDeficit { areas } = payload);
    assert_eq!(areas.len(), 2);
    assert_eq!(areas["min_teleport_count"], vec![Some(0)]);
    assert_eq!(
        areas["min_teleport_ratio"],
        vec![Some(0)],
        "merge keeps the larger missing count but both checks still see the same area list"
    );
}

/// Pins every batch-edge-group check's own `Check::is_batch_edge_group()` against
/// `is_batch_edge_group_type`'s type-id-string match -- the two must agree, since
/// `resolve_edge_group_map` only ever has a type id string (not a live check instance) to work
/// with (see its doc comment). If a check overrides `is_batch_edge_group()` to `true` without
/// also adding its `check_type_id()` to `is_batch_edge_group_type`, or vice versa, this fails --
/// that's exactly the silent-drift failure mode GitHub issue #379 shipped once already.
#[test]
fn is_batch_edge_group_type_agrees_with_every_checks_own_is_batch_edge_group() {
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::{
        MaxOneWayCountCheck, MaxOneWayRatioCheck, MaxTeleportCountCheck, MaxTeleportDensityCheck,
        MaxVerticalPassageCountCheck, MaxVerticalPassageRatioCheck,
    };
    use crate::quality_control::{
        FloorScope, TeleportDirectionFilter, TeleportFloorKindFilter, VerticalPassageType,
    };

    fn assert_agrees<T: crate::space::Tessellation, I: crate::quality_control::IssueRequirement>(
        check: &dyn Check<T, I>,
    ) {
        assert_eq!(
            check.is_batch_edge_group(),
            is_batch_edge_group_type(check.check_type_id()),
            "'{}' disagrees between Check::is_batch_edge_group() and is_batch_edge_group_type()",
            check.check_type_id(),
        );
    }

    assert_agrees::<SquareTessellation, _>(&MaxTeleportCountCheck {
        instance_id: "t".into(),
        max_teleports: 1,
        floor_scope: FloorScope::WholeMaze,
        direction: TeleportDirectionFilter::Any,
        floor_kind: TeleportFloorKindFilter::Any,
    });
    assert_agrees::<SquareTessellation, _>(&MaxTeleportDensityCheck {
        instance_id: "t".into(),
        max_density: 1.0,
        floor_scope: FloorScope::WholeMaze,
        direction: TeleportDirectionFilter::Any,
        floor_kind: TeleportFloorKindFilter::Any,
    });
    assert_agrees::<SquareTessellation, _>(&MaxOneWayCountCheck {
        instance_id: "t".into(),
        max_one_ways: 1,
        floor_scope: FloorScope::WholeMaze,
    });
    assert_agrees::<SquareTessellation, _>(&MaxOneWayRatioCheck {
        instance_id: "t".into(),
        max_ratio: 1.0,
        floor_scope: FloorScope::WholeMaze,
    });
    assert_agrees::<SquareTessellation, _>(&MaxVerticalPassageCountCheck {
        instance_id: "t".into(),
        max_vertical_passages: 1,
        floor_scope: FloorScope::WholeMaze,
        passage_type: VerticalPassageType::Any,
        count_incoming: false,
    });
    assert_agrees::<SquareTessellation, _>(&MaxVerticalPassageRatioCheck {
        instance_id: "t".into(),
        max_ratio: 1.0,
        floor_scope: FloorScope::WholeMaze,
        passage_type: VerticalPassageType::Any,
        count_incoming: false,
    });
}

#[test]
fn indeterminate_distance_issue_resolves_each_pair_with_its_reason() {
    use crate::quality_control::{IndeterminateReason, UndecidedPair};
    let (graph, scc) = empty_graph_and_scc();
    let issue = IndeterminateDistanceIssue::new(vec![
        UndecidedPair {
            a: 1,
            b: 4,
            reason: IndeterminateReason::DistanceUnknown,
        },
        UndecidedPair {
            a: 2,
            b: 3,
            reason: IndeterminateReason::UnsupportedTopology,
        },
    ]);
    let payload = resolve(&issue, &graph, &scc);
    let_payload!(IndeterminateDistance { pairs } = payload);
    assert_eq!(
        pairs,
        vec![
            IssueUndecidedPairPayload {
                nodes: [1, 4],
                unsupported: false
            },
            IssueUndecidedPairPayload {
                nodes: [2, 3],
                unsupported: true
            },
        ]
    );
}
