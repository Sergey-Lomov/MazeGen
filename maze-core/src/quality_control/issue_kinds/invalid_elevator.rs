use crate::ids::NodeId;
use crate::quality_control::issue::{
    INVALID_ELEVATOR, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use std::collections::HashMap;

/// One elevator's full stop-node set, canonicalized (sorted) on construction so two
/// `ElevatorNodes` built from the same node set in different orders compare/hash equal — mirrors
/// `SplitTileNodes` exactly, see that type's doc comment for the rationale (`Ord`/`Hash` needed
/// for dedup keying).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ElevatorNodes(pub Vec<NodeId>);

impl ElevatorNodes {
    pub fn new(mut nodes: Vec<NodeId>) -> Self {
        nodes.sort_unstable();
        Self(nodes)
    }
}

/// Produced by any check that flags a whole elevator (its full stop-node set) invalid for a
/// check-specific reason — currently `ElevatorStopCountCheck`/`ElevatorSpanCheck`. See GitHub
/// issue #397. `invalid` holds one `ElevatorNodes` per flagged elevator — mirrors
/// `InvalidSplitTileIssue`'s "whole entity is the unit" shape (GitHub issue #260): an elevator is
/// the natural entity here, not any one of its individual stop nodes or fan edges. **Mandatory**
/// for this kind, see `RemoveElevatorStrategy`/`ReplaceElevatorWithPassagesStrategy`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidElevatorIssue {
    meta: IssueMeta,
    pub invalid: Vec<ElevatorNodes>,
    /// Per-elevator check provenance, keyed by the elevator's own `ElevatorNodes` (canonicalized,
    /// so two checks flagging the same elevator attribute to the same key) — mirrors
    /// `InvalidSplitTileIssue::invalid_sources`.
    pub invalid_sources: HashMap<ElevatorNodes, Vec<String>>,
}

impl InvalidElevatorIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<ElevatorNodes>) -> Self {
        let invalid_sources = invalid
            .iter()
            .map(|e| (e.clone(), vec![source_check.to_string()]))
            .collect();
        Self {
            meta: IssueMeta::new_from_check(source_check),
            invalid,
            invalid_sources,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidElevatorIssue {
    const KIND: IssueKind = INVALID_ELEVATOR;
}

impl IssueRequirement for InvalidElevatorIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidElevatorIssue);

impl IssueMerge for InvalidElevatorIssue {
    /// `ElevatorNodes` isn't `Copy` (it wraps a `Vec`), so this can't reuse `merge_id_sets` —
    /// dedup-union by clone, mirroring `InvalidSplitTileIssue::merge`'s own clone-based-key
    /// approach.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);

        let mut seen: std::collections::HashSet<ElevatorNodes> =
            self.invalid.iter().cloned().collect();
        for elevator in other.invalid {
            if seen.insert(elevator.clone()) {
                self.invalid.push(elevator);
            }
        }
        for (key, sources) in other.invalid_sources {
            let entry = self.invalid_sources.entry(key).or_default();
            for source in sources {
                if !entry.contains(&source) {
                    entry.push(source);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn elevator(nodes: Vec<NodeId>) -> ElevatorNodes {
        ElevatorNodes::new(nodes)
    }

    #[test]
    fn merge_unions_disjoint_elevators() {
        let mut a = InvalidElevatorIssue::new_from_check(
            "elevator_stop_count_a",
            vec![elevator(vec![0, 1])],
        );
        let b = InvalidElevatorIssue::new_from_check(
            "elevator_stop_count_b",
            vec![elevator(vec![2, 3])],
        );
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&elevator(vec![0, 1])));
        assert!(a.invalid.contains(&elevator(vec![2, 3])));
    }

    #[test]
    fn merge_deduplicates_shared_elevator() {
        let mut a = InvalidElevatorIssue::new_from_check(
            "elevator_stop_count_a",
            vec![elevator(vec![0, 1])],
        );
        let b = InvalidElevatorIssue::new_from_check(
            "elevator_stop_count_b",
            vec![elevator(vec![0, 1])],
        );
        a.merge(b);

        assert_eq!(
            a.invalid,
            vec![elevator(vec![0, 1])],
            "the same elevator flagged by both checks must not be duplicated"
        );
    }

    #[test]
    fn merge_attributes_each_elevator_to_only_its_own_flagging_check() {
        let mut a = InvalidElevatorIssue::new_from_check(
            "elevator_stop_count_a",
            vec![elevator(vec![0, 1])],
        );
        let b = InvalidElevatorIssue::new_from_check("elevator_span_b", vec![elevator(vec![2, 3])]);
        a.merge(b);

        assert_eq!(
            a.invalid_sources.get(&elevator(vec![0, 1])),
            Some(&vec!["elevator_stop_count_a".to_string()])
        );
        assert_eq!(
            a.invalid_sources.get(&elevator(vec![2, 3])),
            Some(&vec!["elevator_span_b".to_string()])
        );
    }

    #[test]
    fn canonicalizes_node_order() {
        assert_eq!(elevator(vec![3, 1, 2]), elevator(vec![1, 2, 3]));
    }
}
