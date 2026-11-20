use crate::graph::node_shape::{NodeShape, NodeShapeLimits, TypedShape};
use crate::ids::NodeId;
use crate::quality_control::issue::{
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, VIOLATED_NODE_SHAPE_LIMITS,
};

/// Which side of its limit a shape is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitViolationKind {
    /// More nodes than `max`.
    Excess,
    /// Fewer nodes than `min`.
    Deficit,
}

/// One violated shape limit — see `Specs/node-shape-limits.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeLimitViolation {
    /// The violated shape and the cell type it belongs to.
    pub shape: TypedShape,
    pub kind: LimitViolationKind,
    /// How many nodes must leave (`Excess`) or join (`Deficit`) `shape`.
    pub amount: u32,
    /// The current nodes of `shape`, sorted.
    pub nodes: Vec<NodeId>,
    /// Shapes of the same cell type a node may be converted to (`Excess`) or from (`Deficit`),
    /// closest first.
    pub counterparts: Vec<NodeShape>,
}

/// Produced by `NodeShapeLimitsCheck` when the shape mix violates the configured limits — see
/// GitHub issue #1008. Carries everything a strategy needs without recounting: per violated shape
/// the excess or deficit, the shape's nodes and the ordered replacement candidates.
#[derive(Debug, Clone, PartialEq)]
pub struct ViolatedNodeShapeLimitsIssue {
    meta: IssueMeta,
    pub violations: Vec<ShapeLimitViolation>,
    /// The limits the check enforces, all of them (not only the violated ones): a strategy moving
    /// nodes between shapes must not break a limit that holds now. Empty when not supplied.
    pub limits: NodeShapeLimits,
}

impl ViolatedNodeShapeLimitsIssue {
    /// `limits` are every limit the check enforces — the repair judges a move against all of them.
    pub fn new_from_check(
        source_check: &str,
        violations: Vec<ShapeLimitViolation>,
        limits: NodeShapeLimits,
    ) -> Self {
        Self {
            meta: IssueMeta::new_from_check(source_check),
            violations,
            limits,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for ViolatedNodeShapeLimitsIssue {
    const KIND: IssueKind = VIOLATED_NODE_SHAPE_LIMITS;
}

impl IssueRequirement for ViolatedNodeShapeLimitsIssue {
    type Requirement = ();
}

crate::impl_issue!(ViolatedNodeShapeLimitsIssue);

impl IssueMerge for ViolatedNodeShapeLimitsIssue {
    /// Violations of the same `(shape, kind)` are unified: the larger `amount`, the union of
    /// `nodes`, and the counterparts in first-occurrence order without duplicates. Others append.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        self.limits.tighten(&other.limits);
        for incoming in other.violations {
            let Some(existing) = self
                .violations
                .iter_mut()
                .find(|i| i.shape == incoming.shape && i.kind == incoming.kind)
            else {
                self.violations.push(incoming);
                continue;
            };
            existing.amount = existing.amount.max(incoming.amount);
            existing.nodes.extend(incoming.nodes);
            existing.nodes.sort_unstable();
            existing.nodes.dedup();
            for shape in incoming.counterparts {
                if !existing.counterparts.contains(&shape) {
                    existing.counterparts.push(shape);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::Issue;

    fn violation(
        shape: NodeShape,
        kind: LimitViolationKind,
        amount: u32,
        nodes: Vec<NodeId>,
        counterparts: Vec<NodeShape>,
    ) -> ShapeLimitViolation {
        ShapeLimitViolation {
            shape: TypedShape::new("regular:4", shape),
            kind,
            amount,
            nodes,
            counterparts,
        }
    }

    #[test]
    fn merge_unifies_the_same_shape_and_kind() {
        let mut a = ViolatedNodeShapeLimitsIssue::new_from_check(
            "a",
            vec![violation(
                NodeShape::Straight,
                LimitViolationKind::Excess,
                2,
                vec![1, 3],
                vec![NodeShape::Turn(90)],
            )],
            NodeShapeLimits::new(),
        );
        let b = ViolatedNodeShapeLimitsIssue::new_from_check(
            "b",
            vec![violation(
                NodeShape::Straight,
                LimitViolationKind::Excess,
                4,
                vec![3, 2],
                vec![NodeShape::Turn(90), NodeShape::DeadEnd],
            )],
            NodeShapeLimits::new(),
        );
        a.merge(b);
        assert_eq!(
            a.violations,
            vec![violation(
                NodeShape::Straight,
                LimitViolationKind::Excess,
                4,
                vec![1, 2, 3],
                vec![NodeShape::Turn(90), NodeShape::DeadEnd],
            )]
        );
        assert_eq!(a.source_checks(), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn merge_tightens_the_limits() {
        use crate::graph::node_shape::CountRange;
        let range = |min, max| CountRange::new(min, max).unwrap();
        let mut a = ViolatedNodeShapeLimitsIssue::new_from_check(
            "a",
            vec![],
            NodeShapeLimits::new().with("regular:4", NodeShape::DeadEnd, range(Some(1), Some(9))),
        );
        let b = ViolatedNodeShapeLimitsIssue::new_from_check(
            "b",
            vec![],
            NodeShapeLimits::new().with("regular:4", NodeShape::DeadEnd, range(Some(3), Some(12))),
        );
        a.merge(b);
        let merged = a
            .limits
            .get(&TypedShape::new("regular:4", NodeShape::DeadEnd));
        assert_eq!((merged.min(), merged.max()), (Some(3), Some(9)));
    }

    #[test]
    fn merge_keeps_different_shapes_and_kinds_apart() {
        let mut a = ViolatedNodeShapeLimitsIssue::new_from_check(
            "a",
            vec![violation(
                NodeShape::Straight,
                LimitViolationKind::Excess,
                1,
                vec![1],
                vec![],
            )],
            NodeShapeLimits::new(),
        );
        let b = ViolatedNodeShapeLimitsIssue::new_from_check(
            "b",
            vec![
                violation(
                    NodeShape::Straight,
                    LimitViolationKind::Deficit,
                    1,
                    vec![1],
                    vec![],
                ),
                violation(
                    NodeShape::DeadEnd,
                    LimitViolationKind::Excess,
                    1,
                    vec![2],
                    vec![],
                ),
            ],
            NodeShapeLimits::new(),
        );
        a.merge(b);
        assert_eq!(a.violations.len(), 3);
    }
}
