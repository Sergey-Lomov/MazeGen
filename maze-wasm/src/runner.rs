use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use maze_core::{
    graph::Graph,
    space::{Field, Tessellation},
    generation::{generate_maze, generate_maze_with_events, build_preset_state},
};
use crate::generation_config::{GenerateConfig, build_generation_config, build_repair_limits};
use crate::analytics::build_analytics_snapshot;
use crate::result::GenerateResult;

/// Runs the initial (pre-QC/repair) generation pass and returns the generation source's *unmerged*
/// `TapeSource`/event kind/debug-value names (GitHub issue #147 — merging now happens once in
/// `run_generate`, after the QC/repair source is also available, not here), plus the elapsed time
/// for the generation call itself — split out of `run_generate` so this branch-selection/timing
/// logic is testable natively (no `JsValue`/`serde_wasm_bindgen`, which panic outside a real WASM
/// runtime — see GitHub issue #124's `run_initial_generation_tests` below for why `run_generate`
/// itself can't be exercised by `cargo test`).
///
/// QC experiment mode skips the generation algorithm entirely — the graph already holds only
/// preset connections (built by `build_preset_state` before this call), fed straight into
/// `build_maze`'s QC/repair pass. The event tree has nothing to record in this case, so
/// `debug_events` is ignored here rather than erroring.
fn run_initial_generation<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start_id: maze_core::ids::NodeId,
    gen_config: maze_core::generation::GenerationConfig,
    preset_state: &maze_core::generation::PresetState,
    qc_experiment: bool,
    debug_events: bool,
) -> (Option<maze_core::event_log::TapeSource>, Option<maze_core::event_log::EventedEventKind>, Vec<(String, maze_core::event_log::DebugValueKind)>, f64) {
    use maze_core::generation::pipeline::now_ms;

    let initial_build_start = now_ms();
    let (raw_source, event_kind, debug_value_names): (
        Option<maze_core::event_log::TapeSource>,
        Option<maze_core::event_log::EventedEventKind>,
        Vec<(String, maze_core::event_log::DebugValueKind)>,
    ) = if qc_experiment {
        (None, None, Vec::new())
    } else if debug_events {
        let result = generate_maze_with_events(graph, field, seed, start_id, gen_config, preset_state);
        // Only forward this source past the WASM boundary when the web replay engine can
        // actually decode its event kind (GitHub issue #161) — extend `is_web_decodable` once a
        // new event kind gets a web decoder, and that's the only place this list needs to change.
        if is_web_decodable(Some(result.event_kind)) {
            (Some(result.raw_source), Some(result.event_kind), result.debug_value_names)
        } else {
            (None, None, Vec::new())
        }
    } else {
        generate_maze(graph, field, seed, start_id, gen_config, preset_state);
        (None, None, Vec::new())
    };
    let initial_build_ms = now_ms() - initial_build_start;

    (raw_source, event_kind, debug_value_names, initial_build_ms)
}

