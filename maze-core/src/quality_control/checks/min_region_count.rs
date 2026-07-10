use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::{RegionClass, ALL_REGION_CLASSES};
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_REGIONS};
use crate::quality_control::issue_data::IssueData;

pub const MIN_REGION_COUNT_DEFAULT: u32 = 0;

/// Flags a region-count shortfall or surplus per `RegionClass` — see GitHub issue #55 and #59's
/// "Region Balance" data model. A single instance carries one `min_count` threshold per class
/// (default 0 — unset, never flags that class either way); there is exactly one active instance
/// at a time (unlike the old per-class multi-instance design from issue #60, retired here since
/// a single instance now sees all four classes' counts at once and can report `+N`/`-N` for any
/// of them in one pass — no merge across instances is needed any more).
pub struct MinRegionCountCheck {
    pub instance_id: String,
    pub min_counts: HashMap<RegionClass, u32>,
}

impl<T: Tessellation> Check<T> for MinRegionCountCheck {
    fn check_type_id(&self) -> &'static str { "min_region_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        if maze.meta.start.is_none() || maze.meta.finish.is_none() {
            return;
        }
        let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);

        let mut balance_by_class: HashMap<RegionClass, i32> = HashMap::new();
        for class in ALL_REGION_CLASSES {
            let min_count = *self.min_counts.get(&class).unwrap_or(&0);
            if min_count == 0 {
                continue;
            }
            let count = classes.values().filter(|&&c| c == class).count() as u32;
            // `+N` (surplus over the configured minimum) or `-N` (shortfall) — see
            // `IssueData::MissingRegions`'s doc comment for how a repair strategy consumes each
            // sign. A class sitting exactly at its minimum carries no entry (balance 0 is not
            // reported — nothing to fix, nothing to spend).
            let balance = count as i64 - min_count as i64;
            if balance != 0 {
                balance_by_class.insert(class, balance as i32);
            }
        }

        // A pure surplus (no class actually short) is spendable budget for
        // `MissingRegionsStrategy`'s cross-region growth, not a problem on its own — `min_count`
        // is a floor, not a range, so having more than enough of a class is never itself
        // something to fix. Only a genuine shortfall (a negative entry) makes this worth
        // flagging; surplus entries still ride along in `balance_by_class` on that issue so the
        // repair strategy can spend them, same as before.
        if !balance_by_class.values().any(|&b| b < 0) {
            return;
        }

        let mut detail_classes: Vec<&RegionClass> = balance_by_class.iter()
            .filter(|&(_, &b)| b < 0)
            .map(|(c, _)| c)
            .collect();
        detail_classes.sort_by_key(|c| c.as_str());
        let detail = detail_classes.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(",");

        // Single-deficit-class case only: the exact configured minimum for that one class, so
        // the UI can render "fewer than required (N)" instead of just naming the class. With
        // multiple classes short at once there's no single N to show — the generic class-list
        // label is used instead (see `issueRegistry.ts`'s `min_region_count` detail-label
        // override). Computed before `balance_by_class` moves into `IssueData` below.
        let single_deficit_min_count = match detail_classes[..] {
            [only_class] => Some(*self.min_counts.get(only_class).unwrap_or(&0)),
            _ => None,
        };

        let mut issue = Issue::with_data_from_check(
            MISSING_REGIONS,
            IssueData::MissingRegions { balance_by_class },
            &self.instance_id,
        )
            .with_detail(&self.instance_id, "region_classes", detail);

        if let Some(min_count) = single_deficit_min_count {
            issue = issue.with_detail(&self.instance_id, "min_count", min_count.to_string());
        }

        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    const TEST_ID: &str = "min_region_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 5 cells in a line, all one-way: 0 -> 1 -> 2 -> 3 -> 4. Each node its own SCC.
    /// start=0, finish=2: nodes 0,1,2 are Path; nodes 3,4 are reachable from start but can't
    /// reach finish (finish=2 is upstream of them) -> both Trap.
    fn maze_with_trap_tail() -> (Maze<SquareTessellation>, crate::ids::NodeId, crate::ids::NodeId) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        let start = nodes[0];
        let finish = nodes[2];
        let mut maze = Maze::new(field, g);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);
        (maze, start, finish)
    }

    fn check(min_counts: Vec<(RegionClass, u32)>) -> MinRegionCountCheck {
        MinRegionCountCheck { instance_id: TEST_ID.to_string(), min_counts: min_counts.into_iter().collect() }
    }

    #[test]
    fn silent_when_skipped_without_endpoints() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let maze = Maze::new(field, g);
        let c = check(vec![(RegionClass::Trap, 1)]);
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "endpoints unset — classification unavailable, not this check's failure mode");
    }

    #[test]
    fn silent_when_class_count_meets_minimum_exactly() {
        let (maze, _, _) = maze_with_trap_tail();
        let c = check(vec![(RegionClass::Trap, 2)]);
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "nodes 3 and 4 are both Trap regions, meeting a minimum of 2 exactly");
    }

    #[test]
    fn silent_when_unconfigured_class_left_at_default_zero() {
        let (maze, _, _) = maze_with_trap_tail();
        let c = check(vec![(RegionClass::Unreachable, 0)]);
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "min_count=0 means this class is never checked, even at 0 unreachable regions");
    }

    #[test]
    fn fires_with_negative_balance_when_class_count_is_below_minimum() {
        let (maze, _, _) = maze_with_trap_tail();
        let c = check(vec![(RegionClass::Trap, 3)]);
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, MISSING_REGIONS);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        match &issues[0].data {
            Some(IssueData::MissingRegions { balance_by_class }) => {
                assert_eq!(balance_by_class, &HashMap::from([(RegionClass::Trap, -1)]), "2 trap regions found, 3 required -> -1");
            }
            other => panic!("expected MissingRegions, got {other:?}"),
        }
    }

    #[test]
    fn single_deficit_class_carries_the_min_count_detail() {
        let (maze, _, _) = maze_with_trap_tail();
        let c = check(vec![(RegionClass::Trap, 3)]);
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng());
        let details = &issues[0].details()[TEST_ID];
        assert_eq!(details.get("min_count"), Some(&"3".to_string()), "single deficit class -- UI needs the exact configured minimum to render \"fewer than required (N)\"");
    }

    #[test]
    fn multiple_deficit_classes_carry_no_min_count_detail() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut maze = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[1]);
        // Trap: 0 found, min 1 -> -1. Alternative: 0 found, min 1 -> -1 -- two classes short at
        // once, no single N to show.
        let c = check(vec![(RegionClass::Trap, 1), (RegionClass::Alternative, 1)]);
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        let details = &issues[0].details()[TEST_ID];
        assert_eq!(details.get("min_count"), None, "two deficit classes at once -- no single min_count to report");
    }

    #[test]
    fn silent_on_a_pure_surplus_with_no_class_actually_short() {
        // `min_count` is a floor, not a range -- having more than enough of a class is spendable
        // budget for `MissingRegionsStrategy`, not a problem on its own, so it must not fire an
        // issue when nothing is actually short.
        let (maze, _, _) = maze_with_trap_tail();
        let c = check(vec![(RegionClass::Trap, 1)]);
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "2 trap regions found, 1 required -> +1 surplus, no deficit anywhere -- must not fire");
    }

    #[test]
    fn one_instance_reports_multiple_classes_at_once() {
        let (maze, _, _) = maze_with_trap_tail();
        // Trap: 2 found, min 3 -> -1. Path: 3 found (start, mid, finish), min 1 -> +2.
        let c = check(vec![(RegionClass::Trap, 3), (RegionClass::Path, 1)]);
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1, "one instance, one issue, even with multiple classes off-target");
        match &issues[0].data {
            Some(IssueData::MissingRegions { balance_by_class }) => {
                assert_eq!(balance_by_class, &HashMap::from([(RegionClass::Trap, -1), (RegionClass::Path, 2)]));
            }
            other => panic!("expected MissingRegions, got {other:?}"),
        }
    }
}
