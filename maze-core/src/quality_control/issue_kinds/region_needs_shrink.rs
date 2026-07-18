use std::collections::{HashMap, HashSet};
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, REGION_NEEDS_SHRINK};

/// Produced by any check that flags an SCC region as needing to be shrunk for a check-specific
/// reason (currently `MaxRegionSizeCheck`/`MaxRegionRatioCheck`) — see GitHub issue #177. Mirrors
/// `RegionNeedsExpansionIssue`'s shape exactly, but for the opposite direction (a region too large
/// rather than too small) — kept a distinct `Issue`/`IssueKind` rather than merged with
/// `RegionNeedsExpansionIssue` via `Comparison`, since "too small" and "too large" call for
/// different repair actions (grow vs. shrink), not just a different comparison operator on the
/// same action. `invalid` holds indices into `maze.analysis.scc(&maze.graph).components`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RegionNeedsShrinkIssue {
    meta: IssueMeta,
    pub invalid: Vec<usize>,
    /// Per-region check provenance, keyed by the same component index as `invalid` — see
    /// `RegionNeedsExpansionIssue::invalid_sources`' doc comment for why no remap is needed.
    pub invalid_sources: HashMap<usize, Vec<String>>,
}

impl RegionNeedsShrinkIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<usize>, invalid_sources: HashMap<usize, Vec<String>>) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), invalid, invalid_sources }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for RegionNeedsShrinkIssue {
    const KIND: IssueKind = REGION_NEEDS_SHRINK;
}

impl IssueRequirement for RegionNeedsShrinkIssue {
    type Requirement = ();
}

impl Issue for RegionNeedsShrinkIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
}

impl IssueMerge for RegionNeedsShrinkIssue {
    /// No index remapping needed — both sides' indices are into the same
    /// `maze.analysis.scc(&maze.graph)` cache entry for this QC pass, same as
    /// `RegionNeedsExpansionIssue::merge`.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        let seen: HashSet<usize> = self.invalid.iter().copied().collect();
        for idx in other.invalid {
            if !seen.contains(&idx) && !self.invalid.contains(&idx) {
                self.invalid.push(idx);
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

    fn issue(source_check: &str, invalid: Vec<usize>) -> RegionNeedsShrinkIssue {
        let mut invalid_sources: HashMap<usize, Vec<String>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(idx).or_default().push(source_check.to_string());
        }
        RegionNeedsShrinkIssue::new_from_check(source_check, invalid, invalid_sources)
    }

    #[test]
    fn merge_unions_disjoint_indices() {
        let mut a = issue("max_region_size", vec![0]);
        let b = issue("max_region_ratio", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&1));
    }

    #[test]
    fn merge_deduplicates_shared_index() {
        let mut a = issue("max_region_size", vec![0]);
        let b = issue("max_region_ratio", vec![0]);
        a.merge(b);

        assert_eq!(a.invalid, vec![0], "the same region index found by both checks must not be duplicated");
        let sources = a.invalid_sources.get(&0).expect("region 0 must have recorded sources");
        assert!(sources.contains(&"max_region_size".to_string()));
        assert!(sources.contains(&"max_region_ratio".to_string()));
    }
}
