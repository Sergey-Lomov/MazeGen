//! Zone scope of a QC rule (GitHub issue #1039): what a rule bound to scopes sees, how it reports
//! and which of a strategy's commands it lets through.

use maze_core::generation::PresetState;
use maze_core::graph::EdgeKind;
use maze_core::ids::NodeId;
use maze_core::quality_control::{
    Check, Issue, MaxTeleportCountCheck, MissingEndpointsIssue, Rule, RuleIterationOutcome,
    ScopeCells, TeleportDirectionFilter, TeleportFloorKindFilter,
};
use maze_core::repair::{
    MutationCommand, NestedStrategyConfig, RepairResult, RepairStrategy, StrategyParams,
};
use maze_core::space::{MultiLevelField, SquareTessellation, square_rect};
use maze_core::{Graph, IdGenerator, Maze};
use rand::SeedableRng;
use std::collections::HashMap;
use std::sync::Arc;

type Square = SquareTessellation;

/// A 4x1 strip `a b c d` (ascending node ids) joined by plain passages, plus the bidirectional
/// teleports `a <-> c` and `b <-> d`.
fn strip() -> (Maze<Square>, [NodeId; 4]) {
    let mut ids = IdGenerator::new();
    let field =
        MultiLevelField::<Square>::single_level(Arc::default(), square_rect(4, 1), &mut ids)
            .unwrap();
    let mut nodes: Vec<NodeId> = field.all_node_ids().collect();
    nodes.sort_unstable();
    let [a, b, c, d] = [nodes[0], nodes[1], nodes[2], nodes[3]];
    let mut graph = Graph::new();
    for &n in &nodes {
        graph.add_node(n);
    }
    graph.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
    graph.build_initial_bidirectional_edge(b, c, EdgeKind::Basic);
    graph.build_initial_bidirectional_edge(c, d, EdgeKind::Basic);
    graph.build_initial_bidirectional_edge(a, c, EdgeKind::Teleport);
    graph.build_initial_bidirectional_edge(b, d, EdgeKind::Teleport);
    (Maze::new(field, graph), [a, b, c, d])
}

fn scope(maze: &Maze<Square>, id: &str, nodes: &[NodeId]) -> ScopeCells<Square> {
    ScopeCells::new(
        id,
        nodes.iter().map(|&n| {
            (
                maze.field.level_of(n).unwrap(),
                maze.field.cell_of(n).unwrap(),
            )
        }),
    )
}

fn max_teleports_rule(
    max: u32,
    scopes: Option<Vec<ScopeCells<Square>>>,
) -> Rule<Square, maze_core::quality_control::InvalidTeleportGroupIssue> {
    let check = MaxTeleportCountCheck {
        instance_id: "max_teleport_count".to_string(),
        max_teleports: max,
        direction: TeleportDirectionFilter::Any,
        floor_kind: TeleportFloorKindFilter::Any,
    };
    let rule = Rule::new(
        "r".to_string(),
        vec![("max_teleport_count".to_string(), Box::new(check))],
        None,
        HashMap::new(),
        vec![],
    );
    match scopes {
        Some(scopes) => rule.with_scopes(scopes),
        None => rule,
    }
}

fn report<
    I: maze_core::quality_control::IssueRequirement + maze_core::quality_control::IssueMerge,
>(
    rule: &Rule<Square, I>,
    maze: &Maze<Square>,
) -> Vec<I> {
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    rule.report_checks_typed(maze, &mut rng, &mut HashMap::new(), &|| 0.0)
}

#[test]
fn a_rule_without_scopes_sees_the_whole_map() {
    let (maze, _) = strip();
    let issues = report(&max_teleports_rule(1, None), &maze);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].meta().scope(), None);
}

#[test]
fn iteration_counts_each_scope_alone_and_union_counts_them_together() {
    let (maze, [a, b, c, d]) = strip();
    // Iteration: one teleport per scope, within the limit of one.
    let iteration = max_teleports_rule(
        1,
        Some(vec![
            scope(&maze, "zone:1", &[a, c]),
            scope(&maze, "zone:2", &[b, d]),
        ]),
    );
    assert!(report(&iteration, &maze).is_empty());
    // Union: both teleports in one scope, over the limit.
    let union = max_teleports_rule(1, Some(vec![scope(&maze, "group:1", &[a, b, c, d])]));
    let issues = report(&union, &maze);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].meta().scope(), Some("group:1"));
}