/// Which [`maze_core::event_log::EventedEventKind`]s the web replay engine (`maze-web/src/debug/
/// eventTape.ts`) can decode today — Recursive Backtracker's, Kruskal's (GitHub issue #146),
/// Wilson's (#145) and `CustomEdgeBased`'s (#144) wire tags. Must stay in sync by hand with the
/// keys registered in `maze-web/src/debug/algorithmRegistry.ts`'s `adapterFor` (GitHub issue
/// #163) — that registry is the web-side source of truth for which kinds have a decoder/apply/
/// narration adapter; no codegen ties the two together across the WASM boundary, so extend both
/// when a new event kind gets a web decoder.
fn is_web_decodable(kind: Option<maze_core::event_log::EventedEventKind>) -> bool {
    matches!(
        kind,
        Some(maze_core::event_log::EventedEventKind::RecursiveBacktracker)
            | Some(maze_core::event_log::EventedEventKind::Kruskal)
            | Some(maze_core::event_log::EventedEventKind::Wilson)
            | Some(maze_core::event_log::EventedEventKind::EdgeBased)
            | Some(maze_core::event_log::EventedEventKind::VertexBased)
            | Some(maze_core::event_log::EventedEventKind::QualityControl)
    )
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;

/// Looks up the field's point at web-space coordinates `(x, y)`, via linear scan over
/// `all_points` (fields are small enough that this stays cheap, and no reverse coordinate index
/// exists) — shared by `run_generate`'s preset-connection, preset-start, and preset-finish lookups
/// so the three don't each repeat the same scan-and-compare.
fn point_at_xy<T: Tessellation>(
    field: &Field<T>,
    point_to_xy: &impl Fn(T::Point) -> (i32, i32),
    x: i32,
    y: i32,
) -> Option<T::Point> {
    field.all_points().find(|&p| point_to_xy(p) == (x, y))
}

pub fn run_generate<T: Tessellation + 'static>(
    seed: u64,
    field: Field<T>,
    start: T::Point,
    config: &GenerateConfig,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<GenerateResult, JsValue> {
    use maze_core::generation::pipeline::build_maze;

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let start_id = field
        .node_at(start)
        .ok_or_else(|| JsValue::from_str("start node not found"))?;

    let gen_config = build_generation_config(config);
    let preset_state = build_preset_state(
        &mut graph, &field,
        &gen_config.preset_connections,
        &gen_config.locked_nodes,
        |x, y| point_at_xy(&field, &point_to_xy, x, y).unwrap_or(start),
    );
    let (generation_source, generation_kind, generation_debug_value_names, initial_build_ms) = run_initial_generation(
        &mut graph, &field, seed, start_id, gen_config, &preset_state, config.qc_experiment, config.debug_events,
    );

    let (qc_engine, check_types) = build_qc_and_repair_with_types::<T>(config)
        .map_err(|e| JsValue::from_str(&e))?;

    let preset_start = config.preset_start
        .and_then(|[sx, sy]| point_at_xy(&field, &point_to_xy, sx, sy))
        .and_then(|p| field.node_at(p));
    let preset_finish = config.preset_finish
        .and_then(|[fx, fy]| point_at_xy(&field, &point_to_xy, fx, fy))
        .and_then(|p| field.node_at(p));

    // QC/repair gets its own `EventLog<QcEvent>` when `debug_events` is on and either generation
    // itself produced a forwardable source to anchor against, or `qc_experiment` mode is active —
    // in that mode generation never runs by design (see `run_initial_generation`'s doc comment),
    // so QC/repair's own tape is the only thing there is to debug, and stands on its own as the
    // sole top-level scope (GitHub issue #173).
    let mut qc_log = (config.debug_events && (generation_source.is_some() || config.qc_experiment))
        .then(maze_core::event_log::EventLog::new);

    // Seed QC's own event log with the preset edges `build_preset_state` already wrote into
    // `graph` above, before handing it to `build_maze` — only in `qc_experiment` mode, where
    // there's no generation-phase tape to establish them (see `QcEvent::PresetSeeded`'s doc
    // comment, GitHub issue #173). One event carries every edge, not one event per edge, so
    // scrubbing a large preset setup costs a single step.
    if config.qc_experiment {
        if let Some(log) = qc_log.as_mut() {
            // One tuple per actual directed graph edge, real `EdgeKind` included (GitHub issue
            // #193's follow-up) — this used to hardcode `false`/no kind at all, so every preset
            // edge (teleport or one-way) replayed in the debug view as a plain bidirectional
            // passage regardless of what it actually was.
            let edges: Vec<(maze_core::ids::NodeId, maze_core::ids::NodeId, maze_core::graph::EdgeKind)> =
                graph.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
            if !edges.is_empty() {
                log.emit(maze_core::quality_control::QcEvent::PresetSeeded { edges });
            }
        }
    }

    let repair_preset_state = preset_state.for_repair(config.qc_experiment);
    let limits = build_repair_limits(config).map_err(|e| JsValue::from_str(&e))?;
    let (mut maze, issues, mut timing) = build_maze(
        field, graph, seed, qc_engine, &repair_preset_state, limits, preset_start, preset_finish,
        qc_log.as_mut(),
    );
    timing.initial_build_ms = initial_build_ms;

    let mut snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &check_types, point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;
    snapshot.timing = Some(timing_to_dto(timing));

    use serde::Serialize;
    let snapshot_js = snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let qc_tape = qc_log.map(|log| log.finish().encode());
    let (debug_tape, debug_value_names, sources) = merge_generation_and_qc_tapes(
        generation_source, generation_kind, generation_debug_value_names, qc_tape,
    );

    Ok(build_generate_result(snapshot_js, debug_tape, debug_value_names, sources))
}

/// Single `merge_tapes` call for the whole pipeline (GitHub issue #147/#169) — folds generation's
/// and QC's independently-produced sources into one merged arena, in execution order (generation
/// always finishes before QC/repair starts). QC's tape is included whenever `qc_log` existed at
/// all (i.e. `debug_events` was on and QC ran) — even a tape with zero mutating events still
/// becomes a (zero-step) "quality_control" scope, since a `DebugTape`'s encoded `node_table` is
/// never actually empty (the log's own root scope node is always present).
///
/// `qc_experiment` mode (GitHub issue #173) never has a `generation_source` (generation is
/// skipped entirely) — QC/repair's tape stands alone as the only top-level scope in that case, so
/// a `qc_experiment` run with zero repair mutations (e.g. an empty field with no preset
/// connections, where no strategy can act on an edgeless graph) still surfaces a debug arena
/// rather than none at all. Split out of `run_generate` (mirrors `build_generate_result`'s own
/// doc comment on why) so this matching logic is testable natively without a WASM runtime.
fn merge_generation_and_qc_tapes(
    generation_source: Option<maze_core::event_log::TapeSource>,
    generation_kind: Option<maze_core::event_log::EventedEventKind>,
    generation_debug_value_names: Vec<(String, maze_core::event_log::DebugValueKind)>,
    qc_tape: Option<maze_core::event_log::EncodedTape>,
) -> (
    Option<maze_core::event_log::EncodedTape>,
    Vec<(String, maze_core::event_log::DebugValueKind)>,
    Vec<(&'static str, maze_core::event_log::EventedEventKind)>,
) {
    let qc_source = qc_tape.map(|tape| maze_core::event_log::TapeSource { scope_name: "quality_control", tape });

    match (generation_source, qc_source) {
        (Some(generation_source), qc_source) => {
            let mut sources_meta = vec![(generation_source.scope_name, generation_kind.expect("generation_source implies generation_kind"))];
            let mut tape_sources = vec![generation_source];
            let mut debug_value_name_sources = vec![("generation", generation_debug_value_names)];

            if let Some(qc_source) = qc_source {
                sources_meta.push(("quality_control", maze_core::event_log::EventedEventKind::QualityControl));
                tape_sources.push(qc_source);
                debug_value_name_sources.push(("quality_control", Vec::new()));
            }

            let merged_tape = maze_core::event_log::merge_tapes(tape_sources);
            let debug_value_name_sources: Vec<(&'static str, Vec<(&str, maze_core::event_log::DebugValueKind)>)> = debug_value_name_sources
                .iter()
                .map(|(scope_name, names)| (*scope_name, names.iter().map(|(name, kind)| (name.as_str(), *kind)).collect()))
                .collect();
            let debug_value_names = maze_core::generation::qualify_debug_value_names(&debug_value_name_sources);
            (Some(merged_tape), debug_value_names, sources_meta)
        }
        (None, Some(qc_source)) => {
            let sources_meta = vec![("quality_control", maze_core::event_log::EventedEventKind::QualityControl)];
            let merged_tape = maze_core::event_log::merge_tapes(vec![qc_source]);
            let debug_value_name_sources: Vec<(&'static str, Vec<(&str, maze_core::event_log::DebugValueKind)>)> = vec![("quality_control", Vec::new())];
            let debug_value_names = maze_core::generation::qualify_debug_value_names(&debug_value_name_sources);
            (Some(merged_tape), debug_value_names, sources_meta)
        }
        (None, None) => (None, Vec::new(), Vec::new()),
    }
}

/// Assembles the final `GenerateResult` from the encoded debug tape buffers — split out of
/// `run_generate` so this small piece of pure matching logic is testable natively. `JsValue`
/// itself doesn't require a real WASM runtime to construct/pass around (only
/// `serde_wasm_bindgen` serialization does, which already happened by the time this is called) —
/// unlike `run_generate` as a whole, this function is exercisable by `cargo test`.
fn build_generate_result(
    snapshot_js: JsValue,
    debug_tape: Option<maze_core::event_log::EncodedTape>,
    debug_value_names: Vec<(String, maze_core::event_log::DebugValueKind)>,
    sources: Vec<(&'static str, maze_core::event_log::EventedEventKind)>,
) -> GenerateResult {
    match debug_tape {
        Some(tape) => {
            assert!(
                !sources.is_empty(),
                "build_generate_result: debug_tape is Some but sources is empty — \
                 run_initial_generation must always produce them together"
            );
            GenerateResult::with_debug_tape(snapshot_js, tape.node_table, tape.payload, debug_value_names, sources)
        }
        None => {
            assert!(
                debug_value_names.is_empty(),
                "build_generate_result: debug_value_names is non-empty but debug_tape is None — \
                 generate_maze_with_events only produces debug value names alongside a tape (see \
                 EventedGenerationResult's tape/debug_value_names pairing); without_debug_tape has \
                 nowhere to carry them, so this would otherwise silently drop them instead of \
                 surfacing the broken invariant"
            );
            assert!(sources.is_empty(), "build_generate_result: sources is non-empty but debug_tape is None");
            GenerateResult::without_debug_tape(snapshot_js)
        }
    }
}

/// Thin wrapper that also returns `check_types` map needed by `build_analytics_snapshot`.
pub fn build_qc_and_repair_with_types<T: Tessellation + 'static>(
    config: &GenerateConfig,
) -> Result<(maze_core::quality_control::QualityControlEngine<T>, HashMap<String, String>), String> {
    use std::collections::HashSet;

    let mut check_types: HashMap<String, String> = HashMap::new();
    for stage_cfg in &config.stages {
        for rule_cfg in &stage_cfg.rules {
            let mut seen_local_ids: HashSet<&str> = HashSet::new();
            for instance in &rule_cfg.checks {
                if seen_local_ids.insert(instance.local_id.as_str()) {
                    let instance_id = format!("{}:{}", rule_cfg.id, instance.local_id);
                    check_types.insert(instance_id, instance.type_id.clone());
                }
            }
        }
    }

    let qc_engine = maze_runner::runner::build_qc_and_repair::<T>(config)?;
    Ok((qc_engine, check_types))
}

fn timing_to_dto(timing: maze_core::GenerationTiming) -> crate::dto::GenerationTimingDto {
    use crate::dto::{GenerationTimingDto, TimingEntryDto};
    let to_dto_map = |map: std::collections::HashMap<&'static str, maze_core::TimingEntry>| {
        map.into_iter()
            .map(|(id, entry)| (id.to_string(), TimingEntryDto { total_ms: entry.total_ms, calls: entry.calls }))
            .collect()
    };
    GenerationTimingDto {
        initial_build_ms: timing.initial_build_ms,
        qc_total_ms: timing.qc_total_ms,
        repair_total_ms: timing.repair_total_ms,
        per_check: to_dto_map(timing.per_check),
        per_strategy: to_dto_map(timing.per_strategy),
    }
}
