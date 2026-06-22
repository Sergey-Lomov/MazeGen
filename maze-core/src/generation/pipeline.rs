use std::collections::HashSet;
use rand::SeedableRng;
use rand::rngs::SmallRng;
use crate::{Graph, Maze};
use crate::space::{Field, Tessellation};
use crate::quality_control::{IssueKind, QualityControlEngine};
use crate::repair::{RepairEngine, RepairResult};
use super::PresetState;

pub const MAX_REPAIR_ITERATIONS: usize = 8;

pub fn build_maze<T: Tessellation>(
    field: Field<T>,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<T>,
    repair_engine: RepairEngine<T>,
    preset_state: &PresetState,
) -> (Maze<T>, Vec<crate::quality_control::Issue>) {
    let mut maze = Maze::new(field, graph);
    let mut rng = SmallRng::seed_from_u64(seed);
    let mut failed: HashSet<IssueKind> = HashSet::new();
    let mut previous_fingerprint: Option<Vec<IssueKind>> = None;

    for _ in 0..MAX_REPAIR_ITERATIONS {
        let issues = qc_engine.run(&maze);
        let mut seen_kinds: HashSet<IssueKind> = HashSet::new();
        let active: Vec<_> = issues.into_iter()
            .filter(|i| {
                let is_new = seen_kinds.insert(i.kind);
                debug_assert!(is_new || i.data.is_none(),
                    "dropping Issue::data for duplicate kind {:?} in QC dedup", i.kind);
                is_new && !failed.contains(&i.kind)
            })
            .collect();
        if active.is_empty() {
            break;
        }
        let mut fingerprint: Vec<IssueKind> = active.iter().map(|i| i.kind).collect();
        fingerprint.sort_unstable();
        if Some(&fingerprint) == previous_fingerprint.as_ref() {
            break;
        }
        previous_fingerprint = Some(fingerprint);

        let results = repair_engine.run(&active, &mut maze, &mut rng, preset_state);
        for (kind, result) in &results {
            match result {
                RepairResult::Failed => { failed.insert(*kind); }
                RepairResult::Fixed { score: Some(s) } => {
                    if maze.meta.route_score.is_none() {
                        maze.meta.route_score = Some(*s);
                    }
                }
                RepairResult::Fixed { score: None } => {}
            }
        }
    }

    let remaining = qc_engine.run(&maze);
    (maze, remaining)
}
