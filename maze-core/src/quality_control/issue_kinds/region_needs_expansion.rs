use std::collections::{HashMap, HashSet};
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, REGION_NEEDS_EXPANSION};

/// Produced by any check that flags an SCC region as needing expansion for a check-specific
/// reason (currently `MinRegionSizeCheck`/`MinRegionRatioCheck`; future checks may flag a region
/// for expansion for reasons unrelated to size). `invalid` holds indices into
/// `maze.analysis.scc(&maze.graph).components` — not a copy of the regions themselves, since that
/// computation is already cached there and a repair strategy can re-fetch it (cache hit) rather
/// than carry a duplicate snapshot.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RegionNeedsExpansionIssue {
    meta: IssueMeta,
    pub invalid: Vec<usize>,
    /// Per-region check provenance, keyed by the same component index as `invalid` — stable
    /// within one QC pass because every check sharing this issue reads from the same single
    /// `maze.analysis.scc(&maze.graph)` cache entry, unlike cycle indices (which get remapped on
    /// merge because cycle enumeration has no equivalent stable identity).
    pub invalid_sources: HashMap<usize, Vec<String>>,
}

impl RegionNeedsExpansionIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<usize>, invalid_sources: HashMap<usize, Vec<String>>) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), invalid, invalid_sources }
    }

    /// For synthetic issues built by a parent `RepairStrategy` (e.g. `ReduceSccCountStrategy`)
    /// for a nested-strategy call — no source check.
    pub fn synthetic(invalid: Vec<usize>) -> Self {
        Self { meta: IssueMeta::new(), invalid, invalid_sources: HashMap::new() }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for RegionNeedsExpansionIssue {
    const KIND: IssueKind = REGION_NEEDS_EXPANSION;
}

impl IssueRequirement for RegionNeedsExpansionIssue {
    type Requirement = ();
}

impl Issue for RegionNeedsExpansionIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

impl IssueMerge for RegionNeedsExpansionIssue {
    /// Unlike `InvalidLoopIssue`, no index remapping is needed: both sides' indices are into the
    /// same `maze.analysis.scc(&maze.graph)` cache entry for this QC pass, so a given component
    /// index means the same region on both sides.
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

    fn issue(source_check: &str, invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
        let mut invalid_sources: HashMap<usize, Vec<String>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(idx).or_default().push(source_check.to_string());
        }
        RegionNeedsExpansionIssue::new_from_check(source_check, invalid, invalid_sources)
    }

    #[test]
    fn merge_unions_disjoint_indices() {
        let mut a = issue("min_region_size", vec![0]);
        let b = issue("min_region_ratio", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&1));
    }

    #[test]
    fn merge_deduplicates_shared_index() {
        let mut a = issue("min_region_size", vec![0]);
        let b = issue("min_region_ratio", vec![0]);
        a.merge(b);

        assert_eq!(a.invalid, vec![0], "the same region index found by both checks must not be duplicated");
        let sources = a.invalid_sources.get(&0).expect("region 0 must have recorded sources");
        assert!(sources.contains(&"min_region_size".to_string()));
        assert!(sources.contains(&"min_region_ratio".to_string()));
    }
}
