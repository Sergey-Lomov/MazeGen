use super::*;
use crate::graph::node_shape::{JunctionLayout, NodeShape, TypedShape};
use crate::quality_control::event::write_issue_payload;

fn violation(shape: NodeShape, kind: LimitViolationKind) -> ShapeLimitViolation {
    ShapeLimitViolation {
        shape: TypedShape::new("regular:4", shape),
        kind,
        amount: 2,
        nodes: vec![3, 1],
        counterparts: vec![
            NodeShape::Straight,
            NodeShape::Junction(JunctionLayout::from_ranks(6, &[0, 1, 3])),
        ],
    }
}

#[test]
fn violated_node_shape_limits_resolves_to_a_flat_keyed_payload() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = ViolatedNodeShapeLimitsIssue::new_from_check(
        "node_shape_limits",
        vec![
            violation(NodeShape::Turn(90), LimitViolationKind::Excess),
            violation(NodeShape::DeadEnd, LimitViolationKind::Deficit),
        ],
    );

    let_payload!(ViolatedNodeShapeLimits { violations } = resolve(&issue, &graph, &scc));
    assert_eq!(violations.len(), 2);
    assert_eq!(
        violations[0],
        IssueShapeLimitViolationPayload {
            cell_type: "regular:4".to_string(),
            shape: "turn_90".to_string(),
            kind: LimitViolationKind::Excess,
            amount: 2,
            nodes: vec![3, 1],
            counterparts: vec!["straight".to_string(), "junction_6_0-1-3".to_string()],
        }
    );
    assert_eq!(violations[1].shape, "dead_end");
    assert_eq!(violations[1].kind, LimitViolationKind::Deficit);
}

#[test]
fn violated_node_shape_limits_without_violations_has_no_payload() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = ViolatedNodeShapeLimitsIssue::new_from_check("node_shape_limits", Vec::new());
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn violated_node_shape_limits_wire_layout_matches_the_tag_17_reader() {
    let payload = IssuePayload::ViolatedNodeShapeLimits {
        violations: vec![IssueShapeLimitViolationPayload {
            cell_type: "regular:8".to_string(),
            shape: "straight".to_string(),
            kind: LimitViolationKind::Deficit,
            amount: 5,
            nodes: vec![7],
            counterparts: vec!["dead_end".to_string()],
        }],
    };
    let mut bytes = Vec::new();
    write_issue_payload(&mut bytes, &payload);

    let mut expected = vec![17];
    expected.extend(1u32.to_le_bytes());
    expected.extend(9u32.to_le_bytes());
    expected.extend(b"regular:8");
    expected.extend(8u32.to_le_bytes());
    expected.extend(b"straight");
    expected.push(1);
    expected.extend(5u32.to_le_bytes());
    expected.extend(1u32.to_le_bytes());
    expected.extend(7u32.to_le_bytes());
    expected.extend(1u32.to_le_bytes());
    expected.extend(8u32.to_le_bytes());
    expected.extend(b"dead_end");
    assert_eq!(bytes, expected);
}
