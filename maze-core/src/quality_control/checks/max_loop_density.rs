use std::collections::HashSet;
use rand::RngCore;
use rand::seq::SliceRandom;
use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::space::Tessellation;
use crate::graph::cycles::{resolve_to_edge_ids, density_per_100};
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};

pub const MAX_LOOP_DENSITY_DEFAULT: u32 = 30;

/// Flags excess simple loops when too large a share of the field is covered by them — see
/// GitHub issue #37. Density is the count of distinct field cells touched by any loop (each
/// cell counted once, even if covered by several loops), per 100 field cells. When density
/// exceeds `max_density`, loops are picked in random order and flagged one at a time —
/// recomputing the remaining density against only the still-unselected loops after each pick,
/// since removing a loop only frees the cells not also covered by another loop not yet
/// selected — until enough are flagged to bring density down to `max_density`, or every loop
/// has been flagged.
///
/// Unlike the other loop-based checks, this one doesn't go through `cycle_check_core` — density
/// is judged over the whole set of cycles at once (a single loop can't be individually "invalid"
/// against a density threshold the way it can against a length/distance/diversity threshold), so
/// it needs its own enumeration entry point (`maze.analysis.cycles()` directly) and a bespoke
/// `excess`-selection algorithm instead of `find_invalid_cycles`'s per-cycle predicate.
pub struct MaxLoopDensityCheck {
    pub instance_id: String,
    pub max_density: u32,
}

impl<T: Tessellation> Check<T, InvalidLoopIssue> for MaxLoopDensityCheck {
    fn check_type_id(&self) -> &'static str { "max_loop_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopIssue>, rng: &mut dyn RngCore, requirement: InvalidLoopRequirement) {
        let Some((nav, cycles, excess)) = excess_cycles(maze, rng, self.max_density) else { return };

        let nav = &nav;
        let cycle_id = excess[0];
        let cycle = resolve_to_edge_ids(nav, std::slice::from_ref(&cycles[cycle_id]), &maze.graph)
            .into_iter().next().expect("resolving exactly one cycle always yields exactly one entry");
        let other_invalid = if requirement.contains(InvalidLoopRequirement::OTHER_INVALID) {
            excess[1..].to_vec()
        } else {
            Vec::new()
        };
        // OTHER_VALID has no meaning for this check: density judges the whole cycle set at
        // once, there is no separate notion of "the valid cycles" distinct from "the ones not
        // picked into excess" — a cycle not in `excess` isn't individually valid or invalid, it
        // simply wasn't needed to reach `max_density`. Left empty regardless of the requirement.
        let issue = InvalidLoopIssue::new_from_check(&self.instance_id, cycle_id, cycle, other_invalid, Vec::new())
            .with_detail(&self.instance_id, "max_density", self.max_density.to_string());
        issues.push(issue);
    }

    fn report_check(&self, maze: &Maze<T>, rng: &mut dyn RngCore) -> Vec<InvalidLoopIssue> {
        let Some((nav, cycles, excess)) = excess_cycles(maze, rng, self.max_density) else { return Vec::new() };

        let nav = &nav;
        excess.iter().map(|&cycle_id| {
            let cycle = resolve_to_edge_ids(nav, std::slice::from_ref(&cycles[cycle_id]), &maze.graph)
                .into_iter().next().expect("resolving exactly one cycle always yields exactly one entry");
            InvalidLoopIssue::new_from_check(&self.instance_id, cycle_id, cycle, Vec::new(), Vec::new())
                .with_detail(&self.instance_id, "max_density", self.max_density.to_string())
        }).collect()
    }
}