#[test]
fn each_scope_reports_under_its_own_id() {
    let (maze, [a, b, c, d]) = strip();
    let rule = max_teleports_rule(
        0,
        Some(vec![
            scope(&maze, "zone:1", &[a, c]),
            scope(&maze, "zone:2", &[b, d]),
        ]),
    );
    let ids: Vec<Option<String>> = report(&rule, &maze)
        .iter()
        .map(|i| i.meta().scope().map(str::to_string))
        .collect();
    assert_eq!(ids, vec![Some("zone:1".into()), Some("zone:2".into())]);
}

#[test]
fn a_scope_sees_the_links_leaving_it_but_not_those_beyond() {
    let (maze, [a, _, _, d]) = strip();
    // Only `a` is inner: its passage to b and its teleport to c are visible, d is not.
    let rule = max_teleports_rule(0, Some(vec![scope(&maze, "zone:1", &[a])]));
    assert_eq!(report(&rule, &maze).len(), 1);
    // Only `d` is inner: it still owns the teleport to b.
    let rule = max_teleports_rule(0, Some(vec![scope(&maze, "zone:1", &[d])]));
    assert_eq!(report(&rule, &maze).len(), 1);
}

#[test]
fn an_empty_scope_list_sees_nothing_and_a_duplicated_scope_runs_once() {
    let (maze, [a, b, c, d]) = strip();
    assert!(report(&max_teleports_rule(0, Some(vec![])), &maze).is_empty());
    let twice = max_teleports_rule(
        0,
        Some(vec![
            scope(&maze, "zone:1", &[a, b, c, d]),
            scope(&maze, "zone:1", &[a, b, c, d]),
        ]),
    );
    assert_eq!(report(&twice, &maze).len(), 1);
}

#[test]
fn the_mask_is_lifted_after_the_run_and_never_bumps_the_graph_version() {
    let (maze, [a, ..]) = strip();
    let version = maze.graph.version();
    let rule = max_teleports_rule(0, Some(vec![scope(&maze, "zone:1", &[a])]));
    report(&rule, &maze);
    assert!(!maze.graph.scope_active());
    assert_eq!(maze.graph.version(), version);
    assert_eq!(maze.graph.node_count(), 4);
}

#[test]
fn analysis_caches_do_not_leak_between_scopes_or_into_the_full_graph() {
    let (maze, [a, b, c, d]) = strip();
    let full = maze.analysis.scc(&maze.graph).components.len();
    let in_a = maze.with_scope([a].into_iter().collect(), |m| {
        m.analysis.scc(&m.graph).components.len()
    });
    let in_abcd = maze.with_scope([a, b, c, d].into_iter().collect(), |m| {
        m.analysis.scc(&m.graph).components.len()
    });
    assert_eq!(in_a, 1);
    assert_eq!(in_abcd, full);
    assert_eq!(maze.analysis.scc(&maze.graph).components.len(), full);
}

/// A check that always finds an issue, so the strategy always runs.
struct AlwaysIssue;
impl Check<Square, MissingEndpointsIssue> for AlwaysIssue {
    fn check_type_id(&self) -> &'static str {
        "always_issue"
    }
    fn repair_check(
        &self,
        _maze: &Maze<Square>,
        issues: &mut Vec<MissingEndpointsIssue>,
        _rng: &mut dyn rand::RngCore,
        _requirement: (),
    ) {
        issues.push(MissingEndpointsIssue::new_from_check(
            "always_issue",
            true,
            true,
        ));
    }
}

/// A strategy proposing a fixed command list.
struct Propose(Vec<MutationCommand>, bool);
impl RepairStrategy<Square, MissingEndpointsIssue> for Propose {
    fn strategy_id(&self) -> &'static str {
        "propose"
    }
    fn apply(
        &self,
        _: &MissingEndpointsIssue,
        _: &Maze<Square>,
        _: &mut dyn rand::RngCore,
        _: &StrategyParams,
        _: &PresetState,
        _: &[NestedStrategyConfig<Square>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let result = if self.1 {
            RepairResult::Failed
        } else {
            RepairResult::Fixed { score: None }
        };
        (result, self.0.clone())
    }
}

