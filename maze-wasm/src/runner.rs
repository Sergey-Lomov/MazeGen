use crate::analytics::build_analytics_snapshot;
use crate::analytics::score_weights_from_stages;
use crate::generation_config::{GenerateConfig, build_generation_config, build_repair_limits};
use crate::result::GenerateResult;
use maze_core::{
    generation::{PresetEndpoint, build_preset_state, generate_maze, generate_maze_with_events},
    graph::Graph,
    ids::IdGenerator,
    space::{MultiLevelField, Tessellation},
};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

/// `run_initial_generation`'s result: the generation source's unmerged `TapeSource`/event kind/
/// debug-value names, elapsed generation time, start reassignment (if any), and every node's
/// resolved point — see the function's own doc comment.
/// `merge_debug_sources`'s result: the merged encoded tape, its debug-value names, and its
/// per-source event-kind metadata list.
type MergedDebugSources = (
    Option<maze_core::event_log::EncodedTape>,
    Vec<(String, maze_core::event_log::DebugValueKind)>,
    Vec<(&'static str, maze_core::event_log::EventedEventKind)>,
);

type InitialGenerationResult<T> = (
    Option<maze_core::event_log::TapeSource>,
    Option<maze_core::event_log::EventedEventKind>,
    Vec<(String, maze_core::event_log::DebugValueKind)>,
    f64,
    Option<maze_core::generation::StartReassignment>,
    Vec<(maze_core::ids::NodeId, <T as Tessellation>::CellId)>,
);

fn preset_endpoint_dto_to_core(dto: &maze_runner::config::PresetEndpointDto) -> PresetEndpoint {
    PresetEndpoint {
        point: (dto.point[0], dto.point[1]),
        slot: dto.slot,
        level: dto.level,
    }
}

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
#[allow(clippy::too_many_arguments)]
fn run_initial_generation<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    seed: u64,
    start_id: maze_core::ids::NodeId,
    gen_config: maze_core::generation::GenerationConfig,
    preset_state: &maze_core::generation::PresetState,
    qc_experiment: bool,
    debug_events: bool,
) -> InitialGenerationResult<T> {
    use maze_core::generation::pipeline::now_ms;

    type InitialSourceParts<T> = (
        Option<maze_core::event_log::TapeSource>,
        Option<maze_core::event_log::EventedEventKind>,
        Vec<(String, maze_core::event_log::DebugValueKind)>,
        Option<maze_core::generation::StartReassignment>,
        Vec<(maze_core::ids::NodeId, <T as Tessellation>::CellId)>,
    );

    let initial_build_start = now_ms();
    let (raw_source, event_kind, debug_value_names, start_reassignment, all_node_points): InitialSourceParts<T> = if qc_experiment {
        (None, None, Vec::new(), None, Vec::new())
    } else if debug_events {
        let result =
            generate_maze_with_events(graph, field, ids, seed, start_id, gen_config, preset_state);
        // Only forward this source past the WASM boundary when the web replay engine can
        // actually decode its event kind (GitHub issue #161) — extend `is_web_decodable` once a
        // new event kind gets a web decoder, and that's the only place this list needs to change.
        if is_web_decodable(Some(result.event_kind)) {
            (
                Some(result.raw_source),
                Some(result.event_kind),
                result.debug_value_names,
                result.start_reassignment,
                result.all_node_points,
            )
        } else {
            (
                None,
                None,
                Vec::new(),
                result.start_reassignment,
                Vec::new(),
            )
        }
    } else {
        let start_reassignment =
            generate_maze(graph, field, ids, seed, start_id, gen_config, preset_state);
        (None, None, Vec::new(), start_reassignment, Vec::new())
    };
    let initial_build_ms = now_ms() - initial_build_start;

    (
        raw_source,
        event_kind,
        debug_value_names,
        initial_build_ms,
        start_reassignment,
        all_node_points,
    )
}