/// Builds the full remaining-density excess selection in one pass — the shared core `repair_check`/
/// `report_check` both need, so the algorithm is never run twice or risk diverging between the
/// "pick the main cycle" and "pick the rest" halves (see GitHub issue #98). Returns `None` if
/// enumeration overflows, the field is empty, there are no cycles, or density is already at or
/// below `max_density`. `rng` is consulted exactly once (`order.shuffle`) regardless of how many
/// cycles end up excess — the shuffle order is built once, then walked in full.
fn excess_cycles<T: Tessellation>(
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    max_density: u32,
) -> Option<(crate::graph::nav::NavGraph, Vec<Vec<usize>>, Vec<usize>)> {
    let field_cells = maze.field.node_count();
    if field_cells == 0 {
        return None;
    }
    let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let cycles = maze.analysis.cycles(&maze.graph, &maze.meta)?;
    if cycles.is_empty() {
        return None;
    }

    let all = resolve_to_edge_ids(&nav, &cycles, &maze.graph);
    let cell_sets: Vec<HashSet<NodeId>> = all.iter()
        .map(|cycle| cycle_cells(&maze.graph, cycle))
        .collect();

    let covered: HashSet<NodeId> = cell_sets.iter().flatten().copied().collect();
    if density_per_100(covered.len(), field_cells) <= max_density {
        return None;
    }

    let mut order: Vec<usize> = (0..cycles.len()).collect();
    order.shuffle(rng);

    let mut remaining = covered;
    let mut excess: Vec<usize> = Vec::new();
    for idx in order {
        excess.push(idx);
        remaining.retain(|cell| !cell_sets[idx].contains(cell));
        if density_per_100(remaining.len(), field_cells) <= max_density {
            break;
        }
    }

    Some((nav, cycles, excess))
}

/// Set of base-Graph cells (node endpoints) touched by a cycle's edges.
fn cycle_cells(graph: &crate::Graph, cycle: &[EdgeId]) -> HashSet<NodeId> {
    cycle.iter()
        .filter_map(|&id| graph.edge(id))
        .flat_map(|edge| [edge.from, edge.to])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    const TEST_ID: &str = "max_loop_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 cells in a line, two disjoint triangles (6 distinct cells covered) -> 60% density.
    fn maze_with_two_disjoint_triangles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
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
    fn fires_and_flags_loops_when_density_exceeds_max() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(issues[0].cycle.len(), 3, "flagging one triangle (3 of 6 covered cells) is enough to drop to 30%");
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_density")),
            Some(&"30".to_string()),
        );
    }

    #[test]
    fn silent_when_density_at_or_below_max() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 60 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "60% density should clear a threshold of 60");
    }

    #[test]
    fn density_rounds_instead_of_truncating() {
        // 8 field cells, one triangle covers 3 -> true density 300/8 = 37.5%. Truncating
        // division would read this as 37 (<= max_density 37, no fire); rounding reads it as
        // 38 (> 37, fires) -- this test pins the rounding behavior so a regression to
        // truncation is caught.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(8, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 37 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1, "37.5% rounds to 38, which exceeds max_density 37");
    }

    #[test]
    fn overlapping_loops_account_for_shared_cells_when_selecting() {
        // Two triangles sharing one vertex: 5 distinct covered cells out of 10 (50%).
        // Flagging either triangle alone only frees 2 unique cells (3 shared with none, since
        // only the apex is shared) -- one triangle brings 5-3=2 covered remaining -> 20%,
        // clears a max of 30 immediately, so only one cycle should end up excess.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // Triangle A: 0-1-2-0, Triangle B: 2-3-4-2 (shares node 2)
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[2], EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert!(issues[0].other_invalid.is_empty(), "flagging one of the two overlapping triangles already clears the target");
    }

    #[test]
    fn flags_all_loops_when_target_unreachable() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].other_invalid.len(), 1, "both loops must be flagged when even both together can't reach max_density 0");
    }

    #[test]
    fn report_check_produces_one_issue_per_excess_cycle() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0 };
        let mut rng = rng();
        let report = check.report_check(&maze, &mut rng);
        assert_eq!(report.len(), 2, "both loops are needed to reach max_density 0, so report_check must yield two issues");
    }

    #[test]
    fn silent_when_no_cycle() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        use crate::space::SquarePoint;
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field.node_at(SquarePoint { x, y }).unwrap();
                if x + 1 < SIDE {
                    let right = field.node_at(SquarePoint { x: x + 1, y }).unwrap();
                    g.add_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field.node_at(SquarePoint { x, y: y + 1 }).unwrap();
                    g.add_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }
}
