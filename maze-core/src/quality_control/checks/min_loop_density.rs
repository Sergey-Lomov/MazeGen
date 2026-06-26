use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::graph::cycles::{find_deduped_simple_cycles, resolve_to_edge_ids, density_per_100};
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_LOOPS};
use crate::quality_control::issue_data::IssueData;
use crate::repair::CheckId;

pub const MIN_LOOP_DENSITY_DEFAULT: u32 = 30;
pub const AVG_LOOP_LENGTH_ESTIMATE_DEFAULT: u32 = 10;
pub const MIN_LOOP_DENSITY_CHECK_ID: CheckId = CheckId::MinLoopDensity;

/// Flags too few loops when too small a share of the field is covered by them — see GitHub
/// issue #36. Density is the count of distinct field cells touched by any loop (each cell
/// counted once, even if covered by several loops), per 100 field cells — same metric as
/// `MaxLoopDensityCheck`, just checked against a minimum instead of a maximum. When density is
/// below `min_density`, the missing cell count is converted into a loop count via
/// `avg_loop_length_estimate` (`missing_cells / avg_loop_length_estimate`, rounded up so the
/// request never undershoots the deficit) and raised as `MISSING_LOOPS`.
pub struct MinLoopDensityCheck {
    pub min_density: u32,
    pub avg_loop_length_estimate: u32,
}

impl<T: Tessellation> Check<T> for MinLoopDensityCheck {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let field_cells = maze.field.node_count();
        if field_cells == 0 {
            return;
        }
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;
        // Silently skip on overflow, same rationale as MaxLoopDensityCheck (issue #22).
        let covered: HashSet<NodeId> = match find_deduped_simple_cycles(nav) {
            Some(cycles) if !cycles.is_empty() => {
                let all = resolve_to_edge_ids(nav, &cycles, &maze.graph);
                all.iter()
                    .flat_map(|cycle| cycle.iter().filter_map(|&id| maze.graph.edge(id)))
                    .flat_map(|edge| [edge.from, edge.to])
                    .collect()
            }
            Some(_) => HashSet::new(),
            None => return,
        };

        let density = density_per_100(covered.len(), field_cells);
        if density >= self.min_density {
            return;
        }

        let missing_cells = (self.min_density - density) as usize * field_cells / 100;
        let missing = div_ceil(missing_cells as u32, self.avg_loop_length_estimate.max(1));
        if missing == 0 {
            return;
        }

        let issue = Issue::with_data_from_check(MISSING_LOOPS, IssueData::Missing { missing }, MIN_LOOP_DENSITY_CHECK_ID)
            .with_detail(MIN_LOOP_DENSITY_CHECK_ID, "missing", missing.to_string());
        issues.push(issue);
    }
}

fn div_ceil(a: u32, b: u32) -> u32 {
    (a + b - 1) / b
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    fn rng() -> rand::rngs::SmallRng {
        rand::rngs::SmallRng::seed_from_u64(0)
    }

    /// 10 cells in a line, one triangle (3 distinct cells covered) -> 30% density.
    fn maze_with_one_triangle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_density_at_or_above_min() {
        let maze = maze_with_one_triangle();
        let check = MinLoopDensityCheck { min_density: 30, avg_loop_length_estimate: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "30% density meets a minimum of 30");
    }

    #[test]
    fn fires_with_missing_count_when_below_min() {
        // 30% density, min_density 60 -> 30 missing points -> 3 missing cells out of 10 field
        // cells -> ceil(3 / 1) = 3 loops requested.
        let maze = maze_with_one_triangle();
        let check = MinLoopDensityCheck { min_density: 60, avg_loop_length_estimate: 1 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, MISSING_LOOPS);
        assert_eq!(issues[0].source_checks(), vec![CheckId::MinLoopDensity]);
        match &issues[0].data {
            Some(IssueData::Missing { missing }) => assert_eq!(*missing, 3),
            other => panic!("expected Missing, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(&CheckId::MinLoopDensity).and_then(|kv| kv.get("missing")),
            Some(&"3".to_string()),
        );
    }

    #[test]
    fn missing_loop_count_rounds_up() {
        // 30% density, min_density 40 -> 10 missing points -> 1 missing cell -> ceil(1 / 4) = 1.
        let maze = maze_with_one_triangle();
        let check = MinLoopDensityCheck { min_density: 40, avg_loop_length_estimate: 4 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        match &issues[0].data {
            Some(IssueData::Missing { missing }) => assert_eq!(*missing, 1, "ceil(1/4) must round up to 1, not truncate to 0"),
            other => panic!("expected Missing, got {other:?}"),
        }
    }

    #[test]
    fn fires_when_no_cycle_exists() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MinLoopDensityCheck { min_density: 100, avg_loop_length_estimate: 1 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        match &issues[0].data {
            Some(IssueData::Missing { missing }) => assert!(*missing > 0),
            other => panic!("expected Missing, got {other:?}"),
        }
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
        let check = MinLoopDensityCheck { min_density: 100, avg_loop_length_estimate: 1 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }

    #[test]
    fn silent_when_missing_count_rounds_to_zero() {
        // 30% density, min_density 31 -> 1 missing point -> 0 missing cells (10*1/100=0) -> no issue.
        let maze = maze_with_one_triangle();
        let check = MinLoopDensityCheck { min_density: 31, avg_loop_length_estimate: 1 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty());
    }
}
