use std::collections::HashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::{Graph, Maze};
use crate::space::{Field, Tessellation};
use crate::quality_control::{Issue, QualityControlEngine};
use super::PresetState;

pub const MAX_REPAIR_ITERATIONS: usize = 10;

/// Caps on the repair fixpoint loop in `build_maze`. Both bounds are optional and independent —
/// whichever is hit first stops the loop. `None` for both means the loop only stops on
/// convergence (no active issues) or no-progress, with no hard cap; callers surfacing this to
/// users should treat "both None" as worth flagging, since an unconverging rule set can then loop
/// indefinitely.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RepairLimits {
    pub max_iterations: Option<usize>,
    pub time_budget_secs: Option<f64>,
}

impl Default for RepairLimits {
    fn default() -> Self {
        RepairLimits { max_iterations: Some(MAX_REPAIR_ITERATIONS), time_budget_secs: None }
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

/// Per-stage and per-check/per-strategy timing breakdown for one `build_maze` call — see GitHub
/// issue #56. `initial_build_ms` is left at `0.0` by `build_maze` itself (it only runs QC/repair,
/// not the initial `generate_maze` stage) — `maze-wasm::run_generate` fills it in after the fact,
/// since it's the only caller that also runs `generate_maze` before `build_maze`. Every other
/// field is fully populated by `build_maze`.
#[derive(Debug, Clone, Default)]
pub struct GenerationTiming {
    pub initial_build_ms: f64,
    pub qc_total_ms: f64,
    pub repair_total_ms: f64,
    pub per_check: HashMap<&'static str, TimingEntry>,
    pub per_strategy: HashMap<&'static str, TimingEntry>,
}

/// Runs the full check+repair process on an already-generated graph — see GitHub issue #106.
/// `qc_engine` is the single orchestrator: it drives its own stages, each stage its own rules,
/// each rule its own checks and strategy. This function itself is now just plumbing: construct
/// `Maze`, seed the shared `MazeRng`, delegate to `qc_engine.run_full`.
pub fn build_maze<T: Tessellation>(
    field: Field<T>,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<T>,
    preset_state: &PresetState,
    limits: RepairLimits,
    preset_start: Option<crate::ids::NodeId>,
    preset_finish: Option<crate::ids::NodeId>,
) -> (Maze<T>, Vec<Box<dyn Issue>>, GenerationTiming) {
    let mut maze = Maze::new(field, graph);
    maze.meta.start = preset_start;
    maze.meta.finish = preset_finish;
    let mut rng = MazeRng::seed_from_u64(seed);
    let (issues, timing) = qc_engine.run_full(&mut maze, &mut rng, preset_state, limits, now_ms);
    (maze, issues, timing)
}