/// Which [`maze_core::event_log::EventedEventKind`]s the web replay engine (`maze-web/src/debug/
/// eventTape.ts`) can decode today — the preset setup source's (GitHub issue #225), Recursive
/// Backtracker's, Kruskal's (GitHub issue #146), and Wilson's (#145) wire tags. Must stay in sync by hand with the
/// keys registered in `maze-web/src/debug/algorithmRegistry.ts`'s `adapterFor` (GitHub issue
/// #163) — that registry is the web-side source of truth for which kinds have a decoder/apply/
/// narration adapter; no codegen ties the two together across the WASM boundary, so extend both
/// when a new event kind gets a web decoder.
fn is_web_decodable(kind: Option<maze_core::event_log::EventedEventKind>) -> bool {
    matches!(
        kind,
        Some(maze_core::event_log::EventedEventKind::PresetSetup)
            | Some(maze_core::event_log::EventedEventKind::RecursiveBacktracker)
            | Some(maze_core::event_log::EventedEventKind::Kruskal)
            | Some(maze_core::event_log::EventedEventKind::Wilson)
            | Some(maze_core::event_log::EventedEventKind::VertexBased)
            | Some(maze_core::event_log::EventedEventKind::QualityControl)
    )
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;

pub fn run_generate<T: Tessellation + 'static>(
    seed: u64,
    mut field: MultiLevelField<T>,
    mut ids: IdGenerator,
    start: T::CellId,
    config: &GenerateConfig,
    cell_to_xy: impl Fn(T::CellId) -> (i32, i32),
    cell_from_xy: impl Fn(i32, i32) -> T::CellId,
) -> Result<GenerateResult, JsValue> {
    use maze_core::generation::pipeline::build_maze;

    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }

    let gen_config = build_generation_config(config);

    // Validates split patterns (GitHub issue #222) before generation runs — this is the
    // browser-facing path native `maze-runner`'s own regression tests never exercise, so it needs
    // the same check `run_generate_typed` runs, via the shared `validate_split_patterns`.
    maze_core::generation::validate_split_patterns(
        &gen_config.split_generation.patterns,
        field.tessellation(),
    )
    .map_err(|e| JsValue::from_str(&e))?;

    // The "preset setup" source (GitHub issue #225) — one event per preset connection that
    // actually establishes an edge, narrated inline by `build_preset_state` itself (it's the only
    // place that still has each connection's resolved from/to/direction) rather than reconstructed
    // from the graph afterward. Independent of which algorithm runs or whether `qc_experiment`
    // skips generation entirely. Always the first source when present — see `merge_debug_sources`
    // below.
    // Ledger of every node minted during this run, including ones later removed/replaced by
    // QC/repair (GitHub issue #271) — only populated when `debug_events` is on. Fed by preset
    // split-point minting (`build_preset_state`, below), `CustomVertexBased`'s pattern-mode split
    // (`run_initial_generation`'s `all_node_points`), and QC/repair's own mint/removal
    // (`build_maze`, further below) — the union is what lets the debug tape resolve coordinates
    // for a node no longer present in the final `Field`.
    let mut debug_node_ledger = config
        .debug_events
        .then(maze_core::generation::DebugGenerationState::<T>::new);

    let mut preset_setup_log = config
        .debug_events
        .then(maze_core::event_log::EventLog::new);
    let mut preset_state = build_preset_state(
        &mut graph,
        &mut field,
        &mut ids,
        &gen_config.preset_connections,
        &gen_config.preset_vertical_passages,
        &gen_config.preset_elevators,
        &gen_config.locked_nodes,
        &gen_config.split_points,
        &cell_from_xy,
        preset_setup_log.as_mut(),
        debug_node_ledger.as_mut(),
    )
    .map_err(|e| JsValue::from_str(&e))?;
    let preset_setup_source = preset_setup_log.filter(|log| !log.is_empty()).map(|log| {
        maze_core::event_log::TapeSource {
            scope_name: maze_core::generation::PRESET_SETUP_SCOPE_NAME,
            tape: log.finish().encode(),
        }
    });

    // `start_id` prefers a resolved `preset_gen_source` marker (possibly slot-addressed, GitHub
    // issue #231) over the plain geometric `start` `tessellation_dispatch`'s `resolve_start`
    // already chose (default centroid-nearest or seeded-random per `generation_source_mode`,
    // GitHub issue #640) — mirrors `maze-runner`'s `run_generate_typed`.
    let level = field.single_level_id();
    let start_id = config
        .preset_gen_source
        .as_ref()
        .and_then(|dto| {
            preset_state.resolve_endpoint(&field, &cell_from_xy, preset_endpoint_dto_to_core(dto))
        })
        .or_else(|| field.nodes_at(level, start).first().copied())
        .ok_or_else(|| JsValue::from_str("start node not found"))?;

    let (
        generation_source,
        generation_kind,
        generation_debug_value_names,
        initial_build_ms,
        start_reassignment,
        generation_node_points,
    ) = run_initial_generation(
        &mut graph,
        &mut field,
        &mut ids,
        seed,
        start_id,
        gen_config,
        &preset_state,
        config.qc_experiment,
        config.debug_events,
    );
    if let Some(ledger) = debug_node_ledger.as_mut() {
        for (id, point) in generation_node_points {
            ledger.note(id, point);
        }
    }

    let (qc_engine, check_types) =
        build_qc_and_repair_with_types::<T>(config).map_err(|e| JsValue::from_str(&e))?;

    // The node each explicit `preset_start`/`preset_finish` marker resolves to, if any — the
    // user's pinned choice, distinct from a generator-chosen endpoint. Recorded on `PresetState`
    // so the issue-payload resolver can flag a pinned `start`/`finish` element `preset_locked`
    // (GitHub issue #376 follow-up).
    let pinned_start = config.preset_start.as_ref().and_then(|dto| {
        preset_state.resolve_endpoint(&field, &cell_from_xy, preset_endpoint_dto_to_core(dto))
    });
    let pinned_finish = config.preset_finish.as_ref().and_then(|dto| {
        preset_state.resolve_endpoint(&field, &cell_from_xy, preset_endpoint_dto_to_core(dto))
    });
    preset_state.preset_start = pinned_start;
    preset_state.preset_finish = pinned_finish;

    // A split hit on the traversal-seed node reassigns `start_id` mid-run (GitHub issue #222) —
    // only honored when there's no explicit `preset_start` pinning a human's fixed choice.
    let preset_start = pinned_start.or_else(|| start_reassignment.map(|r| r.reassigned_to));
    let preset_finish = pinned_finish;

    // QC/repair gets its own `EventLog<QcEvent>` when `debug_events` is on and there is at least
    // one other source to anchor against (generation, or the preset setup source) or
    // `qc_experiment` mode is active — in that mode generation never runs by design (see
    // `run_initial_generation`'s doc comment), so QC/repair's own tape is the only per-run thing
    // left to debug, standing on its own (alongside preset setup, if any) as a top-level scope
    // (GitHub issue #173).
    let mut qc_log = (config.debug_events
        && (generation_source.is_some() || preset_setup_source.is_some() || config.qc_experiment))
        .then(maze_core::event_log::EventLog::new);

    // Seed QC's own event log with the preset start/finish `build_maze` is about to write straight
    // into `maze.meta` (`pipeline.rs`'s `maze.meta.start/finish = preset_start/preset_finish`) —
    // that assignment never goes through a `RepairCommand`/`MutationCommand::SetStart`/`SetFinish`,
    // so no `StartSet`/`FinishSet` event exists for the web replay engine to reconstruct from
    // otherwise (GitHub issue #192). Reuses the same `StartSet`/`FinishSet` wire tags an endpoint
    // repair strategy's own `SetStart`/`SetFinish` command produces — the web side already folds
    // both into `DebugMazeView.start`/`finish` (`debugSelectors.ts`'s `qcContribution`) with no
    // further changes needed. Emitted only when the preset actually resolved to a node id — an
    // absent preset must leave the replay's start/finish at `null`, same as `build_maze` leaving
    // `maze.meta.start`/`finish` at `None`.
    if let Some(log) = qc_log.as_mut() {
        if let Some(id) = preset_start {
            log.emit(maze_core::quality_control::QcEvent::StartSet(id));
        }
        if let Some(id) = preset_finish {
            log.emit(maze_core::quality_control::QcEvent::FinishSet(id));
        }
    }

    let repair_preset_state = preset_state.for_repair(config.qc_experiment);
    let limits = build_repair_limits(config).map_err(|e| JsValue::from_str(&e))?;
    let (mut maze, issues, mut timing) = build_maze(
        field,
        graph,
        seed,
        qc_engine,
        &repair_preset_state,
        limits,
        preset_start,
        preset_finish,
        qc_log.as_mut(),
        debug_node_ledger.as_mut(),
    );
    timing.initial_build_ms = initial_build_ms;

    // Fresh generation has no removal history yet — a node's position within `nodes_at(point)`
    // already equals its real `i` (GitHub issue #236, `NodeDto.i` doc comment).
    // Timed separately from `build_maze`'s own QC/repair tree (GitHub issue #414) — this call's
    // `graph_analytics`/`nav_graph` computation (cycle enumeration on the final graph) runs
    // entirely outside the QC pipeline and was previously invisible in the reported total.
    let snapshot_start = maze_core::generation::pipeline::now_ms();
    let score_weights = score_weights_from_stages(&config.stages);
    let mut snapshot = build_analytics_snapshot(
        &mut maze,
        None,
        Some(issues),
        &check_types,
        &repair_preset_state,
        &cell_to_xy,
        |_, _, pos| pos as u32,
        score_weights.as_ref(),
    )
    .map_err(|e| JsValue::from_str(&e))?;
    timing.snapshot_ms = maze_core::generation::pipeline::now_ms() - snapshot_start;
    snapshot.timing = Some(timing_to_dto(timing));

    // Union coordinate set (GitHub issue #271) — every node that ever existed during this run,
    // including ones removed/replaced by QC/repair. Built only when `debug_events` produced a
    // ledger; separate from `snapshot.nodes` (final survivors only), which stays untouched since
    // the live UI/canvas rendering depends on it only ever listing currently-live nodes.
    // `level`: resolved against the still-live `maze.field` when possible (GitHub issue #337) —
    // a node QC/repair already removed no longer has a level there, so it falls back to `0`. The
    // ledger itself doesn't track level per node (it only ever recorded points), so a removed
    // multi-floor node's debug-tree floor can't be recovered here; this only matters for nodes
    // that existed briefly during generation and were pruned before the run ended.
    let debug_all_nodes: Vec<crate::dto::NodeDto> = debug_node_ledger
        .map(|ledger| {
            ledger
                .all_node_points()
                .filter_map(|(id, point)| {
                    let id32 = u32::try_from(id).ok()?;
                    let (x, y) = cell_to_xy(point);
                    let level = maze.field.level_index_of(id).unwrap_or(0) as u32;
                    Some(crate::dto::NodeDto {
                        id: id32,
                        x,
                        y,
                        i: 0,
                        level,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    use serde::Serialize;
    let snapshot_js = snapshot
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let debug_all_nodes_js = debug_all_nodes
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let qc_tape = qc_log.map(|log| log.finish().encode());
    let (debug_tape, debug_value_names, sources) = merge_debug_sources(
        preset_setup_source,
        generation_source,
        generation_kind,
        generation_debug_value_names,
        qc_tape,
    );

    Ok(build_generate_result(
        snapshot_js,
        debug_tape,
        debug_value_names,
        sources,
        debug_all_nodes_js,
    ))
}

/// Single `merge_tapes` call for the whole pipeline (GitHub issue #147/#169, extended by #225's
/// "preset setup" source) — folds preset setup's, generation's, and QC's independently-produced
/// sources into one merged arena, in execution order (preset setup always happens first, then
/// generation, then QC/repair). QC's tape is included whenever `qc_log` existed at all (i.e.
/// `debug_events` was on and QC ran) — even a tape with zero mutating events still becomes a
/// (zero-step) "quality_control" scope, since a `DebugTape`'s encoded `node_table` is never
/// actually empty (the log's own root scope node is always present).
///
/// Every source is independently optional: preset setup is absent for a preset-free run;
/// `qc_experiment` mode (GitHub issue #173) never has a generation source (generation is skipped
/// entirely by design); QC/repair's own log only exists when at least one other source anchors it
/// or `qc_experiment` is active. `sources` (and the merged tape's top-level scopes) always list
/// whichever ones are present in this fixed order — no combination of present/absent sources
/// reorders them. Split out of `run_generate` (mirrors `build_generate_result`'s own doc comment
/// on why) so this matching logic is testable natively without a WASM runtime.
fn merge_debug_sources(
    preset_setup_source: Option<maze_core::event_log::TapeSource>,
    generation_source: Option<maze_core::event_log::TapeSource>,
    generation_kind: Option<maze_core::event_log::EventedEventKind>,
    generation_debug_value_names: Vec<(String, maze_core::event_log::DebugValueKind)>,
    qc_tape: Option<maze_core::event_log::EncodedTape>,
) -> MergedDebugSources {
    let qc_source = qc_tape.map(|tape| maze_core::event_log::TapeSource {
        scope_name: "quality_control",
        tape,
    });

    let mut sources_meta: Vec<(&'static str, maze_core::event_log::EventedEventKind)> = Vec::new();
    let mut tape_sources: Vec<maze_core::event_log::TapeSource> = Vec::new();
    let mut debug_value_name_sources: Vec<(
        &'static str,
        Vec<(String, maze_core::event_log::DebugValueKind)>,
    )> = Vec::new();

    if let Some(preset_setup_source) = preset_setup_source {
        sources_meta.push((
            preset_setup_source.scope_name,
            maze_core::event_log::EventedEventKind::PresetSetup,
        ));
        tape_sources.push(preset_setup_source);
        debug_value_name_sources.push(("preset_setup", Vec::new()));
    }
    if let Some(generation_source) = generation_source {
        sources_meta.push((
            generation_source.scope_name,
            generation_kind.expect("generation_source implies generation_kind"),
        ));
        tape_sources.push(generation_source);
        debug_value_name_sources.push(("generation", generation_debug_value_names));
    }
    if let Some(qc_source) = qc_source {
        sources_meta.push((
            "quality_control",
            maze_core::event_log::EventedEventKind::QualityControl,
        ));
        tape_sources.push(qc_source);
        debug_value_name_sources.push(("quality_control", Vec::new()));
    }

    if tape_sources.is_empty() {
        return (None, Vec::new(), Vec::new());
    }

    let merged_tape = maze_core::event_log::merge_tapes(tape_sources);
    let debug_value_name_sources: Vec<(
        &'static str,
        Vec<(&str, maze_core::event_log::DebugValueKind)>,
    )> = debug_value_name_sources
        .iter()
        .map(|(scope_name, names)| {
            (
                *scope_name,
                names
                    .iter()
                    .map(|(name, kind)| (name.as_str(), *kind))
                    .collect(),
            )
        })
        .collect();
    let debug_value_names =
        maze_core::generation::qualify_debug_value_names(&debug_value_name_sources);
    (Some(merged_tape), debug_value_names, sources_meta)
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
    debug_all_nodes: JsValue,
) -> GenerateResult {
    match debug_tape {
        Some(tape) => {
            assert!(
                !sources.is_empty(),
                "build_generate_result: debug_tape is Some but sources is empty — \
                 run_initial_generation must always produce them together"
            );
            GenerateResult::with_debug_tape(
                snapshot_js,
                tape.node_table,
                tape.payload,
                debug_value_names,
                sources,
                debug_all_nodes,
            )
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
            assert!(
                sources.is_empty(),
                "build_generate_result: sources is non-empty but debug_tape is None"
            );
            GenerateResult::without_debug_tape(snapshot_js)
        }
    }
}

/// Thin wrapper that also returns `check_types` map needed by `build_analytics_snapshot`.
pub fn build_qc_and_repair_with_types<T: Tessellation + 'static>(
    config: &GenerateConfig,
) -> Result<
    (
        maze_core::quality_control::QualityControlEngine<T>,
        HashMap<String, String>,
    ),
    String,
> {
    let check_types = maze_runner::runner::build_check_types(config);
    let qc_engine = maze_runner::runner::build_qc_and_repair::<T>(config)?;
    Ok((qc_engine, check_types))
}

fn timing_node_to_dto(node: maze_core::TimingNode) -> crate::dto::TimingNodeDto {
    crate::dto::TimingNodeDto {
        id: node.id,
        total_ms: node.entry.total_ms,
        calls: node.entry.calls,
        children: node.children.into_iter().map(timing_node_to_dto).collect(),
    }
}

fn timing_to_dto(timing: maze_core::GenerationTiming) -> crate::dto::GenerationTimingDto {
    crate::dto::GenerationTimingDto {
        initial_build_ms: timing.initial_build_ms,
        qc: timing.qc.into_iter().map(timing_node_to_dto).collect(),
        snapshot_ms: timing.snapshot_ms,
    }
}
