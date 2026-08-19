use rand::SeedableRng;
use crate::random::MazeRng;
use crate::{Graph, Maze};
use crate::space::{MultiLevelField, Tessellation};
use crate::event_log::EventLog;
use crate::quality_control::{Issue, QualityControlEngine, QcEvent};
use super::PresetState;

pub const MAX_REPAIR_ITERATIONS: usize = 100;
pub const DEFAULT_REPAIR_TIME_BUDGET_SECS: f64 = 10.0;

/// Caps on the repair fixpoint loop in `build_maze`. Both bounds are optional and independent —
/// whichever is hit first stops the loop. At least one bound must be `Some` — enforced once at
/// construction (`RepairLimits::new`), not re-checked every iteration — since there is no other
/// mechanism left to guarantee the fixpoint loop ever terminates (see GitHub issue #170: the old
/// per-iteration no-progress guard was unreliable and easily defeated, so it was removed rather
/// than kept as a second, partial safety net).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RepairLimits {
    max_iterations: Option<usize>,
    time_budget_secs: Option<f64>,
}

impl RepairLimits {
    /// `Err` if both bounds are `None` — a `RepairLimits` value always guarantees the repair
    /// fixpoint loop terminates.
    pub fn new(max_iterations: Option<usize>, time_budget_secs: Option<f64>) -> Result<Self, String> {
        if max_iterations.is_none() && time_budget_secs.is_none() {
            return Err("RepairLimits requires at least one of max_iterations/time_budget_secs to be set".to_string());
        }
        Ok(RepairLimits { max_iterations, time_budget_secs })
    }

    pub fn max_iterations(&self) -> Option<usize> {
        self.max_iterations
    }

    pub fn time_budget_secs(&self) -> Option<f64> {
        self.time_budget_secs
    }
}

impl Default for RepairLimits {
    fn default() -> Self {
        RepairLimits {
            max_iterations: Some(MAX_REPAIR_ITERATIONS),
            time_budget_secs: Some(DEFAULT_REPAIR_TIME_BUDGET_SECS),
        }
    }
}

/// Milliseconds since an arbitrary epoch — only ever used for measuring elapsed duration within
/// one `build_maze` call, never compared across calls. `std::time::Instant` panics on
/// `wasm32-unknown-unknown` (no syscall backing it), so the wasm target reads `Performance.now()`
/// via `js-sys` instead; native (including `cargo test`) uses the monotonic `Instant` clock.
/// `pub(crate)` (not private) so `maze-wasm`'s `runner.rs` can time the initial `generate_maze`
/// stage with the same clock before calling `build_maze` — see `GenerationTiming::initial_build_ms`.
#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// One check/strategy type's aggregated timing across an entire `build_maze` call (all repair
/// iterations summed) — see GitHub issue #56.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TimingEntry {
    pub total_ms: f64,
    pub calls: u32,
}

/// One node in the hierarchical timing tree — see GitHub issue #285, `Specs/repair.md`'s "Timing
/// Instrumentation" section. `id` is a stage id, rule id, check type id, or strategy id depending
/// on nesting depth; `entry.calls` is `0` for a stage/rule node (a pure time container, never
/// itself "called") and the real dispatch count for a check/strategy leaf.
#[derive(Debug, Clone, Default)]
pub struct TimingNode {
    pub id: String,
    pub entry: TimingEntry,
    pub children: Vec<TimingNode>,
}

impl TimingNode {
    pub fn new(id: impl Into<String>, entry: TimingEntry, children: Vec<TimingNode>) -> Self {
        Self { id: id.into(), entry, children }
    }
}

/// Hierarchical timing breakdown for one `build_maze` call — see GitHub issue #285.
/// `initial_build_ms` is left at `0.0` by `build_maze` itself (it only runs QC/repair, not the
/// initial `generate_maze` stage) — `maze-wasm::run_generate` fills it in after the fact, since
/// it's the only caller that also runs `generate_maze` before `build_maze`. `qc` is fully
/// populated by `build_maze`: one child `TimingNode` per stage, each holding one child per rule,
/// each rule holding its checks' and (if any) its strategy's own leaf nodes.
#[derive(Debug, Clone, Default)]
pub struct GenerationTiming {
    pub initial_build_ms: f64,
    pub qc: Vec<TimingNode>,
}

/// Runs the full check+repair process on an already-generated graph — see GitHub issue #106.
/// `qc_engine` is the single orchestrator: it drives its own stages, each stage its own rules,
/// each rule its own checks and strategy. This function itself is now just plumbing: construct
/// `Maze`, seed the shared `MazeRng`, delegate to `qc_engine.run_full`.
pub fn build_maze<T: Tessellation>(
    field: MultiLevelField<T>,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<T>,
    preset_state: &PresetState,
    limits: RepairLimits,
    preset_start: Option<crate::ids::NodeId>,
    preset_finish: Option<crate::ids::NodeId>,
    event_log: Option<&mut EventLog<QcEvent>>,
    debug_state: Option<&mut super::DebugGenerationState<T>>,
) -> (Maze<T>, Vec<Box<dyn Issue>>, GenerationTiming) {
    let mut maze = Maze::new(field, graph);
    maze.meta.start = preset_start;
    maze.meta.finish = preset_finish;
    let mut rng = MazeRng::seed_from_u64(seed);
    let (issues, timing) = qc_engine.run_full(&mut maze, &mut rng, preset_state, limits, now_ms, event_log, debug_state);

    // DIAG
    {
        let groups = crate::quality_control::checks::elevator_core::elevator_groups(&maze);
        for (i, g) in groups.iter().enumerate() {
            let mut floors: Vec<usize> = g.stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
            floors.sort_unstable();
            crate::diag_log!("elevator[{i}] floors={floors:?}"); // DIAG
        }
    }

    (maze, issues, timing)
}
