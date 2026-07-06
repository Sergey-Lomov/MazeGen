mod dto;
mod generation_config;
mod runner;
mod tessellation_dispatch;
mod analytics;

use serde::Serialize;
use wasm_bindgen::prelude::*;
use maze_core::{
    space::{SquareTessellation, Field, Tessellation},
    space::{SquarePoint, HexPoint, TriPoint},
    ids::IdGenerator,
    graph::{Graph, EdgeKind},
    Maze,
    quality_control::{IssueKind, MISSING_ENDPOINTS, UNREACHABLE_FINISH, MISSING_LOOPS, MIN_LOOPS_DEFAULT, MIN_LOOP_DENSITY_DEFAULT, AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, INVALID_LOOP, MIN_LOOP_LENGTH_DEFAULT, MAX_LOOP_LENGTH_DEFAULT, EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LOOP_DISTANCE_FROM_START_DEFAULT, LOOP_DISTANCE_FROM_FINISH_DEFAULT, MAX_LOOP_DENSITY_DEFAULT, MAX_SCC_COUNT_DEFAULT, EXCESSIVE_SCC_COUNT, MIN_REGION_SIZE_DEFAULT, MIN_REGION_RATIO_DEFAULT, REGION_NEEDS_EXPANSION, MIN_REGION_COUNT_DEFAULT, MISSING_REGIONS, INVALID_TELEPORT, TELEPORT_WAYPOINT_DISTANCE_DEFAULT, TELEPORT_MIN_GEOMETRIC_LENGTH_DEFAULT, TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT, TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT, TELEPORT_GROUP_PROXIMITY, TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT},
    RegionClass,
    repair::{RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy, InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, MissingLoopsRandomStrategy, ExpandRegionPassageStrategy, MissingRegionsStrategy, ReduceSccCountStrategy, RemoveTeleportStrategy, TeleportGroupProximityStrategy},
};
use generation_config::{GenerateConfig, TessellationConfig, TessellationType};
use tessellation_dispatch::dispatch_generate;
use dto::{ComputeAnalyticsConfig, PostEditEdgeDto};
use analytics::build_analytics_snapshot;

#[derive(Serialize)]
struct ParamDescriptor {
    id: &'static str,
    label: &'static str,
    kind: ParamKindDto,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ParamKindDto {
    Float { default: f64, min: f64, max: f64 },
    Integer { default: i64, min: i64, max: i64 },
    Bool { default: bool },
    Enum { options: Vec<&'static str>, default: &'static str },
}

#[derive(Serialize)]
struct CheckDescriptor {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    issue_kinds: Vec<&'static str>,
    params: Vec<ParamDescriptor>,
    /// Whether more than one independent instance of this check type may be active at once
    /// (across rules, or within the same rule) — see GitHub issue #60. `false` for every check
    /// except `min_region_count`: a second `min_region_count` instance with a different
    /// `region_class` is a legitimate, common configuration ("at least 2 trap regions" AND
    /// separately "at least 2 alternative regions"); no other check has an analogous use case
    /// for running twice with different params, so this stays opt-in per check rather than a
    /// blanket allowance. The web store/UI enforce this (see `addCheck`/`createRule` in
    /// `generationSlice.ts`) — wasm/core themselves don't reject a duplicate, since nothing
    /// downstream of this flag depends on it being correct for repair/QC to function.
    allow_multiple_instances: bool,
}

#[derive(Serialize)]
struct StrategyDescriptor {
    id: &'static str,
    handles: &'static str,
    params: Vec<ParamDescriptor>,
    /// Whether this strategy is experimental — see `RepairStrategy::is_experimental` in
    /// `maze-core`. UI shows a warning badge/bubble for these.
    experimental: bool,
    /// Mirrors `RepairStrategy::expected_nested()` — one entry per nested-strategy slot this
    /// strategy accepts. Empty for every strategy without nested slots (the overwhelming
    /// majority). The web UI resolves candidate nested strategies for a slot as
    /// `availableStrategies.filter(s => s.handles === slot.kind)`.
    nested_slots: Vec<NestedSlotDto>,
}

#[derive(Serialize)]
struct NestedSlotDto {
    slot_id: &'static str,
    kind: &'static str,
    min: usize,
    max: Option<usize>,
}

fn nested_slots_dto(slots: &[maze_core::repair::NestedSlot]) -> Vec<NestedSlotDto> {
    slots.iter().map(|s| NestedSlotDto {
        slot_id: s.slot_id,
        kind: kind_str(s.kind),
        min: s.min,
        max: s.max,
    }).collect()
}

// Helper to turn IssueKind into a &'static str for JSON serialization.
fn kind_str(k: IssueKind) -> &'static str {
    k.as_str()
}

