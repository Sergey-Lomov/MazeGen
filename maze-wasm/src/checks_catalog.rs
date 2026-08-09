use wasm_bindgen::prelude::*;
use maze_core::{
    quality_control::{IssueKind, Comparison, MISSING_ENDPOINTS, UNREACHABLE_FINISH, MISSING_LOOPS, MIN_LOOPS_DEFAULT, MIN_LOOP_DENSITY_DEFAULT, AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, INVALID_LOOP, INVALID_LOOP_GROUP, LOOP_LENGTH_DEFAULT, EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LOOP_DISTANCE_FROM_START_DEFAULT, LOOP_DISTANCE_FROM_FINISH_DEFAULT, MAX_LOOP_DENSITY_DEFAULT, MAX_LOOPS_COUNT_DEFAULT, MAX_SCC_COUNT_DEFAULT, EXCESSIVE_SCC_COUNT, MIN_REGION_SIZE_DEFAULT, MIN_REGION_RATIO_DEFAULT, MAX_REGION_SIZE_DEFAULT, MAX_REGION_RATIO_DEFAULT, REGION_NEEDS_EXPANSION, REGION_NEEDS_SHRINK, MIN_REGION_COUNT_DEFAULT, MISSING_REGIONS, INVALID_TELEPORT, TELEPORT_WAYPOINT_DISTANCE_DEFAULT, TELEPORT_GEOMETRIC_LENGTH_DEFAULT, TELEPORT_GRAPH_DISTANCE_DEFAULT, TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT, INVALID_TELEPORT_GROUP, TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT, INVALID_ONE_WAY, ONE_WAY_WAYPOINT_DISTANCE_DEFAULT, INVALID_ONE_WAY_GROUP, ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT, ONE_WAY_GROUP_SUPER_HUB_MAX_CONNECTIONS_DEFAULT, MISSING_ONE_WAYS, MIN_ONE_WAY_COUNT_DEFAULT, MIN_ONE_WAY_RATIO_DEFAULT, MAX_ONE_WAY_COUNT_DEFAULT, MAX_ONE_WAY_RATIO_DEFAULT, MISSING_TELEPORTS, MIN_TELEPORT_COUNT_DEFAULT, MIN_TELEPORT_RATIO_DEFAULT, INVALID_SPLIT_TILE, SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT, INVALID_SPLIT_TILE_GROUP, MAX_SPLIT_COUNT_DEFAULT, MAX_SPLIT_DENSITY_DEFAULT, SPLIT_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, SPLIT_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT, MISSING_SPLIT_TILES, SPLIT_COUNT_DEFAULT, SPLIT_DENSITY_DEFAULT, SPLIT_DENSITY_ESTIMATE_DEFAULT, INVALID_SPLIT_NODE, SPLIT_NODE_CONNECTION_COUNT_DEFAULT, INVALID_SPLIT_NODE_CONNECTION_GROUP, SPLIT_NODE_CONNECTION_PER_NEIGHBOR_MAX_DEFAULT, SPLIT_NODE_CONNECTION_PER_FACE_MAX_DEFAULT, SPLIT_NODE_CONNECTION_TRAVERSAL_DISTANCE_MIN_DETOUR_DEFAULT, INVALID_SPLIT_NODE_GROUP, MAX_SPLIT_TILE_NODE_COUNT_DEFAULT, INVALID_SPLIT_ROUTE},
};
use crate::check_descriptor::{CheckDescriptor, ParamDescriptor, ParamKindDto, region_class_filter_param, comparison_param, cycle_kind_param, split_patterns_filter_param};

// Helper to turn IssueKind into a &'static str for JSON serialization.
fn kind_str(k: IssueKind) -> &'static str {
    k.as_str()
}

#[wasm_bindgen]
pub fn available_checks() -> JsValue {
    serde_wasm_bindgen::to_value(&available_checks_list()).unwrap()
}

