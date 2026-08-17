use serde::Serialize;
use wasm_bindgen::prelude::*;
use maze_core::{
    space::SquareTessellation,
    quality_control::{MISSING_ENDPOINTS, INVALID_LOOP, INVALID_LOOP_GROUP, MISSING_LOOPS, REGION_NEEDS_EXPANSION, REGION_NEEDS_SHRINK, MISSING_REGIONS, EXCESSIVE_SCC_COUNT, INVALID_TELEPORT, INVALID_TELEPORT_GROUP, INVALID_ONE_WAY, INVALID_ONE_WAY_GROUP, MISSING_ONE_WAYS, MISSING_TELEPORTS, INVALID_SPLIT_TILE, INVALID_SPLIT_TILE_GROUP, MISSING_SPLIT_TILES, INVALID_SPLIT_NODE, INVALID_SPLIT_NODE_CONNECTION, INVALID_SPLIT_NODE_CONNECTION_GROUP, INVALID_SPLIT_NODE_GROUP, INVALID_SPLIT_ROUTE, INVALID_VERTICAL_PASSAGE, INVALID_VERTICAL_PASSAGE_GROUP, MISSING_VERTICAL_PASSAGES},
    repair::{RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy, InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, InvalidLoopGroupSelectStrategy, MissingLoopsRandomStrategy, MissingLoopsSplitStrategy, ExpandRegionPassageStrategy, TeleportRegionMergeStrategy, RegionShrinkSplitStrategy, MissingRegionsStrategy, ReduceSccCountStrategy, RemoveTeleportStrategy, TeleportGroupSelectStrategy, WeightedRegionMergeStrategy, PriorityRegionMergeStrategy, PriorityMissingLoopsStrategy, OneWayToPassageStrategy, OneWayToWallStrategy, OneWayGroupSelectStrategy, MissingOneWaysFromPassageStrategy, MissingOneWaysFromWallStrategy, MissingTeleportsStrategy, RemoveSplitStrategy, SplitGroupSelectStrategy, AddSplitStrategy, RemoveSplitNodeStrategy, RemoveSplitNodeConnectionStrategy, SplitNodeConnectionGroupSelectStrategy, SplitNodeGroupSelectStrategy, SplitRouteCutStrategy, AddVerticalPassageStrategy, RemoveVerticalPassageStrategy, VerticalPassageGroupSelectStrategy},
};
use crate::check_descriptor::{ParamDescriptor, ParamKindDto};

#[derive(Serialize)]
pub struct StrategyDescriptor {
    pub id: &'static str,
    pub handles: &'static str,
    pub params: Vec<ParamDescriptor>,
    /// Whether this strategy is experimental — see `RepairStrategy::is_experimental` in
    /// `maze-core`. UI shows a warning badge/bubble for these.
    pub experimental: bool,
    /// Mirrors `RepairStrategy::expected_nested()` — one entry per nested-strategy slot this
    /// strategy accepts. Empty for every strategy without nested slots (the overwhelming
    /// majority). The web UI resolves candidate nested strategies for a slot as
    /// `availableStrategies.filter(s => s.handles === slot.kind)`.
    pub nested_slots: Vec<NestedSlotDto>,
}

/// Mirrors `maze_core::repair::NestedDispatchKind` — see its doc comment for what each variant
/// means and why the UI needs it (which controls/labels to render per nested candidate).
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NestedDispatchKindDto {
    Unordered,
    Weighted,
    Priority,
}

fn dispatch_kind_dto(k: maze_core::repair::NestedDispatchKind) -> NestedDispatchKindDto {
    match k {
        maze_core::repair::NestedDispatchKind::Unordered => NestedDispatchKindDto::Unordered,
        maze_core::repair::NestedDispatchKind::Weighted => NestedDispatchKindDto::Weighted,
        maze_core::repair::NestedDispatchKind::Priority => NestedDispatchKindDto::Priority,
    }
}

#[derive(Serialize)]
pub struct NestedSlotDto {
    pub slot_id: &'static str,
    pub kind: &'static str,
    pub min: usize,
    pub max: Option<usize>,
    pub dispatch_kind: NestedDispatchKindDto,
}

