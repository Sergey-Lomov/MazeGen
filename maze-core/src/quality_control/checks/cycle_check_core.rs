use crate::Maze;
use crate::graph::cycles::{find_deduped_simple_cycles, resolve_to_edge_ids};
use crate::graph::nav::NavGraph;
use crate::ids::EdgeId;
use crate::quality_control::issue_kinds::canonical_cycle_key;
use crate::quality_control::{CycleKind, InvalidLoopIssue, InvalidLoopRequirement};
use crate::space::Tessellation;
use std::collections::HashMap;

/// Shared cycle-enumeration/issue-building skeleton for the loop-based checks
/// (`MinLoopLengthCheck`, `MaxLoopLengthCheck`, `LoopDistanceFromStartCheck`,
/// `LoopDistanceFromFinishCheck`, `ExternalEscapeDiversityCheck`) — see GitHub issue #107. Each
/// check owns only its predicate (what makes a cycle invalid) and its detail key/value.
///
/// Builds the nav graph, enumerates simple cycles, restricts them to `cycle_kind` (GitHub issue
/// #217 — `CycleKind::Any` reproduces the pre-#217 behavior of considering every cycle), and
/// applies `invalid` to each of the surviving cycles — silently skipping (returning `None`) if
/// enumeration overflows (see `CycleSearchResult::TooManyCycles`, issue #22) or no cycle is
/// flagged.
pub fn find_invalid_cycles<T: Tessellation>(
    maze: &Maze<T>,
    cycle_kind: CycleKind,
    invalid: impl Fn(&NavGraph, &[usize]) -> bool,
) -> Option<(NavGraph, Vec<Vec<usize>>, Vec<usize>)> {
    let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let cycles = find_deduped_simple_cycles(&nav)?;

    let flagged: Vec<usize> = cycles
        .iter()
        .enumerate()
        .filter(|(_, cycle)| cycle_kind.matches(&nav, cycle) && invalid(&nav, cycle))
        .map(|(idx, _)| idx)
        .collect();
    if flagged.is_empty() {
        return None;
    }
    Some((nav, cycles, flagged))
}

/// Builds the `InvalidLoopIssue` for a set of `flagged` cycle indices (as returned by
/// `find_invalid_cycles`), including the `detail_key`/`detail_value` pair (e.g. `"threshold"` /
/// the threshold as a string).
///
/// `requirement` (see GitHub issue #105) controls how much of `cycles` actually gets resolved:
/// - `VALID_CYCLES` set — every cycle in `cycles` (valid and invalid) is resolved into `all`,
///   `invalid_sources` is built. Unchanged from pre-#105 behavior.
/// - `VALID_CYCLES` unset — only the `flagged` cycles are resolved; `all` ends up containing just
///   those, re-indexed from `0`, `invalid` becomes `0..flagged.len()`, `invalid_sources` is left
///   empty. Only a strategy proven not to read a valid cycle's content may omit this flag — see
///   `InvalidLoopRandomStrategy::requirement`'s doc comment.
#[allow(clippy::too_many_arguments)]
pub fn build_issue(
    nav: &NavGraph,
    cycles: &[Vec<usize>],
    flagged: Vec<usize>,
    graph: &crate::Graph,
    instance_id: &str,
    detail_key: &'static str,
    detail_value: impl ToString,
    requirement: InvalidLoopRequirement,
) -> InvalidLoopIssue {
    let (all, invalid, invalid_sources) = if requirement
        .contains(InvalidLoopRequirement::VALID_CYCLES)
    {
        let all = resolve_to_edge_ids(nav, cycles, graph);
        debug_assert!(
            flagged.iter().all(|&idx| idx < all.len()),
            "flagged must only contain valid indices into all — built from the same `cycles` it resolves"
        );
        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for &idx in &flagged {
            invalid_sources
                .entry(canonical_cycle_key(&all[idx]))
                .or_default()
                .push(instance_id.to_string());
        }
        (all, flagged, invalid_sources)
    } else {
        let flagged_cycles: Vec<Vec<usize>> =
            flagged.iter().map(|&idx| cycles[idx].clone()).collect();
        let all = resolve_to_edge_ids(nav, &flagged_cycles, graph);
        let invalid: Vec<usize> = (0..all.len()).collect();
        (all, invalid, HashMap::new())
    };
    InvalidLoopIssue::new_from_check(instance_id, all, invalid, invalid_sources).with_detail(
        instance_id,
        detail_key,
        detail_value.to_string(),
    )
}

/// Tile-length of a nav-edge cycle: sum of each edge's tile-hop count (`path.len() - 1`),
/// measured in base-graph tile-hops, not nav-edge count.
pub fn tile_length(nav: &NavGraph, cycle: &[usize]) -> u32 {
    cycle
        .iter()
        .map(|&idx| (nav.edge_by_idx(idx).path.len() as u32).saturating_sub(1))
        .sum()
}