fn repair_once(
    rule: &Rule<Square, MissingEndpointsIssue>,
    maze: &mut Maze<Square>,
) -> RuleIterationOutcome {
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    rule.check_and_repair_typed(
        maze,
        &mut rng,
        &PresetState::empty(),
        &mut HashMap::new(),
        &mut HashMap::new(),
        &|| 0.0,
        None,
        None,
    )
}

fn proposing_rule(
    commands: Vec<MutationCommand>,
    failed: bool,
    scopes: Vec<ScopeCells<Square>>,
) -> Rule<Square, MissingEndpointsIssue> {
    Rule::new(
        "r".to_string(),
        vec![("always_issue".to_string(), Box::new(AlwaysIssue))],
        Some(Box::new(Propose(commands, failed))),
        HashMap::new(),
        vec![],
    )
    .with_scopes(scopes)
}

fn has_passage(maze: &Maze<Square>, from: NodeId, to: NodeId) -> bool {
    maze.graph
        .edges()
        .any(|e| e.kind == EdgeKind::Basic && e.from == from && e.to == to)
}

#[test]
fn a_command_must_be_anchored_in_the_scope_and_a_group_passes_only_whole() {
    let (mut maze, [a, b, c, d]) = strip();
    // The scope is `a` and `b`; a-d leaves it (anchored), c-d lies fully outside.
    let commands = vec![
        MutationCommand::AddBidirectionalEdge { a, b: d },
        MutationCommand::AddBidirectionalEdge { a: c, b: d },
        MutationCommand::Atomic {
            commands: vec![
                MutationCommand::AddBidirectionalEdge { a: b, b: d },
                MutationCommand::AddBidirectionalEdge { a: c, b: d },
            ],
        },
    ];
    let scopes = vec![scope(&maze, "zone:1", &[a, b])];
    let rule = proposing_rule(commands, false, scopes);
    let RuleIterationOutcome::Repaired(_, applied) = repair_once(&rule, &mut maze) else {
        panic!("the rule should have dispatched its strategy");
    };
    assert_eq!((applied.proposed, applied.applied), (3, 1));
    assert!(has_passage(&maze, a, d), "a-d is anchored in the scope");
    assert!(
        !has_passage(&maze, b, d),
        "the group holds a command outside the scope"
    );
}

#[test]
fn the_rule_fails_only_when_every_scope_failed() {
    let (mut maze, [a, b, c, d]) = strip();
    let scopes = |m: &Maze<Square>| vec![scope(m, "zone:1", &[a, b]), scope(m, "zone:2", &[c, d])];
    let failing = proposing_rule(vec![], true, scopes(&maze));
    assert!(matches!(
        repair_once(&failing, &mut maze),
        RuleIterationOutcome::Repaired(RepairResult::Failed, _)
    ));
    let fixing = proposing_rule(vec![], false, scopes(&maze));
    assert!(matches!(
        repair_once(&fixing, &mut maze),
        RuleIterationOutcome::Repaired(RepairResult::Fixed { .. }, _)
    ));
}

#[test]
fn a_rule_with_no_scopes_left_finds_no_issue() {
    let (mut maze, _) = strip();
    let rule = proposing_rule(vec![], false, vec![]);
    assert!(matches!(
        repair_once(&rule, &mut maze),
        RuleIterationOutcome::NoIssue
    ));
}

fn scope_names(
    node: maze_core::event_log::NodeView<'_, maze_core::quality_control::QcEvent>,
    out: &mut Vec<String>,
) {
    for child in node.children() {
        if let maze_core::event_log::NodePayload::Scope(name) = child.payload() {
            out.push(name.to_string());
        }
        scope_names(child, out);
    }
}

#[test]
fn every_scope_runs_in_its_own_event_scope() {
    let (mut maze, [a, b, c, d]) = strip();
    let scopes = vec![
        scope(&maze, "zone:1", &[a, b]),
        scope(&maze, "zone:2", &[c, d]),
    ];
    let rule = proposing_rule(vec![], false, scopes);
    let mut log = maze_core::event_log::EventLog::new();
    {
        let mut guard = log.enter("rule");
        let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
        rule.check_and_repair_typed(
            &mut maze,
            &mut rng,
            &PresetState::empty(),
            &mut HashMap::new(),
            &mut HashMap::new(),
            &|| 0.0,
            Some(&mut guard),
            None,
        );
    }
    let tape = log.finish();
    let mut names = Vec::new();
    scope_names(tape.root(), &mut names);
    let scoped: Vec<&str> = names
        .iter()
        .map(String::as_str)
        .filter(|n| n.starts_with("scope "))
        .collect();
    assert_eq!(scoped, vec!["scope zone:1", "scope zone:2"]);
}