fn nested_slots_dto(slots: &[maze_core::repair::NestedSlot]) -> Vec<NestedSlotDto> {
    slots.iter().map(|s| NestedSlotDto {
        slot_id: s.slot_id,
        kind: s.kind.as_str(),
        min: s.min,
        max: s.max,
        dispatch_kind: dispatch_kind_dto(s.dispatch_kind),
    }).collect()
}

fn param_kind_dto(kind: &maze_core::repair::StrategyParamKind) -> ParamKindDto {
    match kind {
        maze_core::repair::StrategyParamKind::Float { default, min, max } =>
            ParamKindDto::Float { default: *default, min: *min, max: *max },
        maze_core::repair::StrategyParamKind::Bool { default } =>
            ParamKindDto::Bool { default: *default },
        maze_core::repair::StrategyParamKind::Enum { options, default } =>
            ParamKindDto::Enum { options: options.to_vec(), default },
        maze_core::repair::StrategyParamKind::Interval { default_min, default_max, min, max } =>
            ParamKindDto::Interval { default_min: *default_min, default_max: *default_max, min: *min, max: *max },
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
pub fn available_strategies() -> JsValue {
    available_strategies_list().serialize(&serde_wasm_bindgen::Serializer::json_compatible()).unwrap()
}

/// The plain-Rust list `available_strategies` serializes — split out so native (non-wasm) code,
/// e.g. `codegen`'s `quality_i18n` module (GitHub issue #361), can enumerate every strategy id
/// without a JS runtime. Mirrors `checks_catalog::available_checks_list`'s split from
/// `available_checks`.
pub fn available_strategies_list() -> Vec<StrategyDescriptor> {
    vec![
        StrategyDescriptor {
            id: "random_endpoints",
            handles: MISSING_ENDPOINTS.as_str(),
            params: strategy_params_dto(<RandomEndpointsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingEndpointsIssue>>::params(&RandomEndpointsStrategy)),
            experimental: <RandomEndpointsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingEndpointsIssue>>::is_experimental(&RandomEndpointsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "farthest_endpoints",
            handles: MISSING_ENDPOINTS.as_str(),
            params: strategy_params_dto(<FarthestEndpointsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingEndpointsIssue>>::params(&FarthestEndpointsStrategy)),
            experimental: <FarthestEndpointsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingEndpointsIssue>>::is_experimental(&FarthestEndpointsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "scored_endpoints",
            handles: MISSING_ENDPOINTS.as_str(),
            params: strategy_params_dto(<ScoredEndpointsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingEndpointsIssue>>::params(&ScoredEndpointsStrategy)),
            experimental: <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingEndpointsIssue>>::is_experimental(&ScoredEndpointsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "invalid_loop_random",
            handles: INVALID_LOOP.as_str(),
            params: strategy_params_dto(<InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidLoopIssue>>::params(&InvalidLoopRandomStrategy)),
            experimental: <InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidLoopIssue>>::is_experimental(&InvalidLoopRandomStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "invalid_loop_scored",
            handles: INVALID_LOOP.as_str(),
            params: strategy_params_dto(<InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidLoopIssue>>::params(&InvalidLoopScoredStrategy)),
            experimental: <InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidLoopIssue>>::is_experimental(&InvalidLoopScoredStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "invalid_loop_group_select",
            handles: INVALID_LOOP_GROUP.as_str(),
            params: strategy_params_dto(<InvalidLoopGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidLoopGroupIssue>>::params(&InvalidLoopGroupSelectStrategy)),
            experimental: <InvalidLoopGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidLoopGroupIssue>>::is_experimental(&InvalidLoopGroupSelectStrategy),
            nested_slots: nested_slots_dto(<InvalidLoopGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidLoopGroupIssue>>::expected_nested(&InvalidLoopGroupSelectStrategy)),
        },
        StrategyDescriptor {
            id: "missing_loops_random",
            handles: MISSING_LOOPS.as_str(),
            params: strategy_params_dto(<MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy)),
            experimental: <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::is_experimental(&MissingLoopsRandomStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "missing_loops_split",
            handles: MISSING_LOOPS.as_str(),
            // MissingLoopsSplitStrategy's own generic StrategyParams (reserve_percent/protect_route/
            // max_attempts) plus its construction-time pattern-selection config (`config`), appended
            // manually as one `SplitGenerationConfig`-kind param — same convention as `add_split`
            // (see `maze-runner`'s `build_add_split_strategy`/`parse_split_config_param`).
            params: {
                let default_strategy = MissingLoopsSplitStrategy { config: Default::default() };
                let mut params = strategy_params_dto(<MissingLoopsSplitStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::params(&default_strategy));
                params.push(ParamDescriptor {
                    id: "split_config",
                    label: "Split settings",
                    kind: ParamKindDto::SplitGenerationConfig,
                });
                params
            },
            experimental: <MissingLoopsSplitStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::is_experimental(&MissingLoopsSplitStrategy { config: Default::default() }),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "priority_missing_loops",
            handles: MISSING_LOOPS.as_str(),
            params: strategy_params_dto(<PriorityMissingLoopsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::params(&PriorityMissingLoopsStrategy)),
            experimental: <PriorityMissingLoopsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::is_experimental(&PriorityMissingLoopsStrategy),
            nested_slots: nested_slots_dto(<PriorityMissingLoopsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::expected_nested(&PriorityMissingLoopsStrategy)),
        },
        StrategyDescriptor {
            id: "expand_region_passage",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(<ExpandRegionPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::params(&ExpandRegionPassageStrategy)),
            experimental: <ExpandRegionPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::is_experimental(&ExpandRegionPassageStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "teleport_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(<TeleportRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::params(&TeleportRegionMergeStrategy)),
            experimental: <TeleportRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::is_experimental(&TeleportRegionMergeStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "region_shrink_split",
            handles: REGION_NEEDS_SHRINK.as_str(),
            params: strategy_params_dto(<RegionShrinkSplitStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsShrinkIssue>>::params(&RegionShrinkSplitStrategy { protect_route: true })),
            experimental: <RegionShrinkSplitStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsShrinkIssue>>::is_experimental(&RegionShrinkSplitStrategy { protect_route: true }),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "missing_regions",
            handles: MISSING_REGIONS.as_str(),
            params: strategy_params_dto(<MissingRegionsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingRegionsIssue>>::params(&MissingRegionsStrategy)),
            experimental: <MissingRegionsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingRegionsIssue>>::is_experimental(&MissingRegionsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "reduce_scc_count",
            handles: EXCESSIVE_SCC_COUNT.as_str(),
            params: strategy_params_dto(<ReduceSccCountStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::ExcessiveSccCountIssue>>::params(&ReduceSccCountStrategy)),
            experimental: <ReduceSccCountStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::ExcessiveSccCountIssue>>::is_experimental(&ReduceSccCountStrategy),
            nested_slots: nested_slots_dto(<ReduceSccCountStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::ExcessiveSccCountIssue>>::expected_nested(&ReduceSccCountStrategy)),
        },
        StrategyDescriptor {
            id: "remove_teleport",
            handles: INVALID_TELEPORT.as_str(),
            params: strategy_params_dto(<RemoveTeleportStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidTeleportIssue>>::params(&RemoveTeleportStrategy)),
            experimental: <RemoveTeleportStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidTeleportIssue>>::is_experimental(&RemoveTeleportStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "teleport_group_select",
            handles: INVALID_TELEPORT_GROUP.as_str(),
            params: strategy_params_dto(<TeleportGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidTeleportGroupIssue>>::params(&TeleportGroupSelectStrategy { protect_route: true })),
            experimental: <TeleportGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidTeleportGroupIssue>>::is_experimental(&TeleportGroupSelectStrategy { protect_route: true }),
            nested_slots: nested_slots_dto(<TeleportGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidTeleportGroupIssue>>::expected_nested(&TeleportGroupSelectStrategy { protect_route: true })),
        },
        StrategyDescriptor {
            id: "one_way_to_passage",
            handles: INVALID_ONE_WAY.as_str(),
            params: strategy_params_dto(<OneWayToPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidOneWayIssue>>::params(&OneWayToPassageStrategy)),
            experimental: <OneWayToPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidOneWayIssue>>::is_experimental(&OneWayToPassageStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "one_way_to_wall",
            handles: INVALID_ONE_WAY.as_str(),
            params: strategy_params_dto(<OneWayToWallStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidOneWayIssue>>::params(&OneWayToWallStrategy)),
            experimental: <OneWayToWallStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidOneWayIssue>>::is_experimental(&OneWayToWallStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "one_way_group_select",
            handles: INVALID_ONE_WAY_GROUP.as_str(),
            params: strategy_params_dto(<OneWayGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidOneWayGroupIssue>>::params(&OneWayGroupSelectStrategy { protect_route: true })),
            experimental: <OneWayGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidOneWayGroupIssue>>::is_experimental(&OneWayGroupSelectStrategy { protect_route: true }),
            nested_slots: nested_slots_dto(<OneWayGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidOneWayGroupIssue>>::expected_nested(&OneWayGroupSelectStrategy { protect_route: true })),
        },
        StrategyDescriptor {
            id: "weighted_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(<WeightedRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::params(&WeightedRegionMergeStrategy)),
            experimental: <WeightedRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::is_experimental(&WeightedRegionMergeStrategy),
            nested_slots: nested_slots_dto(<WeightedRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::expected_nested(&WeightedRegionMergeStrategy)),
        },
        StrategyDescriptor {
            id: "priority_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(<PriorityRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::params(&PriorityRegionMergeStrategy)),
            experimental: <PriorityRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::is_experimental(&PriorityRegionMergeStrategy),
            nested_slots: nested_slots_dto(<PriorityRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::expected_nested(&PriorityRegionMergeStrategy)),
        },
        StrategyDescriptor {
            id: "missing_one_ways_from_passage",
            handles: MISSING_ONE_WAYS.as_str(),
            params: strategy_params_dto(<MissingOneWaysFromPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingOneWaysIssue>>::params(&MissingOneWaysFromPassageStrategy)),
            experimental: <MissingOneWaysFromPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingOneWaysIssue>>::is_experimental(&MissingOneWaysFromPassageStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "missing_one_ways_from_wall",
            handles: MISSING_ONE_WAYS.as_str(),
            params: strategy_params_dto(<MissingOneWaysFromWallStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingOneWaysIssue>>::params(&MissingOneWaysFromWallStrategy)),
            experimental: <MissingOneWaysFromWallStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingOneWaysIssue>>::is_experimental(&MissingOneWaysFromWallStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "missing_teleports",
            handles: MISSING_TELEPORTS.as_str(),
            params: strategy_params_dto(<MissingTeleportsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingTeleportsIssue>>::params(&MissingTeleportsStrategy)),
            experimental: <MissingTeleportsStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingTeleportsIssue>>::is_experimental(&MissingTeleportsStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "remove_split",
            handles: INVALID_SPLIT_TILE.as_str(),
            params: strategy_params_dto(<RemoveSplitStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitTileIssue>>::params(&RemoveSplitStrategy)),
            experimental: <RemoveSplitStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitTileIssue>>::is_experimental(&RemoveSplitStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "split_group_select",
            handles: INVALID_SPLIT_TILE_GROUP.as_str(),
            params: strategy_params_dto(<SplitGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitTileGroupIssue>>::params(&SplitGroupSelectStrategy)),
            experimental: <SplitGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitTileGroupIssue>>::is_experimental(&SplitGroupSelectStrategy),
            nested_slots: nested_slots_dto(<SplitGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitTileGroupIssue>>::expected_nested(&SplitGroupSelectStrategy)),
        },
        StrategyDescriptor {
            id: "add_split",
            handles: MISSING_SPLIT_TILES.as_str(),
            // AddSplitStrategy's own generic StrategyParams (allow_lose/allow_add_connections,
            // max_attempts) plus its construction-time pattern-selection config (`config`, GitHub
            // issue #247), appended manually as one `SplitGenerationConfig`-kind param since it
            // isn't a `StrategyParamKind` maze-core can express (no serde there to parse it) — see
            // `maze-runner`'s `build_add_split_strategy`/`parse_split_config_param`.
            params: {
                let default_strategy = AddSplitStrategy { config: Default::default(), protect_route: true };
                let mut params = strategy_params_dto(<AddSplitStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingSplitTilesIssue>>::params(&default_strategy));
                params.push(ParamDescriptor {
                    id: "split_config",
                    label: "Split settings",
                    kind: ParamKindDto::SplitGenerationConfig,
                });
                params
            },
            experimental: <AddSplitStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingSplitTilesIssue>>::is_experimental(&AddSplitStrategy { config: Default::default(), protect_route: true }),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "remove_split_node",
            handles: INVALID_SPLIT_NODE.as_str(),
            params: strategy_params_dto(<RemoveSplitNodeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeIssue>>::params(&RemoveSplitNodeStrategy)),
            experimental: <RemoveSplitNodeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeIssue>>::is_experimental(&RemoveSplitNodeStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "remove_split_node_connection",
            handles: INVALID_SPLIT_NODE_CONNECTION.as_str(),
            params: strategy_params_dto(<RemoveSplitNodeConnectionStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeConnectionIssue>>::params(&RemoveSplitNodeConnectionStrategy)),
            experimental: <RemoveSplitNodeConnectionStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeConnectionIssue>>::is_experimental(&RemoveSplitNodeConnectionStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "split_node_connection_group_select",
            handles: INVALID_SPLIT_NODE_CONNECTION_GROUP.as_str(),
            params: strategy_params_dto(<SplitNodeConnectionGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeConnectionGroupIssue>>::params(&SplitNodeConnectionGroupSelectStrategy)),
            experimental: <SplitNodeConnectionGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeConnectionGroupIssue>>::is_experimental(&SplitNodeConnectionGroupSelectStrategy),
            nested_slots: nested_slots_dto(<SplitNodeConnectionGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeConnectionGroupIssue>>::expected_nested(&SplitNodeConnectionGroupSelectStrategy)),
        },
        StrategyDescriptor {
            id: "split_node_group_select",
            handles: INVALID_SPLIT_NODE_GROUP.as_str(),
            params: strategy_params_dto(<SplitNodeGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeGroupIssue>>::params(&SplitNodeGroupSelectStrategy)),
            experimental: <SplitNodeGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeGroupIssue>>::is_experimental(&SplitNodeGroupSelectStrategy),
            nested_slots: nested_slots_dto(<SplitNodeGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitNodeGroupIssue>>::expected_nested(&SplitNodeGroupSelectStrategy)),
        },
        StrategyDescriptor {
            id: "split_route_cut",
            handles: INVALID_SPLIT_ROUTE.as_str(),
            params: strategy_params_dto(<SplitRouteCutStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitRouteIssue>>::params(&SplitRouteCutStrategy)),
            experimental: <SplitRouteCutStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitRouteIssue>>::is_experimental(&SplitRouteCutStrategy),
            nested_slots: nested_slots_dto(<SplitRouteCutStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidSplitRouteIssue>>::expected_nested(&SplitRouteCutStrategy)),
        },
        StrategyDescriptor {
            id: "add_vertical_passage",
            handles: MISSING_VERTICAL_PASSAGES.as_str(),
            params: strategy_params_dto(<AddVerticalPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingVerticalPassagesIssue>>::params(&AddVerticalPassageStrategy { passage_type: maze_core::quality_control::VerticalPassageType::Any })),
            experimental: <AddVerticalPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingVerticalPassagesIssue>>::is_experimental(&AddVerticalPassageStrategy { passage_type: maze_core::quality_control::VerticalPassageType::Any }),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "remove_vertical_passage",
            handles: INVALID_VERTICAL_PASSAGE.as_str(),
            params: strategy_params_dto(<RemoveVerticalPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidVerticalPassageIssue>>::params(&RemoveVerticalPassageStrategy)),
            experimental: <RemoveVerticalPassageStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidVerticalPassageIssue>>::is_experimental(&RemoveVerticalPassageStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "vertical_passage_group_select",
            handles: INVALID_VERTICAL_PASSAGE_GROUP.as_str(),
            params: strategy_params_dto(<VerticalPassageGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidVerticalPassageGroupIssue>>::params(&VerticalPassageGroupSelectStrategy)),
            experimental: <VerticalPassageGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidVerticalPassageGroupIssue>>::is_experimental(&VerticalPassageGroupSelectStrategy),
            nested_slots: nested_slots_dto(<VerticalPassageGroupSelectStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidVerticalPassageGroupIssue>>::expected_nested(&VerticalPassageGroupSelectStrategy)),
        },
    ]
}