pub fn available_checks_list() -> Vec<CheckDescriptor> {
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
            id: "teleport_duplicates_connection",
            label: "Teleport duplicates connection",
            description: "Fires if a teleport edge duplicates a regular connection already present between the same pair in the same direction.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_waypoint_distance",
            label: "Teleport waypoint distance",
            description: "Fires if a teleport's entry (or entry/exit) logical distance to start and/or finish compares against the configured threshold.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Distance threshold",
                    kind: ParamKindDto::Integer { default: TELEPORT_WAYPOINT_DISTANCE_DEFAULT as i64, min: 0, max: 100_000 },
                },
                comparison_param(Comparison::Lt),
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
            ],
            // Multiple instances with different waypoint/edge/distance combinations are a
            // legitimate common configuration (e.g. "entry far from start" AND separately "exit
            // far from finish") — same rationale as min_region_count's allow_multiple_instances.
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "teleport_geometric_length",
            label: "Teleport geometric length",
            description: "Fires if the geometric (straight-line) distance between a teleport's entry and exit compares against the configured threshold.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![
                ParamDescriptor {
                    id: "length",
                    label: "Length threshold (tiles)",
                    kind: ParamKindDto::Float { default: TELEPORT_GEOMETRIC_LENGTH_DEFAULT, min: 0.0, max: 1_000_000.0 },
                },
                comparison_param(Comparison::Lt),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_graph_distance",
            label: "Teleport graph distance",
            description: "Fires if the logical (graph/tile-hop) distance between a teleport's entry and exit, computed as if the teleport itself were absent, compares against the configured threshold.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Distance threshold (tiles)",
                    kind: ParamKindDto::Integer { default: TELEPORT_GRAPH_DISTANCE_DEFAULT as i64, min: 0, max: 100_000 },
                },
                comparison_param(Comparison::Lt),
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
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_split_intersection",
            label: "Teleport split intersection",
            description: "Fires if a teleport's entry (or exit, or either) vertex belongs to a split cell.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT)],
            params: vec![
                ParamDescriptor {
                    id: "edge_split",
                    label: "Edge",
                    kind: ParamKindDto::Enum { options: vec!["entry", "exit", "entry_or_exit"], default: "entry_or_exit" },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "teleport_group_proximity",
            label: "Teleport group proximity",
            description: "Fires if a pair of teleport edges sit topologically closer to each other than the required minimum distance.",
            issue_kinds: vec![kind_str(INVALID_TELEPORT_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Distance threshold",
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
            ],
            // Multiple instances with different own_edge/other_edge/distance combinations are a
            // legitimate simultaneous configuration (e.g. "entries close to each other" AND
            // separately "exits close to each other") -- same rationale as
            // teleport_waypoint_distance's allow_multiple_instances.
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "min_teleport_count",
            label: "Minimum teleport count",
            description: "Fires if the maze has fewer teleport edges than the required minimum.",
            issue_kinds: vec![kind_str(MISSING_TELEPORTS)],
            params: vec![
                ParamDescriptor {
                    id: "min_teleports",
                    label: "Min teleport count",
                    kind: ParamKindDto::Integer { default: MIN_TELEPORT_COUNT_DEFAULT as i64, min: 1, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_teleport_ratio",
            label: "Minimum teleport ratio",
            description: "Fires if the maze has fewer teleport edges than the required minimum, expressed per 100 field cells (not per 100 edges).",
            issue_kinds: vec![kind_str(MISSING_TELEPORTS)],
            params: vec![
                ParamDescriptor {
                    id: "min_teleport_ratio",
                    label: "Min teleport count (per 100 cells)",
                    kind: ParamKindDto::Integer { default: MIN_TELEPORT_RATIO_DEFAULT as i64, min: 0, max: 100 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_one_way_count",
            label: "Minimum one-way count",
            description: "Fires if the maze has fewer one-way passages than the required minimum.",
            issue_kinds: vec![kind_str(MISSING_ONE_WAYS)],
            params: vec![
                ParamDescriptor {
                    id: "min_one_ways",
                    label: "Min one-way count",
                    kind: ParamKindDto::Integer { default: MIN_ONE_WAY_COUNT_DEFAULT as i64, min: 1, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_one_way_ratio",
            label: "Minimum one-way ratio",
            description: "Fires if the maze has fewer one-way passages than the required minimum, expressed per 100 field cells (not per 100 edges).",
            issue_kinds: vec![kind_str(MISSING_ONE_WAYS)],
            params: vec![
                ParamDescriptor {
                    id: "min_ratio",
                    label: "Min one-way count (per 100 cells)",
                    kind: ParamKindDto::Integer { default: MIN_ONE_WAY_RATIO_DEFAULT as i64, min: 0, max: 100 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "one_way_waypoint_distance",
            label: "One-way waypoint distance",
            description: "Fires if a one-way passage edge's logical distance (either endpoint, whichever is closer) to start and/or finish compares against the configured threshold.",
            issue_kinds: vec![kind_str(INVALID_ONE_WAY)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Distance threshold",
                    kind: ParamKindDto::Integer { default: ONE_WAY_WAYPOINT_DISTANCE_DEFAULT as i64, min: 0, max: 100_000 },
                },
                comparison_param(Comparison::Lt),
                ParamDescriptor {
                    id: "waypoint",
                    label: "Waypoint",
                    kind: ParamKindDto::Enum { options: vec!["start", "finish", "any"], default: "any" },
                },
            ],
            // Multiple instances with different waypoint/distance combinations are a legitimate
            // simultaneous configuration -- same rationale as teleport_waypoint_distance's
            // allow_multiple_instances.
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "one_way_group_geometric_proximity",
            label: "One-way group geometric proximity",
            description: "Fires if a pair of one-way passage edges sit geometrically closer to each other than the required minimum distance.",
            issue_kinds: vec![kind_str(INVALID_ONE_WAY_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Distance threshold",
                    kind: ParamKindDto::Float { default: ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, min: 0.0, max: 100_000.0 },
                },
            ],
            // Multiple instances with different distance thresholds are a legitimate simultaneous
            // configuration -- same rationale as teleport_group_proximity's allow_multiple_instances.
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "one_way_group_graph_proximity",
            label: "One-way group graph proximity",
            description: "Fires if a pair of one-way passage edges sit topologically closer to each other than the required minimum distance.",
            issue_kinds: vec![kind_str(INVALID_ONE_WAY_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Distance threshold",
                    kind: ParamKindDto::Float { default: ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT, min: 0.0, max: 100_000.0 },
                },
            ],
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "one_way_group_super_hub",
            label: "One-way group super-hub avoidance",
            description: "Fires if a vertex's count of outgoing one-way passage edges exceeds the configured maximum.",
            issue_kinds: vec![kind_str(INVALID_ONE_WAY_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "max_connections",
                    label: "Max connections",
                    kind: ParamKindDto::Integer { default: ONE_WAY_GROUP_SUPER_HUB_MAX_CONNECTIONS_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_one_way_count",
            label: "Maximum one-way count",
            description: "Fires if the maze has more one-way passages than the allowed maximum.",
            issue_kinds: vec![kind_str(INVALID_ONE_WAY_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "max_one_ways",
                    label: "Max one-way count",
                    kind: ParamKindDto::Integer { default: MAX_ONE_WAY_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_one_way_ratio",
            label: "Maximum one-way ratio",
            description: "Fires if the maze has more one-way passages than the allowed maximum, expressed per 100 field cells (not per 100 edges).",
            issue_kinds: vec![kind_str(INVALID_ONE_WAY_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "max_ratio",
                    label: "Max one-way count (per 100 cells)",
                    kind: ParamKindDto::Integer { default: MAX_ONE_WAY_RATIO_DEFAULT as i64, min: 0, max: 100 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_loops_count",
            label: "Minimum loop count",
            description: "Fires if the maze has fewer independent loops than the required minimum.",
            issue_kinds: vec![kind_str(MISSING_LOOPS)],
            params: vec![
                ParamDescriptor {
                    id: "min_loops",
                    label: "Min loop count",
                    kind: ParamKindDto::Integer { default: MIN_LOOPS_DEFAULT as i64, min: 1, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "min_loop_density",
            label: "Minimum loop density",
            description: "Fires if too small a share of the field is covered by loops, converting the coverage deficit into a loop count via an estimated average loop length.",
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
            id: "loop_length",
            label: "Loop length",
            description: "Fires if a simple loop's tile length compares against the configured threshold (e.g. shorter or longer than a limit).",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![
                ParamDescriptor {
                    id: "length",
                    label: "Length threshold",
                    kind: ParamKindDto::Integer { default: LOOP_LENGTH_DEFAULT as i64, min: 1, max: 100_000 },
                },
                comparison_param(Comparison::Lt),
                cycle_kind_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "external_escape_diversity",
            label: "External escape diversity",
            description: "Fires if a simple loop's outgoing connections converge on too few distinct destinations outside the loop, instead of spreading out diversely.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![
                ParamDescriptor {
                    id: "min_distinct_exits",
                    label: "Min distinct exits",
                    kind: ParamKindDto::Integer { default: EXTERNAL_ESCAPE_DIVERSITY_DEFAULT as i64, min: 0, max: 1_000 },
                },
                cycle_kind_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "loop_distance_from_start",
            label: "Loop distance from start",
            description: "Fires if a simple loop sits closer to start (in tiles, directed graph distance) than the required minimum.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![
                ParamDescriptor {
                    id: "min_distance_from_start",
                    label: "Min distance from start",
                    kind: ParamKindDto::Integer { default: LOOP_DISTANCE_FROM_START_DEFAULT as i64, min: 0, max: 100_000 },
                },
                cycle_kind_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "loop_distance_from_finish",
            label: "Loop distance from finish",
            description: "Fires if a simple loop sits closer to finish (in tiles, directed graph distance) than the required minimum.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![
                ParamDescriptor {
                    id: "min_distance_from_finish",
                    label: "Min distance from finish",
                    kind: ParamKindDto::Integer { default: LOOP_DISTANCE_FROM_FINISH_DEFAULT as i64, min: 0, max: 100_000 },
                },
                cycle_kind_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_loop_density",
            label: "Maximum loop density",
            description: "Fires if too large a share of the field is covered by loops; every loop is flagged when the maximum is exceeded.",
            issue_kinds: vec![kind_str(INVALID_LOOP_GROUP)],
            params: vec![ParamDescriptor {
                id: "max_density",
                label: "Max loop density (per 100 cells)",
                kind: ParamKindDto::Integer { default: MAX_LOOP_DENSITY_DEFAULT as i64, min: 0, max: 100 },
            }],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_loops_count",
            label: "Maximum loop count",
            description: "Fires if the field has more simple loops than the allowed maximum; every loop is flagged when the maximum is exceeded.",
            issue_kinds: vec![kind_str(INVALID_LOOP_GROUP)],
            params: vec![ParamDescriptor {
                id: "max_loops_count",
                label: "Max loop count",
                kind: ParamKindDto::Integer { default: MAX_LOOPS_COUNT_DEFAULT as i64, min: 0, max: 100_000 },
            }],
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
            id: "max_region_size",
            label: "Maximum SCC region size",
            description: "Fires if any strongly-connected region has more tiles than the allowed maximum.",
            issue_kinds: vec![kind_str(REGION_NEEDS_SHRINK)],
            params: vec![
                ParamDescriptor {
                    id: "max_region_size",
                    label: "Max region size (tiles)",
                    kind: ParamKindDto::Integer { default: MAX_REGION_SIZE_DEFAULT as i64, min: 1, max: 1_000_000 },
                },
                region_class_filter_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_region_ratio",
            label: "Maximum SCC region ratio",
            description: "Fires if any strongly-connected region covers more than the allowed share of the field.",
            issue_kinds: vec![kind_str(REGION_NEEDS_SHRINK)],
            params: vec![
                ParamDescriptor {
                    id: "max_region_ratio",
                    label: "Max region ratio (per 100 cells)",
                    kind: ParamKindDto::Integer { default: MAX_REGION_RATIO_DEFAULT as i64, min: 0, max: 100 },
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
            id: "split_distance_from_waypoint",
            label: "Split distance from waypoint",
            description: "Fires if an extra split node's point sits too close to (or, with a different comparison, too far from) start and/or finish in logical distance.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_TILE)],
            params: vec![
                ParamDescriptor {
                    id: "distance",
                    label: "Distance threshold",
                    kind: ParamKindDto::Integer { default: SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT as i64, min: 0, max: 100_000 },
                },
                comparison_param(Comparison::Lt),
                ParamDescriptor {
                    id: "waypoint",
                    label: "Waypoint",
                    kind: ParamKindDto::Enum { options: vec!["start", "finish", "any"], default: "any" },
                },
            ],
            // Multiple instances with different waypoint/distance combinations are a legitimate
            // simultaneous configuration -- same rationale as teleport_waypoint_distance's
            // allow_multiple_instances.
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "split_teleport_intersection",
            label: "Split teleport intersection",
            description: "Fires if a split tile has a teleport connection matching the configured shape (one-way in, one-way out, or bidirectional).",
            issue_kinds: vec![kind_str(INVALID_SPLIT_TILE)],
            params: vec![
                ParamDescriptor {
                    id: "split_teleport_direction",
                    label: "Teleport shape",
                    kind: ParamKindDto::Enum { options: vec!["incoming", "outgoing", "bidirectional", "any"], default: "any" },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_split_count",
            label: "Maximum split count",
            description: "Fires if the total count of extra split nodes on the field exceeds the configured maximum.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_TILE_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "max_split_count",
                    label: "Max split count",
                    kind: ParamKindDto::Integer { default: MAX_SPLIT_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "max_split_density",
            label: "Maximum split density",
            description: "Fires if the share of field cells carrying extra split nodes exceeds the configured maximum.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_TILE_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "max_split_density",
                    label: "Max split density (per 100 cells)",
                    kind: ParamKindDto::Integer { default: MAX_SPLIT_DENSITY_DEFAULT as i64, min: 0, max: 100 },
                },
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "split_group_geometric_proximity",
            label: "Split group geometric proximity",
            description: "Fires if a pair of split tiles sit geometrically closer to each other than the required minimum distance.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_TILE_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "split_group_geometric_proximity_distance",
                    label: "Distance threshold",
                    kind: ParamKindDto::Float { default: SPLIT_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, min: 0.0, max: 100_000.0 },
                },
            ],
            // Multiple instances with different distance thresholds are a legitimate simultaneous
            // configuration -- same rationale as one_way_group_geometric_proximity's
            // allow_multiple_instances.
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "split_group_graph_proximity",
            label: "Split group graph proximity",
            description: "Fires if a pair of split tiles sit topologically closer to each other (tile-hops) than the required minimum distance.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_TILE_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "split_group_graph_proximity_distance",
                    label: "Distance threshold",
                    kind: ParamKindDto::Float { default: SPLIT_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT, min: 0.0, max: 100_000.0 },
                },
            ],
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "split_count",
            label: "Min count",
            description: "Fires if the maze has fewer split tiles (optionally filtered to a set of patterns) than the required minimum.",
            issue_kinds: vec![kind_str(MISSING_SPLIT_TILES)],
            params: vec![
                ParamDescriptor {
                    id: "split_count",
                    label: "Min count",
                    kind: ParamKindDto::Integer { default: SPLIT_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
                split_patterns_filter_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "split_density",
            label: "Min density",
            description: "Fires if too small a share of the field carries split tiles (optionally filtered to a set of patterns), converting the coverage deficit into a split tile count via an estimated tiles-per-split.",
            issue_kinds: vec![kind_str(MISSING_SPLIT_TILES)],
            params: vec![
                ParamDescriptor {
                    id: "split_density",
                    label: "Min density (per 100 cells)",
                    kind: ParamKindDto::Integer { default: SPLIT_DENSITY_DEFAULT as i64, min: 0, max: 100 },
                },
                ParamDescriptor {
                    id: "split_tile_estimate",
                    label: "Split tile coverage estimate",
                    kind: ParamKindDto::Integer { default: SPLIT_DENSITY_ESTIMATE_DEFAULT as i64, min: 1, max: 100_000 },
                },
                split_patterns_filter_param(),
            ],
            allow_multiple_instances: false,
        },
        CheckDescriptor {
            id: "split_node_connection_count",
            label: "Split node connection count",
            description: "Fires if a single split node's connection count (optionally filtered to a direction) compares against the configured threshold.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_NODE)],
            params: vec![
                ParamDescriptor {
                    id: "count",
                    label: "Connection count threshold",
                    kind: ParamKindDto::Integer { default: SPLIT_NODE_CONNECTION_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
                comparison_param(Comparison::Gt),
                ParamDescriptor {
                    id: "direction",
                    label: "Connection direction",
                    kind: ParamKindDto::Enum { options: vec!["incoming", "outgoing", "bidirectional", "any"], default: "any" },
                },
            ],
            // Multiple instances with different count/direction combinations are a legitimate
            // simultaneous configuration -- same rationale as split_distance_from_waypoint's
            // allow_multiple_instances.
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "split_node_connection_per_neighbor",
            label: "Split node connections per neighbor",
            description: "Fires if more than the configured number of connections from different nodes of the same split tile converge on the same single outside neighbor node.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_NODE_CONNECTION_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "max",
                    label: "Max connections per neighbor",
                    kind: ParamKindDto::Integer { default: SPLIT_NODE_CONNECTION_PER_NEIGHBOR_MAX_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "split_node_connection_per_face",
            label: "Split node connections per face",
            description: "Fires if more than the configured number of connections from different nodes of the same split tile go out through the same tile face direction.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_NODE_CONNECTION_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "max",
                    label: "Max connections per face",
                    kind: ParamKindDto::Integer { default: SPLIT_NODE_CONNECTION_PER_FACE_MAX_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "split_node_connection_traversal_distance",
            label: "Split node traversal distance",
            description: "Fires if a graph path shorter than the configured minimum detour connects two split nodes of the same split tile.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_ROUTE)],
            params: vec![
                ParamDescriptor {
                    id: "min_detour",
                    label: "Minimum detour length",
                    kind: ParamKindDto::Integer { default: SPLIT_NODE_CONNECTION_TRAVERSAL_DISTANCE_MIN_DETOUR_DEFAULT as i64, min: 1, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: true,
        },
        CheckDescriptor {
            id: "max_split_tile_node_count",
            label: "Max split tile node count",
            description: "Fires if a split tile's node count exceeds the configured maximum.",
            issue_kinds: vec![kind_str(INVALID_SPLIT_NODE_GROUP)],
            params: vec![
                ParamDescriptor {
                    id: "max",
                    label: "Max node count",
                    kind: ParamKindDto::Integer { default: MAX_SPLIT_TILE_NODE_COUNT_DEFAULT as i64, min: 0, max: 1_000_000 },
                },
            ],
            allow_multiple_instances: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

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
            vec!["one_way_group_geometric_proximity", "one_way_group_graph_proximity", "one_way_waypoint_distance", "split_distance_from_waypoint", "split_group_geometric_proximity", "split_group_graph_proximity", "split_node_connection_count", "split_node_connection_per_face", "split_node_connection_per_neighbor", "split_node_connection_traversal_distance", "teleport_group_proximity", "teleport_waypoint_distance"],
            "unexpected set of checks allowing multiple instances: {allowing:?}"
        );
    }
}
