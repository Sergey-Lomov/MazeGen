use std::collections::HashMap;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::{RegionClass, ALL_REGION_CLASSES};
use crate::quality_control::RegionNeedsShrinkIssue;

/// Shared region-filtering/issue-building logic for `MaxRegionSizeCheck` and `MaxRegionRatioCheck`
/// — see GitHub issue #177, mirrors `region_size_check_core`'s shape for the shrink direction.
/// Each check owns only its threshold predicate (`region.len() > max_region_size` vs. the ratio
/// comparison) and its detail key name, passed in via `oversized`.
pub fn find_oversized_regions<T: Tessellation>(
    maze: &Maze<T>,
    region_classes: &[RegionClass],
    oversized: impl Fn(usize) -> bool,
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
        Some(maze.analysis.region_classes(&maze.graph, &maze.field, &maze.meta))
    };
    let invalid: Vec<usize> = scc.components.iter().enumerate()
        .filter(|(idx, region)| {
            oversized(region.len())
                && classes.as_ref().is_none_or(|c| c.get(idx).is_some_and(|class| region_classes.contains(class)))
        })
        .map(|(idx, _)| idx)
        .collect();
    if invalid.is_empty() {
        return None;
    }
    Some(invalid)
}

/// Builds the `RegionNeedsShrinkIssue` for a set of `invalid` region indices, mirrors
/// `region_size_check_core::build_issue`'s `region_classes` detail behavior for the shrink
/// direction.
pub fn build_issue<T: Tessellation>(
    maze: &Maze<T>,
    invalid: Vec<usize>,
    instance_id: &str,
    detail_key: &'static str,
    threshold: impl ToString,
) -> RegionNeedsShrinkIssue {
    let mut invalid_sources: HashMap<usize, Vec<String>> = HashMap::new();
    for &idx in &invalid {
        invalid_sources.entry(idx).or_default().push(instance_id.to_string());
    }

    let classes = (maze.meta.start.is_some() && maze.meta.finish.is_some())
        .then(|| maze.analysis.region_classes(&maze.graph, &maze.field, &maze.meta));

    if let Some(classes) = classes {
        let mut detail_classes: Vec<&'static str> = invalid.iter()
            .filter_map(|idx| classes.get(idx))
            .map(|c| c.as_str())
            .collect();
        detail_classes.sort_unstable();
        detail_classes.dedup();
        RegionNeedsShrinkIssue::new_from_check(instance_id, invalid, invalid_sources)
            .with_detail(instance_id, detail_key, threshold.to_string())
            .with_detail(instance_id, "region_classes", detail_classes.join(","))
    } else {
        RegionNeedsShrinkIssue::new_from_check(instance_id, invalid, invalid_sources)
            .with_detail(instance_id, detail_key, threshold.to_string())
    }
}
