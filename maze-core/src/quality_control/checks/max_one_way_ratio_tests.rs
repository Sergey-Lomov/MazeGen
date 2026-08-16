use super::*;
use rand::SeedableRng;
use crate::{Graph, IdGenerator};
use crate::quality_control::Issue;
use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

const TEST_ID: &str = "max_one_way_ratio";

fn rng() -> crate::random::MazeRng {
    crate::random::MazeRng::seed_from_u64(0)
}

/// 10 field cells, 3 one-way edges -> 30 per 100 cells.
fn maze_with_three_one_ways_on_ten_cells() -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    g.add_edge(p(1), p(2), EdgeKind::Basic);
    g.add_edge(p(2), p(3), EdgeKind::Basic);
    Maze::new(field, g)
}

#[test]
fn silent_when_ratio_meets_maximum() {
    let maze = maze_with_three_one_ways_on_ten_cells();
    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 30.0, floor_scope: FloorScope::WholeMaze };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty(), "30 per 100 cells meets a maximum of 30");
}

#[test]
fn fires_with_all_one_ways_as_single_group_when_above_maximum() {
    let maze = maze_with_three_one_ways_on_ten_cells();
    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 20.0, floor_scope: FloorScope::WholeMaze };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].groups.len(), 1, "excess must be reported as a single group");
    assert_eq!(issues[0].groups[0].0.len(), 3, "the group must contain every one-way edge, not just the excess");
    assert_eq!(issues[0].groups[0].1, 1, "30 per 100 cells over a max of 20 -- target count is round(20*10/100)=2, excess is 3-2=1");
    assert_eq!(
        issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_ratio")),
        Some(&"20".to_string()),
    );
}

#[test]
fn target_count_rounds_to_nearest_not_down() {
    // 86 field cells, 8 one-ways, max_ratio=5 -- target_count = round(5*86/100) = round(4.3) = 4,
    // not floor(4.3) = 3. GitHub issue #202 follow-up regression: an earlier floor-based
    // target_count under-reported to_remove as 3 instead of 4 for exactly this kind of
    // near-.5-but-not-quite fraction (reported as 3.92 in a different field-size scenario).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(86, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    for i in 0..8 {
        g.add_edge(p(i * 2), p(i * 2 + 1), EdgeKind::Basic);
    }
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 5.0, floor_scope: FloorScope::WholeMaze };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].groups[0].1, 4, "target_count must round 4.3 to 4, not floor to 3 -- to_remove = 8 - 4 = 4");
}

#[test]
fn silent_when_rounding_pushes_target_count_up_to_meet_count() {
    // 3 field cells, 1 one-way -> ratio = floor(100/3) = 33, which is > max_ratio=32, so the
    // check would fire under a naive "ratio > max_ratio" check alone. But target_count =
    // round(32*3/100) = round(0.96) = 1, equal to count (1) -- rounding error on a small field
    // outgrew the margin `ratio > max_ratio` guarantees, saturating_sub must yield to_remove=0
    // and the check must stay silent instead of firing an empty-effort issue (or, if a plain `-`
    // were ever used instead of saturating_sub, underflowing/panicking).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 32.0, floor_scope: FloorScope::WholeMaze };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty(), "rounding pushed target_count up to meet count exactly -- to_remove must be 0, not underflow");
}

/// 1000 field cells, 300 one-way edges -> a clean 30 per 100 cells ratio fine-grained enough that
/// a `.1`-scale fractional threshold isn't swallowed by the `target_count` rounding step.
fn maze_with_300_one_ways_on_1000_cells() -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(1000, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    for i in 0..300 {
        g.add_edge(p(i * 2), p(i * 2 + 1), EdgeKind::Basic);
    }
    Maze::new(field, g)
}

#[test]
fn max_ratio_accepts_a_genuinely_fractional_threshold() {
    // 300/1000 = 30 per 100 cells. max_ratio 30.1 must stay silent (ratio clears it); 29.9 must
    // fire (ratio exceeds it fractionally) -- pins that the gate compares the true ratio, not one
    // rounded to a whole number first.
    let maze = maze_with_300_one_ways_on_1000_cells();
    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 30.1, floor_scope: FloorScope::WholeMaze };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty(), "30 per 100 cells must not exceed a fractional maximum of 30.1");

    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 29.9, floor_scope: FloorScope::WholeMaze };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1, "30 per 100 cells must exceed a fractional maximum of 29.9");
    assert_eq!(issues[0].groups[0].1, 1, "target_count=round(29.9*1000/100)=299, to_remove=300-299=1");
}

#[test]
fn does_not_count_bidirectional_passage_as_one_way() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 0.0, floor_scope: FloorScope::WholeMaze };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty(), "bidirectional passage must not count toward the ratio");
}

#[test]
fn does_not_floor_the_true_ratio_before_comparing() {
    // 1000 field cells, 309 one-ways -> true ratio is 30.9%, which the old
    // `count * 100 / field_cells` intermediate would floor to 30 -- silently staying quiet
    // against a maximum of 30 even though 30.9% genuinely exceeds it.
    // 309*100 = 30900 > 30*1000 = 30000, so this must fire.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(1000, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    for i in 0..309 {
        g.add_edge(p(i), p(i + 1), EdgeKind::Basic);
    }
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 30.0, floor_scope: FloorScope::WholeMaze };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1, "30.9% must not silently pass a 30% maximum via floor rounding");
}

/// Bottom floor: 10 cells, 3 one-ways (30%). Top floor: 10 cells, 4 one-ways (40%).
fn maze_with_one_ways_on_two_floors() -> Maze<SquareTessellation> {
    use crate::space::Field;
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
    let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
    let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
    let mut g = Graph::new();
    for node in mf.all_node_ids() { g.add_node(node); }
    let pb = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
    let pt = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(pb(0), pb(1), EdgeKind::Basic);
    g.add_edge(pb(1), pb(2), EdgeKind::Basic);
    g.add_edge(pb(2), pb(3), EdgeKind::Basic);
    g.add_edge(pt(0), pt(1), EdgeKind::Basic);
    g.add_edge(pt(1), pt(2), EdgeKind::Basic);
    g.add_edge(pt(2), pt(3), EdgeKind::Basic);
    g.add_edge(pt(3), pt(4), EdgeKind::Basic);
    Maze::new(mf, g)
}

#[test]
fn per_floor_flags_each_over_budget_floor_with_its_own_group_and_to_remove() {
    let maze = maze_with_one_ways_on_two_floors();
    let check = MaxOneWayRatioCheck { instance_id: TEST_ID.to_string(), max_ratio: 20.0, floor_scope: FloorScope::PerFloor };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    let mut groups = issues[0].groups.clone();
    groups.sort_by_key(|(g, _)| g.len());
    assert_eq!(groups.len(), 2, "each over-budget floor must get its own independent group");
    assert_eq!(groups[0].0.len(), 3, "bottom floor's own one-ways only");
    assert_eq!(groups[0].1, 1, "bottom floor's own to_remove (target=round(20*10/100)=2, 3-2=1)");
    assert_eq!(groups[1].0.len(), 4, "top floor's own one-ways only");
    assert_eq!(groups[1].1, 2, "top floor's own to_remove (target=2, 4-2=2), not the max across floors");
}