#[test]
fn scoped_listings_cut_split_tiles_and_node_pools_to_the_scope() {
    let (mut maze, [a, b, c, d]) = strip();
    let level = maze.field.level_of(a).unwrap();
    for n in [a, d] {
        let cell = maze.field.cell_of(n).unwrap();
        maze.add_node_at_on_level(level, cell);
    }
    assert_eq!(maze.scoped_split_cells().count(), 2);
    assert_eq!(maze.scoped_node_ids().count(), 6);

    let inner: std::collections::HashSet<NodeId> = maze
        .field
        .nodes_at(level, maze.field.cell_of(a).unwrap())
        .iter()
        .copied()
        .chain([b])
        .collect();
    maze.with_scope(inner.clone(), |m| {
        let cells: Vec<_> = m.scoped_split_cells().collect();
        assert_eq!(cells, vec![(level, m.field.cell_of(a).unwrap())]);
        assert_eq!(
            m.scoped_node_ids()
                .collect::<std::collections::HashSet<_>>(),
            inner
        );
        assert!(m.in_scope_cell(level, m.field.cell_of(b).unwrap()));
        assert!(!m.in_scope_cell(level, m.field.cell_of(c).unwrap()));
    });
    assert_eq!(maze.scoped_split_cells().count(), 2);
}

#[test]
fn a_split_count_check_counts_only_the_split_tiles_of_its_scope() {
    use maze_core::quality_control::{InvalidSplitTileGroupIssue, MaxSplitCountCheck};
    let (mut maze, [a, b, _, d]) = strip();
    let level = maze.field.level_of(a).unwrap();
    for n in [a, d] {
        let cell = maze.field.cell_of(n).unwrap();
        maze.add_node_at_on_level(level, cell);
    }
    let rule = |scopes: Option<Vec<ScopeCells<Square>>>| {
        let check = MaxSplitCountCheck {
            instance_id: "max_split_count".to_string(),
            max_split_count: 1,
        };
        let rule = Rule::<Square, InvalidSplitTileGroupIssue>::new(
            "r".to_string(),
            vec![("max_split_count".to_string(), Box::new(check))],
            None,
            HashMap::new(),
            vec![],
        );
        match scopes {
            Some(scopes) => rule.with_scopes(scopes),
            None => rule,
        }
    };
    // Two split tiles on the whole map: over the limit of one.
    assert_eq!(report(&rule(None), &maze).len(), 1);
    // One of them inside the scope: within the limit.
    let around_a = [a, b];
    assert!(report(&rule(Some(vec![scope(&maze, "zone:1", &around_a)])), &maze).is_empty());
}

#[test]
fn start_distances_and_the_route_ignore_the_raised_scope() {
    let (mut maze, [a, b, c, d]) = strip();
    maze.meta.start = Some(a);
    maze.meta.finish = Some(d);
    let whole = maze
        .analysis
        .distance_from_start(&maze.graph, &maze.meta)
        .unwrap();
    let route = maze
        .analysis
        .route_info(&maze.graph, &maze.field, &maze.meta)
        .unwrap()
        .path;
    // The scope holds the far end only: neither the start nor the finish is inside.
    maze.with_scope([b, c].into_iter().collect(), |m| {
        assert_eq!(
            m.analysis.distance_from_start(&m.graph, &m.meta).unwrap(),
            whole
        );
        assert_eq!(
            m.analysis
                .route_info(&m.graph, &m.field, &m.meta)
                .unwrap()
                .path,
            route
        );
        assert!(
            m.analysis
                .reachable_from_start(&m.graph, &m.meta)
                .unwrap()
                .contains(&d)
        );
        // The scoped nav graph is still the scoped one.
        let nav = m.analysis.nav_graph(&m.graph, &m.meta);
        assert!(nav.nav_node_for(a).is_some() && nav.nav_node_for(d).is_some());
        let rekeyed = m
            .analysis
            .distance_from_start_in(&m.graph, &m.meta, &nav)
            .unwrap();
        assert_eq!(
            rekeyed.get(&nav.nav_node_for(d).unwrap()),
            whole.values().max()
        );
    });
    assert!(!maze.graph.scope_active());
}
