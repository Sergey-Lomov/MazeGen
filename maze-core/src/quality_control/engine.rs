use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use super::check::Check;
use super::issue::Issue;

pub struct QualityControlEngine<T: Tessellation> {
    checks: Vec<Box<dyn Check<T>>>,
}

impl<T: Tessellation> QualityControlEngine<T> {
    pub fn new(checks: Vec<Box<dyn Check<T>>>) -> Self {
        Self { checks }
    }

    pub fn run(&self, maze: &Maze<T>, rng: &mut dyn RngCore) -> Vec<Issue> {
        let mut issues = Vec::new();
        for check in &self.checks {
            check.repair_check(maze, &mut issues, rng);
        }
        issues
    }

    /// Same as `run`, but also times each `Check::repair_check` call, accumulating elapsed
    /// milliseconds and call count per `check_type_id` into `timing` — used by `build_maze`'s
    /// repair loop to collect per-check timing analytics (see GitHub issue #56). Kept as a
    /// separate method rather than a parameter on `run` so every other caller (analytics-only
    /// QC passes with no timing interest, e.g. `build_analytics_snapshot`) is unaffected.
    pub fn run_timed(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: impl Fn() -> f64,
    ) -> Vec<Issue> {
        let mut issues = Vec::new();
        for check in &self.checks {
            let start = now_ms();
            check.repair_check(maze, &mut issues, rng);
            let elapsed = now_ms() - start;
            let entry = timing.entry(check.check_type_id()).or_insert((0.0, 0));
            entry.0 += elapsed;
            entry.1 += 1;
        }
        issues
    }

    /// Same as `run_timed`, but collects via `Check::report_check` instead of
    /// `Check::repair_check` — one `Issue` per flagged problem instance rather than one merged
    /// `Issue` per check call. Used for the final post-fixpoint QC pass (`build_maze`'s
    /// `remaining`), not the fixpoint loop's own iterations, which stay on
    /// `run_timed`/`repair_check`. See GitHub issue #102.
    pub fn run_report_timed(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: impl Fn() -> f64,
    ) -> Vec<Issue> {
        let mut issues = Vec::new();
        for check in &self.checks {
            let start = now_ms();
            let mut check_issues = check.report_check(maze, rng);
            let elapsed = now_ms() - start;
            let entry = timing.entry(check.check_type_id()).or_insert((0.0, 0));
            entry.0 += elapsed;
            entry.1 += 1;
            issues.append(&mut check_issues);
        }
        issues
    }
}