fn param_kind_dto(kind: &maze_core::repair::StrategyParamKind) -> ParamKindDto {
    match kind {
        maze_core::repair::StrategyParamKind::Float { default, min, max } =>
            ParamKindDto::Float { default: *default, min: *min, max: *max },
        maze_core::repair::StrategyParamKind::Bool { default } =>
            ParamKindDto::Bool { default: *default },
        maze_core::repair::StrategyParamKind::Enum { options, default } =>
            ParamKindDto::Enum { options: options.to_vec(), default },
    }
}

fn strategy_params_dto(params: &[maze_core::repair::StrategyParam]) -> Vec<ParamDescriptor> {
    params.iter().map(|p| ParamDescriptor {
        id: p.id,
        label: p.label,
        kind: param_kind_dto(&p.kind),
    }).collect()
}

#[wasm_bindgen]
pub fn available_checks() -> JsValue {
    serde_wasm_bindgen::to_value(&available_checks_list()).unwrap()
}

/// Dropdown restricting `min_region_size`/`min_region_ratio` to one `RegionClass`, defaulting to
/// `"all"` (every class, the checks' pre-#54 behavior) — see GitHub issue #54.
fn region_class_filter_param() -> ParamDescriptor {
    ParamDescriptor {
        id: "region_class",
        label: "Region class",
        kind: ParamKindDto::Enum {
            options: vec![
                "all",
                RegionClass::Path.as_str(),
                RegionClass::Alternative.as_str(),
                RegionClass::Unreachable.as_str(),
                RegionClass::Trap.as_str(),
            ],
            default: "all",
        },
    }
}

