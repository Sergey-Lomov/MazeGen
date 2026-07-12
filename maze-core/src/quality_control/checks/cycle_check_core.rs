use crate::Maze;
use crate::space::Tessellation;
use crate::graph::nav::NavGraph;
use crate::graph::cycles::resolve_to_edge_ids;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};

/// Shared cycle-enumeration/issue-building skeleton for the loop-based checks
/// (`MinLoopLengthCheck`, `MaxLoopLengthCheck`, `LoopDistanceFromStartCheck`,
/// `LoopDistanceFromFinishCheck`, `ExternalEscapeDiversityCheck`) — see GitHub issue #107. Each
/// check owns only its predicate (what makes a cycle invalid) and its detail key/value.
///
/// Reads cycle enumeration from `MazeAnalysis::cycles()` (one enumeration per QC pass, shared
/// across every check reading it, instead of each check re-running `find_deduped_simple_cycles`
/// itself) and applies `invalid` to each — silently skipping (returning `None`) if enumeration
/// overflows (see `CycleSearchResult::TooManyCycles`, issue #22) or no cycle is flagged. Returns
/// both `flagged` (invalid) and `valid` indices — new for GitHub issue #98, since `InvalidLoopIssue`
/// now needs to tell one from the other explicitly rather than deriving "the rest" from `all`.
pub fn find_invalid_cycles<T: Tessellation>(
    maze: &Maze<T>,
    invalid: impl Fn(&NavGraph, &[usize]) -> bool,
) -> Option<(NavGraph, Vec<Vec<usize>>, Vec<usize> /* flagged */, Vec<usize> /* valid */)> {
    let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let cycles = maze.analysis.cycles(&maze.graph, &maze.meta)?;

    let (flagged, valid): (Vec<usize>, Vec<usize>) = (0..cycles.len())
        .partition(|&idx| invalid(&nav, &cycles[idx]));
    if flagged.is_empty() {
        return None;
    }
    Some((nav, cycles, flagged, valid))
}

/// Builds one `InvalidLoopIssue` for the repair path — `cycle_id`/`cycle` are always the first
/// entry in `flagged` (resolved to `EdgeId`s regardless of `requirement`, since `cycle` is needed
/// for `PartialEq`/no-progress comparison independent of what a strategy asked for — see
/// `InvalidLoopIssue`'s doc comment). `other_invalid`/`other_valid` are resolved from `flagged[1..]`/
/// `valid` only if `requirement` asks for them (see GitHub issue #105) — plain index sets, no
/// `resolve_to_edge_ids` call needed for these, unlike the main `cycle`.
pub fn build_repair_issue(
    nav: &NavGraph,
    cycles: &[Vec<usize>],
    graph: &crate::Graph,
    flagged: &[usize],
    valid: &[usize],
    instance_id: &str,
    detail_key: &'static str,
    detail_value: impl ToString,
    requirement: InvalidLoopRequirement,
) -> InvalidLoopIssue {
    let cycle_id = flagged[0];
    let cycle = resolve_to_edge_ids(nav, std::slice::from_ref(&cycles[cycle_id]), graph)
        .into_iter().next().expect("resolving exactly one cycle always yields exactly one entry");

    let other_invalid = if requirement.contains(InvalidLoopRequirement::OTHER_INVALID) {
        flagged[1..].to_vec()
    } else {
        Vec::new()
    };
    let other_valid = if requirement.contains(InvalidLoopRequirement::OTHER_VALID) {
        valid.to_vec()
    } else {
        Vec::new()
    };

    InvalidLoopIssue::new_from_check(instance_id, cycle_id, cycle, other_invalid, other_valid)
        .with_detail(instance_id, detail_key, detail_value.to_string())
}

