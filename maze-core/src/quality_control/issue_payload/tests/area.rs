use super::*;

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
        TeleportDirectionFilter, TeleportFloorKindFilter, VerticalPassageType,
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
        direction: TeleportDirectionFilter::Any,
        floor_kind: TeleportFloorKindFilter::Any,
    });
    assert_agrees::<SquareTessellation, _>(&MaxTeleportDensityCheck {
        instance_id: "t".into(),
        max_density: 1.0,
        direction: TeleportDirectionFilter::Any,
        floor_kind: TeleportFloorKindFilter::Any,
    });
    assert_agrees::<SquareTessellation, _>(&MaxOneWayCountCheck {
        instance_id: "t".into(),
        max_one_ways: 1,
    });
    assert_agrees::<SquareTessellation, _>(&MaxOneWayRatioCheck {
        instance_id: "t".into(),
        max_ratio: 1.0,
    });
    assert_agrees::<SquareTessellation, _>(&MaxVerticalPassageCountCheck {
        instance_id: "t".into(),
        max_vertical_passages: 1,
        passage_type: VerticalPassageType::Any,
    });
    assert_agrees::<SquareTessellation, _>(&MaxVerticalPassageRatioCheck {
        instance_id: "t".into(),
        max_ratio: 1.0,
        passage_type: VerticalPassageType::Any,
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
