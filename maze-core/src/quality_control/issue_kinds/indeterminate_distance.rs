use crate::quality_control::distance_diagnostics::{IndeterminateReason, UndecidedPair};
use crate::quality_control::issue::{
    INDETERMINATE_DISTANCE, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};

/// Raised by `QualityControlEngine` when a geometric-distance check could not decide some pairs
/// on a glued field (GitHub issue #838): `unknown` pairs have a distance bracket that straddles
/// the check's threshold, `unsupported` pairs lie on a floor with a topological-only fold. Such a
/// pair is neither flagged nor treated as passed. Not produced by any `Check<T, I>`, so it has no
/// source check; carries each undecided pair (a representative node per side) so the UI can point
/// at it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct IndeterminateDistanceIssue {
    meta: IssueMeta,
    pub pairs: Vec<UndecidedPair>,
}

impl IndeterminateDistanceIssue {
    pub fn new(pairs: Vec<UndecidedPair>) -> Self {
        Self {
            meta: IssueMeta::new(),
            pairs,
        }
    }

    pub fn unsupported(&self) -> usize {
        self.count(IndeterminateReason::UnsupportedTopology)
    }

    pub fn unknown(&self) -> usize {
        self.count(IndeterminateReason::DistanceUnknown)
    }

    fn count(&self, reason: IndeterminateReason) -> usize {
        self.pairs.iter().filter(|p| p.reason == reason).count()
    }
}

impl IssueKindConst for IndeterminateDistanceIssue {
    const KIND: IssueKind = INDETERMINATE_DISTANCE;
}

impl IssueRequirement for IndeterminateDistanceIssue {
    type Requirement = ();
}

crate::impl_issue!(IndeterminateDistanceIssue);

impl IssueMerge for IndeterminateDistanceIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        for pair in other.pairs {
            if !self.pairs.iter().any(|p| (p.a, p.b) == (pair.a, pair.b)) {
                self.pairs.push(pair);
            }
        }
    }
}
