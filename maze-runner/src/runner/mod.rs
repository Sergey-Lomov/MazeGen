pub(crate) mod check_factory;
pub mod field_ops;
pub mod geometry;
pub mod prepare;
pub(crate) mod qc_kind_registry;
pub(crate) mod rule_factory;
pub(crate) mod rule_params;
pub mod stages;
pub(crate) mod strategy_factory;
pub mod tessellation_factory;
#[cfg(test)]
mod tests;
pub mod topology_edit;

use crate::config::{GenerateConfig, PresetEndpointDto};
use maze_core::{
    GenerationTiming, RegionClass,
    event_log::{DebugTape, EventLog},
    generation::{PresetEndpoint, resolve_generation_start},
    graph::Graph,
    quality_control::{Issue, QcEvent},
    space::Tessellation,
};
use prepare::{Prepared, PreparedVisitor, dispatch};
use stages::{Repaired, run_generation, run_repair, seed_graph};
use std::collections::HashMap;

pub use rule_factory::{build_check_types, build_qc_and_repair};

/// Result of a single `run_from_config` call — everything a test might want to inspect.
pub struct MazeRunResult {
    pub remaining_issues: Vec<Box<dyn Issue>>,
    pub timing: GenerationTiming,
    /// Region classes → sorted sizes (descending). Key absent if count = 0.
    pub region_sizes: HashMap<RegionClass, Vec<usize>>,
    pub start: Option<maze_core::ids::NodeId>,
    pub finish: Option<maze_core::ids::NodeId>,
    /// Final graph, post-repair — lets a repro test inspect actual edge kinds/directionality
    /// (e.g. verifying a one-way vs. bidirectional connection was actually chosen), which none
    /// of the other summary fields expose.
    pub graph: Graph,
    /// QC/repair narration-level debug event tape (GitHub issue #147) — `Some` exactly when
    /// `config.debug_events` is set, `None` otherwise. Generation itself isn't instrumented here
    /// (`maze-runner` calls the plain `generate_maze`, not `generate_maze_with_events` — no
    /// browser-repro test needs to inspect generation's own narration, only QC's), so this is a
    /// standalone, unmerged `QcEvent` tape rather than a multi-source merged one like
    /// `maze-wasm::run_generate` produces.
    pub qc_tape: Option<DebugTape<QcEvent>>,
}

/// Resolves the geometric fallback start point (GitHub issue #640) — a pin matching
/// `gen_source_xy` wins if present, otherwise falls back to `mode` (default centroid-nearest, or
/// seeded-random). Thin wrapper over `maze_core::generation::resolve_generation_start` that keeps
/// this crate's coordinate-match pin lookup, matching `maze-wasm::tessellation_dispatch`'s
/// equivalent wrapper.
pub fn resolve_start<P: Copy>(
    pts: &[P],
    gen_source_xy: Option<[i32; 2]>,
    mode: maze_core::generation::GenerationSourceMode,
    seed: u64,
    to_xy: impl Fn(P) -> (i32, i32),
) -> P {
    let pinned =
        gen_source_xy.and_then(|[px, py]| pts.iter().copied().find(|&p| to_xy(p) == (px, py)));
    resolve_generation_start(pts, pinned, mode, seed, to_xy)
}

fn preset_endpoint_dto_to_core(dto: &PresetEndpointDto) -> PresetEndpoint {
    PresetEndpoint {
        point: (dto.point[0], dto.point[1]),
        slot: dto.slot,
        level: dto.level,
    }
}

/// Full generation+repair run for one concrete tessellation — `run_from_config`'s visitor.
struct FullRun<'a> {
    config: &'a GenerateConfig,
}

impl PreparedVisitor for FullRun<'_> {
    type Output = MazeRunResult;

    fn visit<T: Tessellation>(self, prepared: Prepared<T>) -> Result<MazeRunResult, String> {
        let config = self.config;
        let mut seeded = seed_graph(prepared, config)?;
        let start_reassignment = run_generation(&mut seeded, config);
        let mut qc_log = config.debug_events.then(EventLog::new);
        let Repaired {
            maze,
            remaining_issues,
            timing,
            ..
        } = run_repair(seeded, config, start_reassignment, qc_log.as_mut())?;
        let qc_tape = qc_log.map(EventLog::finish);

        let start_node = maze.meta.start;
        let finish_node = maze.meta.finish;
        let mut region_sizes: HashMap<RegionClass, Vec<usize>> = HashMap::new();

        if start_node.is_some() && finish_node.is_some() {
            let scc = maze.analysis.scc(&maze.graph);
            let classes = maze
                .analysis
                .region_classes(&maze.graph, &maze.field, &maze.meta);
            for (&comp_id, &cls) in &classes {
                region_sizes
                    .entry(cls)
                    .or_default()
                    .push(scc.components[comp_id].len());
            }
            for sizes in region_sizes.values_mut() {
                sizes.sort_unstable_by(|a, b| b.cmp(a));
            }
        }

        Ok(MazeRunResult {
            remaining_issues,
            timing,
            region_sizes,
            start: start_node,
            finish: finish_node,
            graph: maze.graph.clone(),
            qc_tape,
        })
    }
}

/// Parse JSON config and run the full generation+repair pipeline for the given seed.
/// Use this as the entry point in all integration tests.
pub fn run_from_config(seed: u64, config: &GenerateConfig) -> Result<MazeRunResult, String> {
    dispatch(seed, config, FullRun { config })
}

/// Load JSON fixture file and run `run_from_config`.
/// `path` is relative to the crate root (e.g. `"tests/fixtures/my-config.json"`).
pub fn run_fixture(path: &str, seed: u64) -> MazeRunResult {
    let json = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read fixture {path}: {e}"));
    let config: GenerateConfig = serde_json::from_str(&json)
        .unwrap_or_else(|e| panic!("failed to parse fixture {path}: {e}"));
    run_from_config(seed, &config)
        .unwrap_or_else(|e| panic!("run_from_config failed for {path}: {e}"))
}
