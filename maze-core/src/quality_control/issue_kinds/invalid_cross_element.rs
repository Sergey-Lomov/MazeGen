use crate::ids::NodeId;
use crate::quality_control::cross_element::CrossElement;
use crate::quality_control::issue::{
    INVALID_CROSS_ELEMENT, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use std::collections::HashMap;

/// One element occurrence sitting on a cell of a forbidden cell type — GitHub issue #824.
/// `node` is the occurrence's node (an element with several ends, e.g. a teleport, yields one
/// violation per offending end) and `cell_type` is the key of the type of the cell it sits on
/// (`Tessellation::cell_type_key_of`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CrossElementCellViolation {
    pub element: CrossElement,
    pub node: NodeId,
    pub cell_type: &'static str,
}

/// Produced by `CrossElementCellTypeCheck`: elements of the selected kinds placed on cells of a
/// forbidden cell type. Unlike `InvalidCrossElementGroupIssue`, each flagged element is invalid on
/// its own (no pair, no `to_remove`). Repaired by `CrossElementRemoveStrategy`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidCrossElementIssue {
    meta: IssueMeta,
    pub violations: Vec<CrossElementCellViolation>,
    /// Per-element check provenance, so a merged issue can attribute each flagged element back to
    /// the check instance(s) that flagged it (same role as `InvalidTeleportIssue.invalid_sources`).
    pub invalid_sources: HashMap<CrossElement, Vec<String>>,
}

impl InvalidCrossElementIssue {
    pub fn new_from_check(source_check: &str, violations: Vec<CrossElementCellViolation>) -> Self {
        let mut invalid_sources: HashMap<CrossElement, Vec<String>> = HashMap::new();
        for violation in &violations {
            invalid_sources
                .entry(violation.element.clone())
                .or_insert_with(|| vec![source_check.to_string()]);
        }
        Self {
            meta: IssueMeta::new_from_check(source_check),
            violations,
            invalid_sources,
        }
    }

    /// Removal request for one `element`, built by a group strategy that delegates the removal to
    /// the nested `INVALID_CROSS_ELEMENT` strategy (GitHub issue #1060). Carries no violations — the
    /// element is named through `invalid_sources` only, which is all a removal needs.
    pub fn for_removal(source_check: &str, element: CrossElement) -> Self {
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(element, vec![source_check.to_string()]);
        Self {
            meta: IssueMeta::new_from_check(source_check),
            violations: Vec::new(),
            invalid_sources,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidCrossElementIssue {
    const KIND: IssueKind = INVALID_CROSS_ELEMENT;
}

impl IssueRequirement for InvalidCrossElementIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidCrossElementIssue);

impl IssueMerge for InvalidCrossElementIssue {
    /// Dedup-unions violations (same element on the same node is one violation) and unions
    /// `invalid_sources` per element, deduplicating per check id.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        for violation in other.violations {
            if !self.violations.contains(&violation) {
                self.violations.push(violation);
            }
        }
        for (element, sources) in other.invalid_sources {
            let entry = self.invalid_sources.entry(element).or_default();
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

    fn violation(element: CrossElement, node: NodeId) -> CrossElementCellViolation {
        CrossElementCellViolation {
            element,
            node,
            cell_type: "triangle",
        }
    }

    #[test]
    fn for_removal_names_only_the_element_through_invalid_sources() {
        let issue = InvalidCrossElementIssue::for_removal("r:a", CrossElement::Finish(2));
        assert!(issue.violations.is_empty());
        assert_eq!(issue.invalid_sources.len(), 1);
        assert_eq!(
            issue.invalid_sources[&CrossElement::Finish(2)],
            vec!["r:a".to_string()]
        );
    }

    #[test]
    fn merge_dedups_violations_and_unions_sources_per_element() {
        let mut a = InvalidCrossElementIssue::new_from_check(
            "r:a",
            vec![violation(CrossElement::Start(1), 1)],
        );
        let b = InvalidCrossElementIssue::new_from_check(
            "r:b",
            vec![
                violation(CrossElement::Start(1), 1),
                violation(CrossElement::Finish(2), 2),
            ],
        );
        a.merge(b);

        assert_eq!(a.violations.len(), 2);
        assert_eq!(
            a.invalid_sources[&CrossElement::Start(1)],
            vec!["r:a".to_string(), "r:b".to_string()]
        );
        assert_eq!(
            a.invalid_sources[&CrossElement::Finish(2)],
            vec!["r:b".to_string()]
        );
    }
}
