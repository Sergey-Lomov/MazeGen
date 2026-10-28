use crate::ids::NodeId;
use std::cell::RefCell;
use std::collections::BTreeMap;

/// Why a geometric-QC pair could not be decided (`Specs/topology.md`, "Consumer policy for
/// `Unknown` / `Unsupported`").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndeterminateReason {
    /// An active topological-only fold: `DistanceError::Unsupported`.
    UnsupportedTopology,
    /// The distance bracket straddles the threshold: `WithinLimit::Unknown`.
    DistanceUnknown,
}

/// One undecided pair, located by a representative maze node of each side (`a <= b`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UndecidedPair {
    pub a: NodeId,
    pub b: NodeId,
    pub reason: IndeterminateReason,
}

/// Collects geometric-QC pairs whose surface distance could not be decided (GitHub issue #838, see
/// `Specs/topology.md`, "Consumer policy for `Unknown` / `Unsupported`"). A `Check<T, I>` can only
/// produce its own issue type, so a check records an undecidable pair here instead of flagging or
/// clearing it, and `QualityControlEngine::collect_final_report` turns the collected pairs into
/// one `IndeterminateDistanceIssue`. A pair is kept once whichever side it is visited from.
/// Interior-mutable because checks only see `&Maze`.
#[derive(Debug, Default)]
pub struct DistanceDiagnostics {
    pairs: RefCell<BTreeMap<(NodeId, NodeId), IndeterminateReason>>,
}

impl DistanceDiagnostics {
    /// Records the undecided pair `(a, b)`; the first reason recorded for a pair wins.
    pub fn record(&self, a: NodeId, b: NodeId, reason: IndeterminateReason) {
        self.pairs
            .borrow_mut()
            .entry((a.min(b), a.max(b)))
            .or_insert(reason);
    }

    /// Returns the collected pairs (ordered by node ids) and resets the collection.
    pub fn take(&self) -> Vec<UndecidedPair> {
        std::mem::take(&mut *self.pairs.borrow_mut())
            .into_iter()
            .map(|((a, b), reason)| UndecidedPair { a, b, reason })
            .collect()
    }

    pub fn clear(&self) {
        self.pairs.borrow_mut().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pair_is_kept_once_whichever_side_records_it() {
        let d = DistanceDiagnostics::default();
        d.record(7, 3, IndeterminateReason::DistanceUnknown);
        d.record(3, 7, IndeterminateReason::UnsupportedTopology);
        d.record(1, 2, IndeterminateReason::UnsupportedTopology);
        let pairs = d.take();
        assert_eq!(
            pairs,
            vec![
                UndecidedPair {
                    a: 1,
                    b: 2,
                    reason: IndeterminateReason::UnsupportedTopology
                },
                UndecidedPair {
                    a: 3,
                    b: 7,
                    reason: IndeterminateReason::DistanceUnknown
                },
            ]
        );
        assert!(d.take().is_empty());
    }

    #[test]
    fn clear_drops_recorded_pairs() {
        let d = DistanceDiagnostics::default();
        d.record(1, 2, IndeterminateReason::UnsupportedTopology);
        d.clear();
        assert!(d.take().is_empty());
    }
}
