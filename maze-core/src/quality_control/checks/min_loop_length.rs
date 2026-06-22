use crate::Maze;
use crate::space::Tessellation;
use crate::graph::nav::build_nav_graph;
use crate::graph::cycles::{find_all_simple_cycles, dedup_bidirectional_pairs, resolve_to_edge_ids};
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MIN_LOOP_LENGTH};
use crate::quality_control::issue_data::IssueData;

pub const MIN_LOOP_LENGTH_DEFAULT: u32 = 10;

pub struct MinLoopLengthCheck {
    pub min_loop_length: u32,
}

impl<T: Tessellation> Check<T> for MinLoopLengthCheck {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>) {
        let nav = build_nav_graph(&maze.graph);
        let cycles = find_all_simple_cycles(&nav);
        let cycles = dedup_bidirectional_pairs(&nav, cycles);

        let short_nav_cycles: Vec<Vec<usize>> = cycles.into_iter()
            .filter(|cycle| tile_length(&nav, cycle) < self.min_loop_length)
            .collect();
        if short_nav_cycles.is_empty() {
            return;
        }
        let short_cycles = resolve_to_edge_ids(&nav, &short_nav_cycles, &maze.graph);
        issues.push(Issue::with_data(MIN_LOOP_LENGTH, IssueData::ShortLoops(short_cycles)));
    }
}

/// Tile-length of a nav-edge cycle: sum of each edge's tile-hop count
/// (`path.len() - 1`), measured in base-graph tile-hops, not nav-edge count.
fn tile_length(nav: &crate::graph::nav::NavGraph, cycle: &[usize]) -> u32 {
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

    fn maze_with_triangle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn fires_when_short_cycle_exists() {
        let maze = maze_with_triangle();
        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, MIN_LOOP_LENGTH);
        match &issues[0].data {
            Some(IssueData::ShortLoops(cycles)) => assert_eq!(cycles.len(), 1),
            other => panic!("expected ShortLoops, got {other:?}"),
        }
    }

    #[test]
    fn silent_when_cycle_not_shorter_than_threshold() {
        let maze = maze_with_triangle();
        let check = MinLoopLengthCheck { min_loop_length: 3 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        assert!(issues.is_empty(), "triangle has 3 tile-hops, not < 3");
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
        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        assert!(issues.is_empty());
    }
}
