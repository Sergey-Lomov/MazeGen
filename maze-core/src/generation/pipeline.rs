use std::collections::HashSet;
use std::fmt;
use rand::SeedableRng;
use rand::rngs::SmallRng;
use crate::{Graph, Maze};
use crate::space::Field;
use crate::quality_control::{IssueKind, QualityControlEngine};
use crate::repair::{RepairEngine, RepairResult};

pub const MAX_REPAIR_ITERATIONS: usize = 8;

#[derive(Debug)]
pub enum PipelineError {
    UnresolvedIssues(Vec<crate::quality_control::Issue>),
}

impl fmt::Display for PipelineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PipelineError::UnresolvedIssues(issues) => {
                let kinds: Vec<_> = issues.iter().map(|i| i.kind).collect();
                write!(f, "unresolved issues: {}", kinds.join(", "))
            }
        }
    }
}

impl std::error::Error for PipelineError {}

pub fn build_maze<F: Field>(
    field: F,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<F>,
    repair_engine: RepairEngine<F>,
) -> (Maze<F>, Vec<crate::quality_control::Issue>) {
    let mut maze = Maze::new(field, graph);
    let mut rng = SmallRng::seed_from_u64(seed);
    let mut failed: HashSet<IssueKind> = HashSet::new();
    let mut previous_fingerprint: Option<Vec<IssueKind>> = None;

    for _ in 0..MAX_REPAIR_ITERATIONS {
        let issues = qc_engine.run(&maze);
        let mut seen_kinds: HashSet<IssueKind> = HashSet::new();
        let active: Vec<_> = issues.into_iter()
            .filter(|i| seen_kinds.insert(i.kind) && !failed.contains(i.kind))
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

        let results = repair_engine.run(&active, &mut maze, &mut rng);
        for (kind, result) in results {
            if matches!(result, RepairResult::Failed) {
                failed.insert(kind);
            }
        }
    }

    let remaining = qc_engine.run(&maze);
    (maze, remaining)
}