fn available_checks_list() -> Vec<CheckDescriptor> {
    vec![
        CheckDescriptor {
            id: "missing_endpoints",
            label: "Start and finish present",
            description: "Fires if the maze has no start or no finish.",
            issue_kinds: vec![kind_str(MISSING_ENDPOINTS)],
            params: vec![],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "unreachable_finish",
            label: "Finish reachable from start",
            description: "Fires if finish cannot be reached from start via directed traversal.",
            issue_kinds: vec![kind_str(UNREACHABLE_FINISH)],
            params: vec![],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_loops_count",
            label: "Minimum loop count",
            description: "Fires if the maze has fewer loops than the required minimum.",
            issue_kinds: vec![kind_str(MISSING_LOOPS)],
            params: vec![ParamDescriptor {
                id: "min_loops",
                label: "Min loop count",
                kind: ParamKindDto::Integer { default: MIN_LOOPS_DEFAULT as i64, min: 1, max: 1_000_000 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_loop_density",
            label: "Minimum loop density",
            description: "Fires if too small a share of the field is covered by loops; the missing cell count is converted into a requested loop count via an estimated average loop length.",
            issue_kinds: vec![kind_str(MISSING_LOOPS)],
            params: vec![
                ParamDescriptor {
                    id: "min_density",
                    label: "Min loop density (per 100 cells)",
                    kind: ParamKindDto::Integer { default: MIN_LOOP_DENSITY_DEFAULT as i64, min: 0, max: 100 },
                },
                ParamDescriptor {
                    id: "avg_loop_length_estimate",
                    label: "Average loop length estimate",
                    kind: ParamKindDto::Integer { default: AVG_LOOP_LENGTH_ESTIMATE_DEFAULT as i64, min: 1, max: 100_000 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "scc_count",
            label: "Maximum SCC region count",
            description: "Fires if the graph is split into more strongly-connected components than the allowed maximum, signalling a fragmented maze.",
            issue_kinds: vec![kind_str(EXCESSIVE_SCC_COUNT)],
            params: vec![ParamDescriptor {
                id: "max_scc_count",
                label: "Max SCC region count",
                kind: ParamKindDto::Integer { default: MAX_SCC_COUNT_DEFAULT as i64, min: 1, max: 1_000_000 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_region_size",
            label: "Minimum SCC region size",
            description: "Fires if any strongly-connected region has fewer tiles than the required minimum.",
            issue_kinds: vec![kind_str(REGION_NEEDS_EXPANSION)],
            params: vec![
                ParamDescriptor {
                    id: "min_region_size",
                    label: "Min region size (tiles)",
                    kind: ParamKindDto::Integer { default: MIN_REGION_SIZE_DEFAULT as i64, min: 1, max: 1_000_000 },
                },
                region_class_filter_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_region_ratio",
            label: "Minimum SCC region ratio",
            description: "Fires if any strongly-connected region covers less than the required share of the field.",
            issue_kinds: vec![kind_str(REGION_NEEDS_EXPANSION)],
            params: vec![
                ParamDescriptor {
                    id: "min_region_ratio",
                    label: "Min region ratio (per 100 cells)",
                    kind: ParamKindDto::Integer { default: MIN_REGION_RATIO_DEFAULT as i64, min: 0, max: 100 },
                },
                region_class_filter_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_region_count",
            label: "Minimum region count",
            description: "Fires if the maze has too few (or, for repair purposes, more than enough) regions of any class (path/alternative/unreachable/trap) against its configured minimum.",
            issue_kinds: vec![kind_str(MISSING_REGIONS)],
            params: vec![
                ParamDescriptor {
                    id: "path_count",
                    label: "Min Path region count",
                    kind: ParamKindDto::Integer { default: MIN_REGION_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
                ParamDescriptor {
                    id: "alternative_count",
                    label: "Min Alternative region count",
                    kind: ParamKindDto::Integer { default: MIN_REGION_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
                ParamDescriptor {
                    id: "unreachable_count",
                    label: "Min Unreachable region count",
                    kind: ParamKindDto::Integer { default: MIN_REGION_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
                ParamDescriptor {
                    id: "trap_count",
                    label: "Min Trap region count",
                    kind: ParamKindDto::Integer { default: MIN_REGION_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
            ],
            // A single instance now evaluates all four classes at once (see GitHub issue #60's
            // multi-instance design, retired — `MinRegionCountCheck` no longer needs more than
            // one active instance to express "different minimums per class").
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_loop_length",
            label: "Minimum loop length",
            description: "Fires if the maze has simple loops shorter than the required minimum tile length.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "min_loop_length",
                label: "Min loop length",
                kind: ParamKindDto::Integer { default: MIN_LOOP_LENGTH_DEFAULT as i64, min: 1, max: 100_000 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_loop_length",
            label: "Maximum loop length",
            description: "Fires if the maze has simple loops longer than the allowed maximum tile length.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "max_loop_length",
                label: "Max loop length",
                kind: ParamKindDto::Integer { default: MAX_LOOP_LENGTH_DEFAULT as i64, min: 1, max: 100_000 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "external_escape_diversity",
            label: "External escape diversity",
            description: "Fires if a simple loop's outgoing connections converge on too few distinct destinations outside the loop, instead of spreading out diversely.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "min_distinct_exits",
                label: "Min distinct exits",
                kind: ParamKindDto::Integer { default: EXTERNAL_ESCAPE_DIVERSITY_DEFAULT as i64, min: 0, max: 1_000 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "loop_distance_from_start",
            label: "Loop distance from start",
            description: "Fires if a simple loop sits closer to start (in tiles, directed graph distance) than the required minimum.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "min_distance_from_start",
                label: "Min distance from start",
                kind: ParamKindDto::Integer { default: LOOP_DISTANCE_FROM_START_DEFAULT as i64, min: 0, max: 100_000 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "loop_distance_from_finish",
            label: "Loop distance from finish",
            description: "Fires if a simple loop sits closer to finish (in tiles, directed graph distance) than the required minimum.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "min_distance_from_finish",
                label: "Min distance from finish",
                kind: ParamKindDto::Integer { default: LOOP_DISTANCE_FROM_FINISH_DEFAULT as i64, min: 0, max: 100_000 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_loop_density",
            label: "Maximum loop density",
            description: "Fires if too large a share of the field is covered by loops; excess loops are picked at random and flagged until density drops to the allowed maximum.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "max_density",
                label: "Max loop density (per 100 cells)",
                kind: ParamKindDto::Integer { default: MAX_LOOP_DENSITY_DEFAULT as i64, min: 0, max: 100 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_duplicates_connection",
            label: "Teleport duplicates connection",
            description: "Fires if a teleport edge duplicates a regular connection already present between the same pair in the same direction.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![protect_route_param()],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_waypoint_distance",
            label: "Teleport waypoint distance",
            description: "Fires if a teleport's entry (or entry/exit) sits closer than the required minimum logical distance to start and/or finish.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Min distance",
                    kind: ParamKindDto::Integer { default: TELEPORT_WAYPOINT_DISTANCE_DEFAULT as i64, min: 0, max: 100_000 },
                },
                ParamDescriptor {
                    id: "waypoint",
                    label: "Waypoint",
                    kind: ParamKindDto::Enum { options: vec!["start", "finish", "any"], default: "any" },
                },
                ParamDescriptor {
                    id: "edge",
                    label: "Edge",
                    kind: ParamKindDto::Enum { options: vec!["entry_only", "entry_or_exit"], default: "entry_or_exit" },
                },
                protect_route_param(),
            ],
            // Multiple instances with different waypoint/edge/distance combinations are a
            // legitimate common configuration (e.g. "entry far from start" AND separately "exit
            // far from finish") — same rationale as min_region_count's allow_multiple_instances.
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "teleport_min_geometric_length",
            label: "Teleport minimum geometric length",
            description: "Fires if the geometric (straight-line) distance between a teleport's entry and exit is shorter than the required minimum.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![
                ParamDescriptor {
                    id: "min_length",
                    label: "Min length (tiles)",
                    kind: ParamKindDto::Float { default: TELEPORT_MIN_GEOMETRIC_LENGTH_DEFAULT, min: 0.0, max: 100_000.0 },
                },
                protect_route_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_max_geometric_length",
            label: "Teleport maximum geometric length",
            description: "Fires if the geometric (straight-line) distance between a teleport's entry and exit exceeds the allowed maximum.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![
                ParamDescriptor {
                    id: "max_length",
                    label: "Max length (tiles)",
                    kind: ParamKindDto::Float { default: TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT, min: 0.0, max: 1_000_000.0 },
                },
                protect_route_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_super_hub_avoidance",
            label: "Teleport super-hub avoidance",
            description: "Fires if a teleport's entry (or exit, or either) vertex already has more than the allowed number of outgoing connections.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![
                ParamDescriptor {
                    id: "max_connections",
                    label: "Max connections",
                    kind: ParamKindDto::Integer { default: TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
                ParamDescriptor {
                    id: "edge_hub",
                    label: "Edge",
                    kind: ParamKindDto::Enum { options: vec!["entry", "exit", "entry_or_exit"], default: "entry_or_exit" },
                },
                protect_route_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_group_proximity",
            label: "Teleport group proximity",
            description: "Fires if a pair of teleport edges sit topologically closer to each other than the required minimum distance.",
            issue_kinds: vec![kind_str(TELEPORT_GROUP_PROXIMITY)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Min distance",
                    kind: ParamKindDto::Float { default: TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT, min: 0.0, max: 100_000.0 },
                },
                ParamDescriptor {
                    id: "own_edge",
                    label: "This teleport's end",
                    kind: ParamKindDto::Enum { options: vec!["entry", "exit", "entry_or_exit"], default: "entry_or_exit" },
                },
                ParamDescriptor {
                    id: "other_edge",
                    label: "Other teleport's end",
                    kind: ParamKindDto::Enum { options: vec!["entry", "exit", "entry_or_exit"], default: "entry_or_exit" },
                },
                protect_route_param(),
            ],
            // Multiple instances with different own_edge/other_edge/distance combinations are a
            // legitimate simultaneous configuration (e.g. "entries close to each other" AND
            // separately "exits close to each other") -- same rationale as
            // teleport_waypoint_distance's allow_multiple_instances.
            allow_multiple_instances: true,
        },
    ]
}

/// Shared `protect_route` param descriptor (GitHub issue #78) — every per-teleport check gets
/// this exact id/label/default, so it's declared once instead of repeated per `CheckDescriptor`.
fn protect_route_param() -> ParamDescriptor {
    ParamDescriptor {
        id: "protect_route",
        label: "Protect route teleports",
        kind: ParamKindDto::Bool { default: true },
    }
}

#[wasm_bindgen]
pub fn available_strategies() -> JsValue {
    let strategies: Vec<StrategyDescriptor> = vec![
        StrategyDescriptor {
            id: "random_endpoints",
            handles: kind_str(MISSING_ENDPOINTS),
            params: strategy_params_dto(<RandomEndpointsStrategy as RepairStrategy<SquareTessellation>>::params(&RandomEndpointsStrategy)),
            experimental: <RandomEndpointsStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&RandomEndpointsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "farthest_endpoints",
            handles: kind_str(MISSING_ENDPOINTS),
            params: strategy_params_dto(<FarthestEndpointsStrategy as RepairStrategy<SquareTessellation>>::params(&FarthestEndpointsStrategy)),
            experimental: <FarthestEndpointsStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&FarthestEndpointsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "scored_endpoints",
            handles: kind_str(MISSING_ENDPOINTS),
            params: strategy_params_dto(<ScoredEndpointsStrategy as RepairStrategy<SquareTessellation>>::params(&ScoredEndpointsStrategy)),
            experimental: <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&ScoredEndpointsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "invalid_loop_random",
            handles: kind_str(INVALID_LOOP),
            params: strategy_params_dto(<InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation>>::params(&InvalidLoopRandomStrategy)),
            experimental: <InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&InvalidLoopRandomStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "invalid_loop_scored",
            handles: kind_str(INVALID_LOOP),
            params: strategy_params_dto(<InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation>>::params(&InvalidLoopScoredStrategy)),
            experimental: <InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&InvalidLoopScoredStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "missing_loops_random",
            handles: kind_str(MISSING_LOOPS),
            params: strategy_params_dto(<MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation>>::params(&MissingLoopsRandomStrategy)),
            experimental: <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&MissingLoopsRandomStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "expand_region_passage",
            handles: kind_str(REGION_NEEDS_EXPANSION),
            params: strategy_params_dto(<ExpandRegionPassageStrategy as RepairStrategy<SquareTessellation>>::params(&ExpandRegionPassageStrategy)),
            experimental: <ExpandRegionPassageStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&ExpandRegionPassageStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "missing_regions",
            handles: kind_str(MISSING_REGIONS),
            params: strategy_params_dto(<MissingRegionsStrategy as RepairStrategy<SquareTessellation>>::params(&MissingRegionsStrategy)),
            experimental: <MissingRegionsStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&MissingRegionsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "reduce_scc_count",
            handles: kind_str(EXCESSIVE_SCC_COUNT),
            params: strategy_params_dto(<ReduceSccCountStrategy as RepairStrategy<SquareTessellation>>::params(&ReduceSccCountStrategy)),
            experimental: <ReduceSccCountStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&ReduceSccCountStrategy),
            nested_slots: nested_slots_dto(<ReduceSccCountStrategy as RepairStrategy<SquareTessellation>>::expected_nested(&ReduceSccCountStrategy)),
        },
        StrategyDescriptor {
            id: "remove_teleport",
            handles: kind_str(INVALID_TELEPORT),
            params: strategy_params_dto(<RemoveTeleportStrategy as RepairStrategy<SquareTessellation>>::params(&RemoveTeleportStrategy)),
            experimental: <RemoveTeleportStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&RemoveTeleportStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "teleport_group_proximity",
            handles: kind_str(TELEPORT_GROUP_PROXIMITY),
            params: strategy_params_dto(<TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation>>::params(&TeleportGroupProximityStrategy)),
            experimental: <TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation>>::is_experimental(&TeleportGroupProximityStrategy),
            nested_slots: vec![],
        },
    ];
    serde_wasm_bindgen::to_value(&strategies).unwrap()
}

/// Canonical (unrotated, unit-tile-scale) Cartesian projection of each point in `points`, via
/// `Tessellation::cartesian` — see `maze-core::space`'s doc comment for why this carries no
/// rendering-specific orientation/rotation (a display-only concept that stays entirely on the
/// web side). `maze-web`'s `tessellationGeometry.ts` is the single caller: it scales this by
/// `TILE_SIZE`/`TRI_TILE_SIZE` and applies the configured orientation's rotation to get pixel
/// coordinates, rather than duplicating the projection formulas in TypeScript.
#[wasm_bindgen]
pub fn cartesian_coords(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: TessellationConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let coords: Vec<[f64; 2]> = match cfg.tessellation_type {
        TessellationType::Square => cfg.points.iter()
            .map(|&[x, y]| {
                let (cx, cy) = SquareTessellation::cartesian(SquarePoint { x, y });
                [cx, cy]
            })
            .collect(),
        TessellationType::Hex => cfg.points.iter()
            .map(|&[q, r]| {
                let (cx, cy) = maze_core::space::HexTessellation::cartesian(HexPoint { q, r });
                [cx, cy]
            })
            .collect(),
        TessellationType::Tri => cfg.points.iter()
            .map(|&[col, row]| {
                let (cx, cy) = maze_core::space::TriTessellation::cartesian(TriPoint { col, row });
                [cx, cy]
            })
            .collect(),
    };
    Ok(serde_wasm_bindgen::to_value(&coords).unwrap())
}

#[wasm_bindgen]
pub fn generate(seed: u64, config: JsValue) -> Result<JsValue, JsValue> {
    let config: GenerateConfig = if config.is_null() || config.is_undefined() {
        GenerateConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?
    };
    dispatch_generate(seed, &config)
}

#[wasm_bindgen]
pub fn compute_analytics(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: ComputeAnalyticsConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    dispatch_compute_analytics(cfg)
}

fn dispatch_compute_analytics(cfg: ComputeAnalyticsConfig) -> Result<JsValue, JsValue> {
    match cfg.tessellation.tessellation_type {
        TessellationType::Square => {
            let pts: Vec<SquarePoint> = cfg.tessellation.points.iter()
                .map(|&[x, y]| SquarePoint { x, y }).collect();
            run_compute_analytics::<maze_core::space::SquareTessellation>(cfg, pts, |p: SquarePoint| (p.x, p.y))
        }
        TessellationType::Hex => {
            let pts: Vec<HexPoint> = cfg.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            run_compute_analytics::<maze_core::space::HexTessellation>(cfg, pts, |p: HexPoint| (p.q, p.r))
        }
        TessellationType::Tri => {
            let pts: Vec<TriPoint> = cfg.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            run_compute_analytics::<maze_core::space::TriTessellation>(cfg, pts, |p: TriPoint| (p.col, p.row))
        }
    }
}

/// Wraps each analytics-only check in its own synthetic singleton rule — see the call site's
/// doc comment in `run_compute_analytics` for why. Split out so the wrapping itself (one rule
/// per check, distinct ids, no strategy) can be unit-tested without going through `JsValue`.
// Wraps every active check in its own singleton rule, all under one synthetic stage — this path
// never runs `RepairEngine` (analytics-only, no repair), so stage granularity has no observable
// effect here; a single stage is the simplest shape satisfying `build_qc_and_repair`'s "every
// strategy-bearing rule must be in a stage" invariant (moot here, since no rule has a strategy).
fn analytics_only_stages(checks: Vec<generation_config::CheckInstanceConfig>) -> Vec<generation_config::StageConfig> {
    let rules: Vec<generation_config::QcRuleConfig> = checks.into_iter()
        .enumerate()
        .map(|(i, instance)| generation_config::QcRuleConfig {
            id: format!("analytics_only_{i}"),
            checks: vec![instance],
            strategy: None,
        })
        .collect();
    vec![generation_config::StageConfig { id: "analytics_only_stage".to_string(), name: "Analytics".to_string(), rules }]
}

/// Builds post-edit's passages (and read-only pass-through teleports) into `graph` — split out
/// from `run_compute_analytics` so the edge-kind matching itself can be unit-tested without a
/// `JsValue`/wasm context. "basic" adds both directions (bidirectional passage); "one_way" adds
/// only `from→to` (direction already normalized by the caller); "teleport" adds a single directed
/// `EdgeKind::Teleport` edge — a two-way teleport arrives as two separate "teleport" entries (one
/// per direction), matching how the web side extracts them 1:1 from the generated `EdgeDto` list
/// (see `extractTeleportEdges`), the same way "one_way" already represents only one direction
/// per entry unlike "basic".
fn build_graph_from_post_edit_edges(graph: &mut Graph, edges: &[PostEditEdgeDto]) -> Result<(), String> {
    for e in edges {
        let from_id = e.from as u64;
        let to_id   = e.to   as u64;
        match e.kind.as_str() {
            "basic" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
                graph.build_initial_edge(to_id, from_id, EdgeKind::Basic);
            }
            "one_way" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
            }
            "teleport" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Teleport);
            }
            other => return Err(format!("unknown edge kind: {other}")),
        }
    }
    Ok(())
}

fn run_compute_analytics<T: Tessellation>(
    cfg: ComputeAnalyticsConfig,
    pts: Vec<T::Point>,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<JsValue, JsValue>
where
    T::Point: Copy,
{
    if pts.is_empty() {
        return Err(JsValue::from_str("tessellation points must not be empty"));
    }

    let mut ids = IdGenerator::new();
    let field = Field::<T>::new(pts, &mut ids)
        .map_err(|e| JsValue::from_str(e))?;

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    build_graph_from_post_edit_edges(&mut graph, &cfg.edges)
        .map_err(|e| JsValue::from_str(&e))?;

    let mut maze = Maze::<T>::new(field, graph);
    maze.meta.start  = cfg.start.map(|id| id as u64);
    maze.meta.finish = cfg.finish.map(|id| id as u64);

    // Build QC engine from config (no repair). Each active check becomes its own synthetic
    // singleton rule (id/kind discarded immediately below) — `build_qc_and_repair` is rule-driven
    // (see GitHub issue #60) and no longer accepts a flat check list, but this path has no real
    // rules of its own and never runs `RepairEngine`, so a throwaway one-check-per-rule wrapper
    // is the simplest way to satisfy that shape without rule semantics actually mattering here.
    let stages = analytics_only_stages(cfg.checks);
    let qc_config = GenerateConfig {
        tessellation: cfg.tessellation,
        stages,
        ..GenerateConfig::default()
    };
    let (qc_engine, _, check_types) = runner::build_qc_and_repair_with_types::<T>(&qc_config)
        .map_err(|e| JsValue::from_str(&e))?;

    let snapshot = build_analytics_snapshot(&mut maze, Some(&qc_engine), None, &check_types, point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;

    snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn only_known_checks_allow_multiple_instances() {
        // GitHub issue #60's multi-instance design (min_region_count being the one check that
        // could run more than once at a time, for different region_class values) is retired:
        // a single min_region_count instance now evaluates all four classes' balances at once.
        // teleport_waypoint_distance (issue #74) and teleport_group_proximity (issue #75) are the
        // only checks that legitimately allow multiple simultaneous instances (distinct
        // own_edge/other_edge/distance combinations are independent configurations).
        let checks = available_checks_list();
        let allowing: Vec<&str> = checks.iter()
            .filter(|c| c.allow_multiple_instances)
            .map(|c| c.id)
            .collect();
        let mut allowing_sorted = allowing.clone();
        allowing_sorted.sort();
        assert_eq!(
            allowing_sorted,
            vec!["teleport_group_proximity", "teleport_waypoint_distance"],
            "unexpected set of checks allowing multiple instances: {allowing:?}"
        );
    }

    #[test]
    fn analytics_only_stages_wraps_each_check_in_its_own_singleton_rule() {
        let checks = vec![
            generation_config::CheckInstanceConfig { local_id: "a".to_string(), type_id: "missing_endpoints".to_string(), params: HashMap::new() },
            generation_config::CheckInstanceConfig { local_id: "b".to_string(), type_id: "unreachable_finish".to_string(), params: HashMap::new() },
        ];
        let stages = analytics_only_stages(checks);
        assert_eq!(stages.len(), 1, "analytics-only path uses one synthetic stage");
        let rules = &stages[0].rules;
        assert_eq!(rules.len(), 2);
        assert_ne!(rules[0].id, rules[1].id, "each synthetic rule needs a distinct id");
        for rule in rules {
            assert_eq!(rule.checks.len(), 1, "one check per synthetic rule");
            assert!(rule.strategy.is_none(), "analytics-only path never runs RepairEngine");
        }
    }

    fn edge(from: u32, to: u32, kind: &str) -> PostEditEdgeDto {
        PostEditEdgeDto { from, to, kind: kind.to_string() }
    }

    fn graph_with_nodes(ids: &[u64]) -> Graph {
        let mut graph = Graph::new();
        for &id in ids { graph.add_node(id); }
        graph
    }

    #[test]
    fn build_graph_from_post_edit_edges_basic_adds_both_directions() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "basic")]).unwrap();
        assert!(graph.edge_between(1, 2).is_some());
        assert!(graph.edge_between(2, 1).is_some());
        assert_eq!(graph.edges().count(), 2);
    }

    #[test]
    fn build_graph_from_post_edit_edges_one_way_adds_only_forward() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "one_way")]).unwrap();
        assert!(graph.edge_between(1, 2).is_some());
        assert!(graph.edge_between(2, 1).is_none());
        assert_eq!(graph.edges().count(), 1);
    }

    #[test]
    fn build_graph_from_post_edit_edges_teleport_adds_only_forward_as_teleport_kind() {
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "teleport")]).unwrap();
        let e = graph.edges().find(|e| e.from == 1 && e.to == 2).expect("teleport edge must exist");
        assert_eq!(e.kind, EdgeKind::Teleport);
        assert!(graph.edge_between(2, 1).is_none(), "one \"teleport\" entry must add only one direction");
        assert_eq!(graph.edges().count(), 1);
    }

    #[test]
    fn build_graph_from_post_edit_edges_two_teleport_entries_produce_two_way_teleport() {
        // A two-way teleport is represented as two separate "teleport" entries (one per
        // direction), not a single entry that auto-adds both — mirrors how the web side
        // extracts each directed EdgeDto from generation 1:1 (see extractTeleportEdges).
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "teleport"), edge(2, 1, "teleport")]).unwrap();
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport));
        assert!(graph.edges().any(|e| e.from == 2 && e.to == 1 && e.kind == EdgeKind::Teleport));
        assert_eq!(graph.edges().count(), 2);
    }

    #[test]
    fn build_graph_from_post_edit_edges_teleport_coexists_with_parallel_basic() {
        // A Basic and a Teleport edge in the same direction between the same pair must both
        // survive — kind-aware dedup in Graph::add_edge allows this (see graph::parallel_edges_tests).
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "basic"), edge(1, 2, "teleport")]).unwrap();
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Basic));
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport));
        assert_eq!(graph.edges().count(), 3, "basic(2 directions) + teleport(1 direction) = 3 edges");
    }

    #[test]
    fn build_graph_from_post_edit_edges_unknown_kind_is_rejected() {
        let mut graph = graph_with_nodes(&[1, 2]);
        let err = build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "wall")]).unwrap_err();
        assert!(err.contains("wall"), "error must mention the offending kind, got: {err}");
    }
}

