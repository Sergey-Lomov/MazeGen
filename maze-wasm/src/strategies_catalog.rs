use serde::Serialize;
use wasm_bindgen::prelude::*;
use maze_core::{
    space::SquareTessellation,
    quality_control::{MISSING_ENDPOINTS, INVALID_LOOP, MISSING_LOOPS, REGION_NEEDS_EXPANSION, MISSING_REGIONS, EXCESSIVE_SCC_COUNT, INVALID_TELEPORT, INVALID_TELEPORT_GROUP},
    repair::{RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy, InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, MissingLoopsRandomStrategy, ExpandRegionPassageStrategy, TeleportRegionMergeStrategy, MissingRegionsStrategy, ReduceSccCountStrategy, RemoveTeleportStrategy, TeleportGroupProximityStrategy, WeightedRegionMergeStrategy},
};
use crate::checks_catalog::{ParamDescriptor, ParamKindDto};

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

#[derive(Serialize)]
pub struct NestedSlotDto {
    pub slot_id: &'static str,
    pub kind: &'static str,
    pub min: usize,
    pub max: Option<usize>,
}

fn nested_slots_dto(slots: &[maze_core::repair::NestedSlot]) -> Vec<NestedSlotDto> {
    slots.iter().map(|s| NestedSlotDto {
        slot_id: s.slot_id,
        kind: s.kind.as_str(),
        min: s.min,
        max: s.max,
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
    let strategies: Vec<StrategyDescriptor> = vec![
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
            id: "missing_loops_random",
            handles: MISSING_LOOPS.as_str(),
            params: strategy_params_dto(<MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy)),
            experimental: <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::MissingLoopsIssue>>::is_experimental(&MissingLoopsRandomStrategy),
            nested_slots: vec![],
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
            id: "teleport_group_proximity",
            handles: INVALID_TELEPORT_GROUP.as_str(),
            params: strategy_params_dto(<TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidTeleportGroupIssue>>::params(&TeleportGroupProximityStrategy)),
            experimental: <TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::InvalidTeleportGroupIssue>>::is_experimental(&TeleportGroupProximityStrategy),
            nested_slots: vec![],
        },
        StrategyDescriptor {
            id: "weighted_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(<WeightedRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::params(&WeightedRegionMergeStrategy)),
            experimental: <WeightedRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::is_experimental(&WeightedRegionMergeStrategy),
            nested_slots: nested_slots_dto(<WeightedRegionMergeStrategy as RepairStrategy<SquareTessellation, maze_core::quality_control::RegionNeedsExpansionIssue>>::expected_nested(&WeightedRegionMergeStrategy)),
        },
    ];
    strategies.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).unwrap()
}