/// Builds one `InvalidLoopIssue` per entry in `flagged`, for the report path (see GitHub issue
/// #102/#98) — no `other_invalid`/`other_valid`, since a report-path issue is never dispatched to
/// a repair strategy.
pub fn build_report_issues(
    nav: &NavGraph,
    cycles: &[Vec<usize>],
    graph: &crate::Graph,
    flagged: &[usize],
    instance_id: &str,
    detail_key: &'static str,
    detail_value: impl ToString + Clone,
) -> Vec<InvalidLoopIssue> {
    flagged.iter().map(|&cycle_id| {
        let cycle = resolve_to_edge_ids(nav, std::slice::from_ref(&cycles[cycle_id]), graph)
            .into_iter().next().expect("resolving exactly one cycle always yields exactly one entry");
        InvalidLoopIssue::new_from_check(instance_id, cycle_id, cycle, Vec::new(), Vec::new())
            .with_detail(instance_id, detail_key, detail_value.clone().to_string())
    }).collect()
}

/// Tile-length of a nav-edge cycle: sum of each edge's tile-hop count (`path.len() - 1`),
/// measured in base-graph tile-hops, not nav-edge count.
pub fn tile_length(nav: &NavGraph, cycle: &[usize]) -> u32 {
    cycle.iter()
        .map(|&idx| (nav.edge_by_idx(idx).path.len() as u32).saturating_sub(1))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    /// Two disjoint triangles -- both invalid against a `< 10` predicate.
    fn maze_with_two_triangles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
        g.add_edge(nodes[5], nodes[3], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn find_invalid_cycles_partitions_flagged_and_valid() {
        let maze = maze_with_two_triangles();
        let (_nav, cycles, flagged, valid) = find_invalid_cycles(&maze, |nav, cycle| {
            tile_length(nav, cycle) < 10
        }).unwrap();
        assert_eq!(cycles.len(), 2, "two disjoint triangles enumerate as two cycles");
        assert_eq!(flagged.len(), 2, "both triangles are invalid against a < 10 predicate");
        assert!(valid.is_empty(), "neither triangle is valid");
    }

    #[test]
    fn find_invalid_cycles_returns_none_when_nothing_flagged() {
        let maze = maze_with_two_triangles();
        let result = find_invalid_cycles(&maze, |_nav, _cycle| false);
        assert!(result.is_none(), "no flagged cycle must yield None, not an empty flagged Vec");
    }

    #[test]
    fn build_repair_issue_picks_first_flagged_as_main_cycle() {
        let maze = maze_with_two_triangles();
        let (nav, cycles, flagged, valid) = find_invalid_cycles(&maze, |nav, cycle| {
            tile_length(nav, cycle) < 10
        }).unwrap();
        let issue = build_repair_issue(&nav, &cycles, &maze.graph, &flagged, &valid, "check", "k", "v", InvalidLoopRequirement::all());
        assert_eq!(issue.cycle_id, flagged[0]);
        assert_eq!(issue.cycle.len(), 3, "the main cycle is one triangle, 3 edges");
        assert_eq!(issue.other_invalid, vec![flagged[1]], "the other triangle lands in other_invalid under all()");
    }

    #[test]
    fn build_repair_issue_respects_empty_requirement() {
        let maze = maze_with_two_triangles();
        let (nav, cycles, flagged, valid) = find_invalid_cycles(&maze, |nav, cycle| {
            tile_length(nav, cycle) < 10
        }).unwrap();
        let issue = build_repair_issue(&nav, &cycles, &maze.graph, &flagged, &valid, "check", "k", "v", InvalidLoopRequirement::empty());
        assert!(issue.other_invalid.is_empty(), "empty() must not resolve other_invalid");
        assert!(issue.other_valid.is_empty(), "empty() must not resolve other_valid");
    }

    #[test]
    fn build_report_issues_produces_one_issue_per_flagged_cycle() {
        let maze = maze_with_two_triangles();
        let (nav, cycles, flagged, _valid) = find_invalid_cycles(&maze, |nav, cycle| {
            tile_length(nav, cycle) < 10
        }).unwrap();
        let issues = build_report_issues(&nav, &cycles, &maze.graph, &flagged, "check", "k", "v");
        assert_eq!(issues.len(), 2, "one issue per flagged cycle");
        for issue in &issues {
            assert_eq!(issue.cycle.len(), 3);
            assert!(issue.other_invalid.is_empty(), "report-path issues never carry other_invalid");
            assert!(issue.other_valid.is_empty(), "report-path issues never carry other_valid");
        }
    }
}
