use std::collections::HashMap;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::{RegionClass, ALL_REGION_CLASSES};
use crate::quality_control::issue::{Issue, REGION_NEEDS_EXPANSION};
use crate::quality_control::issue_data::IssueData;

/// Shared region-filtering/issue-building logic for `MinRegionSizeCheck` and
/// `MinRegionRatioCheck` — see GitHub issue #108. Each check owns only its threshold predicate
/// (`region.len() < min_region_size` vs. the ratio comparison), passed in via `undersized`, and
/// its detail key name (`min_region_size` vs `min_region_ratio`).
///
/// `region_classes`: SCC regions whose `RegionClass` (see `graph::region_class`) is not in this
/// list are ignored entirely — never flagged, never assigned for expansion repair. Empty means no
/// region matches (the check is always silent); all four classes means every region is checked,
/// same as before this filter existed — see GitHub issue #54.
pub fn find_invalid_regions<T: Tessellation>(
    maze: &Maze<T>,
    region_classes: &[RegionClass],
    undersized: impl Fn(usize) -> bool,
) -> Option<Vec<usize>> {
    if region_classes.is_empty() {
        return None;
    }
    let scc = maze.analysis.scc(&maze.graph);
    let classes = if region_classes.len() == ALL_REGION_CLASSES.len() {
        None
    } else {
        if maze.meta.start.is_none() || maze.meta.finish.is_none() {
            return None;
        }
        Some(maze.analysis.region_classes(&maze.graph, &maze.meta))
    };
    let invalid: Vec<usize> = scc.components.iter().enumerate()
        .filter(|(idx, region)| {
            undersized(region.len())
                && classes.as_ref().is_none_or(|c| c.get(idx).is_some_and(|class| region_classes.contains(class)))
        })
        .map(|(idx, _)| idx)
        .collect();
    if invalid.is_empty() {
        return None;
    }
    Some(invalid)
}

/// Builds the `RegionsNeedingExpansion` issue for a set of `invalid` region indices, including
/// the `region_classes` detail: the actual `RegionClass`es among the flagged regions (not the
/// full configured filter — a filter covering several classes may still have only one of them
/// actually undersized this pass), so the UI can name which region class is short instead of a
/// generic "region(s) below threshold". Needs `RegionClass`es recomputed even when the filter is
/// "all classes" (where detection's fast `None` path skips it) — falls back to no detail (generic
/// label) if start/finish aren't set yet, same as the `None`-filter case above already tolerates
/// for detection itself.
pub fn build_issue<T: Tessellation>(
    maze: &Maze<T>,
    invalid: Vec<usize>,
    instance_id: &str,
    detail_key: &'static str,
    threshold: impl ToString,
) -> Issue {
    let mut invalid_sources: HashMap<usize, Vec<String>> = HashMap::new();
    for &idx in &invalid {
        invalid_sources.entry(idx).or_default().push(instance_id.to_string());
    }

    let classes = (maze.meta.start.is_some() && maze.meta.finish.is_some())
        .then(|| maze.analysis.region_classes(&maze.graph, &maze.meta));

    if let Some(classes) = classes {
        let mut detail_classes: Vec<&'static str> = invalid.iter()
            .filter_map(|idx| classes.get(idx))
            .map(|c| c.as_str())
            .collect();
        detail_classes.sort_unstable();
        detail_classes.dedup();
        Issue::with_data_from_check(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid, invalid_sources }, instance_id)
            .with_detail(instance_id, detail_key, threshold.to_string())
            .with_detail(instance_id, "region_classes", detail_classes.join(","))
    } else {
        Issue::with_data_from_check(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid, invalid_sources }, instance_id)
            .with_detail(instance_id, detail_key, threshold.to_string())
    }
}
