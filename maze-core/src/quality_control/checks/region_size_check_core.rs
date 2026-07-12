use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::{RegionClass, ALL_REGION_CLASSES};
use crate::quality_control::{RegionNeedsExpansionIssue, RegionNeedsExpansionRequirement};

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

/// Attaches the `region_classes` detail: the actual `RegionClass`es among `invalid` (not the full
/// configured filter — a filter covering several classes may still have only one of them actually
/// undersized this pass), so the UI can name which region class is short instead of a generic
/// "region(s) below threshold". Needs `RegionClass`es recomputed even when the filter is "all
/// classes" (where detection's fast `None` path skips it) — falls back to no detail (generic
/// label) if start/finish aren't set yet, same as the `None`-filter case above already tolerates
/// for detection itself.
fn region_classes_detail<T: Tessellation>(maze: &Maze<T>, invalid: &[usize]) -> Option<String> {
    if maze.meta.start.is_none() || maze.meta.finish.is_none() {
        return None;
    }
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let mut detail_classes: Vec<&'static str> = invalid.iter()
        .filter_map(|idx| classes.get(idx))
        .map(|c| c.as_str())
        .collect();
    detail_classes.sort_unstable();
    detail_classes.dedup();
    Some(detail_classes.join(","))
}

/// Builds one `RegionNeedsExpansionIssue` for the repair path — `region_id`/`region` are always
/// `invalid[0]` (resolved to a sorted `NodeId` list regardless of `requirement`, since `region` is
/// needed for `PartialEq`/no-progress comparison independent of what a strategy asked for — see
/// `RegionNeedsExpansionIssue`'s doc comment). `other_invalid` is resolved from `invalid[1..]` only
/// if `requirement` asks for it (see GitHub issue #99/#105).
pub fn build_repair_issue<T: Tessellation>(
    maze: &Maze<T>,
    invalid: &[usize],
    instance_id: &str,
    detail_key: &'static str,
    threshold: impl ToString,
    requirement: RegionNeedsExpansionRequirement,
) -> RegionNeedsExpansionIssue {
    let scc = maze.analysis.scc(&maze.graph);
    let region_id = invalid[0];
    let mut region = scc.components[region_id].clone();
    region.sort_unstable();

    let other_invalid = if requirement.contains(RegionNeedsExpansionRequirement::OTHER_INVALID) {
        invalid[1..].to_vec()
    } else {
        Vec::new()
    };

    let issue = RegionNeedsExpansionIssue::new_from_check(instance_id, region_id, region, other_invalid)
        .with_detail(instance_id, detail_key, threshold.to_string());

    if let Some(detail) = region_classes_detail(maze, invalid) {
        issue.with_detail(instance_id, "region_classes", detail)
    } else {
        issue
    }
}

/// Builds one `RegionNeedsExpansionIssue` per entry in `invalid`, for the report path (see GitHub
/// issue #99/#102) — no `other_invalid`, since a report-path issue is never dispatched to a repair
/// strategy.
pub fn build_report_issues<T: Tessellation>(
    maze: &Maze<T>,
    invalid: &[usize],
    instance_id: &str,
    detail_key: &'static str,
    threshold: impl ToString + Clone,
) -> Vec<RegionNeedsExpansionIssue> {
    let scc = maze.analysis.scc(&maze.graph);
    let detail = region_classes_detail(maze, invalid);
    invalid.iter().map(|&region_id| {
        let mut region = scc.components[region_id].clone();
        region.sort_unstable();
        let issue = RegionNeedsExpansionIssue::new_from_check(instance_id, region_id, region, Vec::new())
            .with_detail(instance_id, detail_key, threshold.clone().to_string());
        if let Some(detail) = &detail {
            issue.with_detail(instance_id, "region_classes", detail.clone())
        } else {
            issue
        }
    }).collect()
}
