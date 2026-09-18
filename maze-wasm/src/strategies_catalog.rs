use crate::check_descriptor::{EntityVisibility, ParamDescriptor, ParamKindDto};
use maze_core::{
    quality_control::{
        AREA_MISSING_ELEVATOR_STOPS, EXCESSIVE_ELEVATOR_STOP_GAP, EXCESSIVE_SCC_COUNT,
        INVALID_CROSS_ELEMENT_GROUP, INVALID_ELEVATOR, INVALID_ELEVATOR_GROUP,
        INVALID_ELEVATOR_STOP, INVALID_ELEVATOR_STOP_GROUP, INVALID_LOOP, INVALID_LOOP_GROUP,
        INVALID_ONE_WAY, INVALID_ONE_WAY_GROUP, INVALID_SPLIT_NODE, INVALID_SPLIT_NODE_CONNECTION,
        INVALID_SPLIT_NODE_CONNECTION_GROUP, INVALID_SPLIT_NODE_GROUP, INVALID_SPLIT_ROUTE,
        INVALID_SPLIT_TILE, INVALID_SPLIT_TILE_GROUP, INVALID_TELEPORT, INVALID_TELEPORT_GROUP,
        INVALID_VERTICAL_PASSAGE, INVALID_VERTICAL_PASSAGE_GROUP, MISSING_ELEVATOR_HEIGHT,
        MISSING_ELEVATOR_STOP_COUNT, MISSING_ELEVATORS, MISSING_ENDPOINTS, MISSING_LOOPS,
        MISSING_ONE_WAYS, MISSING_REGIONS, MISSING_SPLIT_TILES, MISSING_TELEPORTS,
        MISSING_VERTICAL_PASSAGES, REGION_NEEDS_EXPANSION, REGION_NEEDS_SHRINK,
    },
    repair::{
        AddElevatorHeightStopStrategy, AddElevatorStopCountStrategy, AddElevatorStopForGapStrategy,
        AddElevatorStopStrategy, AddElevatorStrategy, AddSplitStrategy, AddVerticalPassageStrategy,
        CrossElementGroupSelectStrategy, ElevatorGroupSelectStrategy, ElevatorRegionMergeStrategy,
        ElevatorStopGroupSelectStrategy, ExpandRegionPassageStrategy, FarthestEndpointsStrategy,
        InvalidLoopGroupSelectStrategy, InvalidLoopRandomStrategy, InvalidLoopScoredStrategy,
        MissingLoopsRandomStrategy, MissingLoopsSplitStrategy, MissingLoopsTeleportStrategy,
        MissingLoopsVerticalStrategy, MissingOneWaysFromPassageStrategy,
        MissingOneWaysFromWallStrategy, MissingRegionsStrategy, MissingTeleportsStrategy,
        OneWayGroupSelectStrategy, OneWayToPassageStrategy, OneWayToWallStrategy,
        PriorityMissingLoopsStrategy, PriorityRegionMergeStrategy, RandomEndpointsStrategy,
        ReduceSccCountStrategy, RegionShrinkSplitStrategy, RemoveElevatorStopStrategy,
        RemoveElevatorStrategy, RemoveSplitNodeConnectionStrategy, RemoveSplitNodeStrategy,
        RemoveSplitStrategy, RemoveTeleportStrategy, RemoveVerticalPassageStrategy, RepairStrategy,
        ReplaceElevatorWithPassagesStrategy, ScoredEndpointsStrategy, SplitGroupSelectStrategy,
        SplitNodeConnectionGroupSelectStrategy, SplitNodeGroupSelectStrategy,
        SplitRouteCutStrategy, TeleportGroupSelectStrategy, TeleportRegionMergeStrategy,
        VerticalPassageGroupSelectStrategy, VerticalPassageRegionMergeStrategy,
        WeightedRegionMergeStrategy,
    },
    space::SquareTessellation,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

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
    /// Mirrors `RepairStrategy::nested_suppressed_params()` — param ids the web UI must hide (and
    /// the dispatcher strips) when this strategy runs *nested under a dispatcher*, because the
    /// dispatcher owns them (GitHub issue #486). Empty for every strategy without dispatcher-owned
    /// params (the majority). At the top level (a rule's own strategy) every param stays visible.
    pub nested_suppressed_params: &'static [&'static str],
    /// `None` means always offered — see `EntityVisibility`'s own doc comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<EntityVisibility>,
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
    slots
        .iter()
        .map(|s| NestedSlotDto {
            slot_id: s.slot_id,
            kind: s.kind.as_str(),
            min: s.min,
            max: s.max,
            dispatch_kind: dispatch_kind_dto(s.dispatch_kind),
        })
        .collect()
}

fn param_kind_dto(kind: &maze_core::repair::StrategyParamKind) -> ParamKindDto {
    match kind {
        maze_core::repair::StrategyParamKind::Float { default, min, max } => ParamKindDto::Float {
            default: *default,
            min: *min,
            max: *max,
        },
        maze_core::repair::StrategyParamKind::Bool { default } => {
            ParamKindDto::Bool { default: *default }
        }
        maze_core::repair::StrategyParamKind::Enum { options, default } => ParamKindDto::Enum {
            options: options.to_vec(),
            default,
        },
        maze_core::repair::StrategyParamKind::Interval {
            default_min,
            default_max,
            min,
            max,
        } => ParamKindDto::Interval {
            default_min: *default_min,
            default_max: *default_max,
            min: *min,
            max: *max,
        },
        maze_core::repair::StrategyParamKind::Priority { default } => ParamKindDto::Priority {
            default: default.as_str(),
        },
    }
}

/// `visibility_overrides` stamps `EntityVisibility` onto specific param ids by name (GitHub issue
/// #349) — `StrategyParam` itself carries no visibility (core stays UI-agnostic, see
/// `EntityVisibility`'s own doc comment), so this is the one place a wasm-side catalog entry can
/// attach it to a param that otherwise comes straight from `RepairStrategy::params()`. Empty for
/// every strategy without a conditionally-visible param.
fn strategy_params_dto(
    params: &[maze_core::repair::StrategyParam],
    visibility_overrides: &[(&str, EntityVisibility)],
) -> Vec<ParamDescriptor> {
    params
        .iter()
        .map(|p| ParamDescriptor {
            id: p.id,
            label: p.label,
            kind: param_kind_dto(&p.kind),
            visibility: visibility_overrides
                .iter()
                .find(|(id, _)| *id == p.id)
                .map(|(_, v)| *v),
        })
        .collect()
}

#[wasm_bindgen]
pub fn available_strategies() -> JsValue {
    available_strategies_list()
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .unwrap()
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
            params: strategy_params_dto(
                <RandomEndpointsStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingEndpointsIssue,
                >>::params(&RandomEndpointsStrategy),
                &[],
            ),
            experimental: <RandomEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingEndpointsIssue,
            >>::is_experimental(&RandomEndpointsStrategy),
            nested_suppressed_params: <RandomEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingEndpointsIssue,
            >>::nested_suppressed_params(
                &RandomEndpointsStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "farthest_endpoints",
            handles: MISSING_ENDPOINTS.as_str(),
            params: strategy_params_dto(
                <FarthestEndpointsStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingEndpointsIssue,
                >>::params(&FarthestEndpointsStrategy),
                &[],
            ),
            experimental: <FarthestEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingEndpointsIssue,
            >>::is_experimental(&FarthestEndpointsStrategy),
            nested_suppressed_params: <FarthestEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingEndpointsIssue,
            >>::nested_suppressed_params(
                &FarthestEndpointsStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "scored_endpoints",
            handles: MISSING_ENDPOINTS.as_str(),
            params: strategy_params_dto(
                <ScoredEndpointsStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingEndpointsIssue,
                >>::params(&ScoredEndpointsStrategy),
                &[
                    ("cross_floor_weight", EntityVisibility::MultiFloorOnly),
                    ("elevator_stop_weight", EntityVisibility::MultiFloorOnly),
                ],
            ),
            experimental: <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingEndpointsIssue,
            >>::is_experimental(&ScoredEndpointsStrategy),
            nested_suppressed_params: <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingEndpointsIssue,
            >>::nested_suppressed_params(
                &ScoredEndpointsStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "invalid_loop_random",
            handles: INVALID_LOOP.as_str(),
            params: strategy_params_dto(
                <InvalidLoopRandomStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidLoopIssue,
                >>::params(&InvalidLoopRandomStrategy),
                &[(
                    "vertical_passage_priority",
                    EntityVisibility::MultiFloorOnly,
                )],
            ),
            experimental: <InvalidLoopRandomStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidLoopIssue,
            >>::is_experimental(&InvalidLoopRandomStrategy),
            nested_suppressed_params: <InvalidLoopRandomStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidLoopIssue,
            >>::nested_suppressed_params(
                &InvalidLoopRandomStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "invalid_loop_scored",
            handles: INVALID_LOOP.as_str(),
            params: strategy_params_dto(
                <InvalidLoopScoredStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidLoopIssue,
                >>::params(&InvalidLoopScoredStrategy),
                &[(
                    "vertical_passage_priority",
                    EntityVisibility::MultiFloorOnly,
                )],
            ),
            experimental: <InvalidLoopScoredStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidLoopIssue,
            >>::is_experimental(&InvalidLoopScoredStrategy),
            nested_suppressed_params: <InvalidLoopScoredStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidLoopIssue,
            >>::nested_suppressed_params(
                &InvalidLoopScoredStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "invalid_loop_group_select",
            handles: INVALID_LOOP_GROUP.as_str(),
            params: strategy_params_dto(
                <InvalidLoopGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidLoopGroupIssue,
                >>::params(&InvalidLoopGroupSelectStrategy),
                &[],
            ),
            experimental: <InvalidLoopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidLoopGroupIssue,
            >>::is_experimental(&InvalidLoopGroupSelectStrategy),
            nested_suppressed_params: <InvalidLoopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidLoopGroupIssue,
            >>::nested_suppressed_params(
                &InvalidLoopGroupSelectStrategy
            ),
            nested_slots: nested_slots_dto(<InvalidLoopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidLoopGroupIssue,
            >>::expected_nested(
                &InvalidLoopGroupSelectStrategy
            )),
            visibility: None,
        },
        StrategyDescriptor {
            id: "missing_loops_random",
            handles: MISSING_LOOPS.as_str(),
            params: strategy_params_dto(
                <MissingLoopsRandomStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingLoopsIssue,
                >>::params(&MissingLoopsRandomStrategy),
                &[],
            ),
            experimental: <MissingLoopsRandomStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::is_experimental(&MissingLoopsRandomStrategy),
            nested_suppressed_params: <MissingLoopsRandomStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::nested_suppressed_params(
                &MissingLoopsRandomStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "missing_loops_vertical",
            handles: MISSING_LOOPS.as_str(),
            params: strategy_params_dto(
                <MissingLoopsVerticalStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingLoopsIssue,
                >>::params(&MissingLoopsVerticalStrategy),
                &[(
                    "vertical_loop_one_way_chance",
                    EntityVisibility::MultiFloorOnly,
                )],
            ),
            experimental: <MissingLoopsVerticalStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::is_experimental(&MissingLoopsVerticalStrategy),
            nested_suppressed_params: <MissingLoopsVerticalStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::nested_suppressed_params(
                &MissingLoopsVerticalStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "missing_loops_split",
            handles: MISSING_LOOPS.as_str(),
            // MissingLoopsSplitStrategy's own generic StrategyParams (the standard add-strategy set:
            // reserve_percent/src_mode/attempts_limit — GitHub issue #486) plus its construction-time
            // pattern-selection config (`config`), appended
            // manually as one `SplitGenerationConfig`-kind param — same convention as `add_split`
            // (see `maze-runner`'s `build_add_split_strategy`/`parse_split_config_param`).
            params: {
                let default_strategy = MissingLoopsSplitStrategy {
                    config: Default::default(),
                };
                let mut params = strategy_params_dto(
                    <MissingLoopsSplitStrategy as RepairStrategy<
                        SquareTessellation,
                        maze_core::quality_control::MissingLoopsIssue,
                    >>::params(&default_strategy),
                    &[],
                );
                params.push(ParamDescriptor {
                    id: "split_config",
                    label: "Split settings",
                    kind: ParamKindDto::SplitGenerationConfig,
                    visibility: None,
                });
                params
            },
            experimental: <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::is_experimental(&MissingLoopsSplitStrategy {
                config: Default::default(),
            }),
            nested_suppressed_params: <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::nested_suppressed_params(
                &MissingLoopsSplitStrategy {
                    config: Default::default(),
                },
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "missing_loops_teleport",
            handles: MISSING_LOOPS.as_str(),
            params: strategy_params_dto(
                <MissingLoopsTeleportStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingLoopsIssue,
                >>::params(&MissingLoopsTeleportStrategy),
                &[],
            ),
            experimental: <MissingLoopsTeleportStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::is_experimental(&MissingLoopsTeleportStrategy),
            nested_suppressed_params: <MissingLoopsTeleportStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::nested_suppressed_params(
                &MissingLoopsTeleportStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "priority_missing_loops",
            handles: MISSING_LOOPS.as_str(),
            params: strategy_params_dto(
                <PriorityMissingLoopsStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingLoopsIssue,
                >>::params(&PriorityMissingLoopsStrategy),
                &[],
            ),
            experimental: <PriorityMissingLoopsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::is_experimental(&PriorityMissingLoopsStrategy),
            nested_suppressed_params: <PriorityMissingLoopsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::nested_suppressed_params(
                &PriorityMissingLoopsStrategy
            ),
            nested_slots: nested_slots_dto(<PriorityMissingLoopsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingLoopsIssue,
            >>::expected_nested(
                &PriorityMissingLoopsStrategy
            )),
            visibility: None,
        },
        StrategyDescriptor {
            id: "expand_region_passage",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(
                <ExpandRegionPassageStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::RegionNeedsExpansionIssue,
                >>::params(&ExpandRegionPassageStrategy),
                &[],
            ),
            experimental: <ExpandRegionPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::is_experimental(&ExpandRegionPassageStrategy),
            nested_suppressed_params: <ExpandRegionPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::nested_suppressed_params(
                &ExpandRegionPassageStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "vertical_passage_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(
                <VerticalPassageRegionMergeStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::RegionNeedsExpansionIssue,
                >>::params(&VerticalPassageRegionMergeStrategy),
                &[],
            ),
            experimental: <VerticalPassageRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::is_experimental(&VerticalPassageRegionMergeStrategy),
            nested_suppressed_params: <VerticalPassageRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::nested_suppressed_params(
                &VerticalPassageRegionMergeStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "elevator_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(
                <ElevatorRegionMergeStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::RegionNeedsExpansionIssue,
                >>::params(&ElevatorRegionMergeStrategy),
                &[],
            ),
            experimental: <ElevatorRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::is_experimental(&ElevatorRegionMergeStrategy),
            nested_suppressed_params: <ElevatorRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::nested_suppressed_params(
                &ElevatorRegionMergeStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "teleport_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(
                <TeleportRegionMergeStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::RegionNeedsExpansionIssue,
                >>::params(&TeleportRegionMergeStrategy),
                &[],
            ),
            experimental: <TeleportRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::is_experimental(&TeleportRegionMergeStrategy),
            nested_suppressed_params: <TeleportRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::nested_suppressed_params(
                &TeleportRegionMergeStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "region_shrink_split",
            handles: REGION_NEEDS_SHRINK.as_str(),
            params: strategy_params_dto(
                <RegionShrinkSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::RegionNeedsShrinkIssue,
                >>::params(&RegionShrinkSplitStrategy {
                    protect_route: true,
                }),
                &[],
            ),
            experimental: <RegionShrinkSplitStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsShrinkIssue,
            >>::is_experimental(&RegionShrinkSplitStrategy {
                protect_route: true,
            }),
            nested_suppressed_params: <RegionShrinkSplitStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsShrinkIssue,
            >>::nested_suppressed_params(
                &RegionShrinkSplitStrategy {
                    protect_route: true,
                },
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "missing_regions",
            handles: MISSING_REGIONS.as_str(),
            params: strategy_params_dto(
                <MissingRegionsStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingRegionsIssue,
                >>::params(&MissingRegionsStrategy),
                &[],
            ),
            experimental: <MissingRegionsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingRegionsIssue,
            >>::is_experimental(&MissingRegionsStrategy),
            nested_suppressed_params: <MissingRegionsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingRegionsIssue,
            >>::nested_suppressed_params(
                &MissingRegionsStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "reduce_scc_count",
            handles: EXCESSIVE_SCC_COUNT.as_str(),
            params: strategy_params_dto(
                <ReduceSccCountStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::ExcessiveSccCountIssue,
                >>::params(&ReduceSccCountStrategy),
                &[],
            ),
            experimental: <ReduceSccCountStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::ExcessiveSccCountIssue,
            >>::is_experimental(&ReduceSccCountStrategy),
            nested_suppressed_params: <ReduceSccCountStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::ExcessiveSccCountIssue,
            >>::nested_suppressed_params(
                &ReduceSccCountStrategy
            ),
            nested_slots: nested_slots_dto(<ReduceSccCountStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::ExcessiveSccCountIssue,
            >>::expected_nested(&ReduceSccCountStrategy)),
            visibility: None,
        },
        StrategyDescriptor {
            id: "remove_teleport",
            handles: INVALID_TELEPORT.as_str(),
            params: strategy_params_dto(
                <RemoveTeleportStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidTeleportIssue,
                >>::params(&RemoveTeleportStrategy),
                &[],
            ),
            experimental: <RemoveTeleportStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidTeleportIssue,
            >>::is_experimental(&RemoveTeleportStrategy),
            nested_suppressed_params: <RemoveTeleportStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidTeleportIssue,
            >>::nested_suppressed_params(
                &RemoveTeleportStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "teleport_group_select",
            handles: INVALID_TELEPORT_GROUP.as_str(),
            params: strategy_params_dto(
                <TeleportGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidTeleportGroupIssue,
                >>::params(&TeleportGroupSelectStrategy {
                    protect_route: true,
                }),
                &[],
            ),
            experimental: <TeleportGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidTeleportGroupIssue,
            >>::is_experimental(&TeleportGroupSelectStrategy {
                protect_route: true,
            }),
            nested_suppressed_params: <TeleportGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidTeleportGroupIssue,
            >>::nested_suppressed_params(
                &TeleportGroupSelectStrategy {
                    protect_route: true,
                },
            ),
            nested_slots: nested_slots_dto(<TeleportGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidTeleportGroupIssue,
            >>::expected_nested(
                &TeleportGroupSelectStrategy {
                    protect_route: true,
                },
            )),
            visibility: None,
        },
        StrategyDescriptor {
            id: "one_way_to_passage",
            handles: INVALID_ONE_WAY.as_str(),
            params: strategy_params_dto(
                <OneWayToPassageStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidOneWayIssue,
                >>::params(&OneWayToPassageStrategy),
                &[],
            ),
            experimental: <OneWayToPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidOneWayIssue,
            >>::is_experimental(&OneWayToPassageStrategy),
            nested_suppressed_params: <OneWayToPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidOneWayIssue,
            >>::nested_suppressed_params(
                &OneWayToPassageStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "one_way_to_wall",
            handles: INVALID_ONE_WAY.as_str(),
            params: strategy_params_dto(
                <OneWayToWallStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidOneWayIssue,
                >>::params(&OneWayToWallStrategy),
                &[],
            ),
            experimental: <OneWayToWallStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidOneWayIssue,
            >>::is_experimental(&OneWayToWallStrategy),
            nested_suppressed_params: <OneWayToWallStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidOneWayIssue,
            >>::nested_suppressed_params(
                &OneWayToWallStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "one_way_group_select",
            handles: INVALID_ONE_WAY_GROUP.as_str(),
            params: strategy_params_dto(
                <OneWayGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidOneWayGroupIssue,
                >>::params(&OneWayGroupSelectStrategy {
                    protect_route: true,
                }),
                &[],
            ),
            experimental: <OneWayGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidOneWayGroupIssue,
            >>::is_experimental(&OneWayGroupSelectStrategy {
                protect_route: true,
            }),
            nested_suppressed_params: <OneWayGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidOneWayGroupIssue,
            >>::nested_suppressed_params(
                &OneWayGroupSelectStrategy {
                    protect_route: true,
                },
            ),
            nested_slots: nested_slots_dto(<OneWayGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidOneWayGroupIssue,
            >>::expected_nested(
                &OneWayGroupSelectStrategy {
                    protect_route: true,
                },
            )),
            visibility: None,
        },
        StrategyDescriptor {
            id: "weighted_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(
                <WeightedRegionMergeStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::RegionNeedsExpansionIssue,
                >>::params(&WeightedRegionMergeStrategy),
                &[],
            ),
            experimental: <WeightedRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::is_experimental(&WeightedRegionMergeStrategy),
            nested_suppressed_params: <WeightedRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::nested_suppressed_params(
                &WeightedRegionMergeStrategy
            ),
            nested_slots: nested_slots_dto(<WeightedRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::expected_nested(
                &WeightedRegionMergeStrategy
            )),
            visibility: None,
        },
        StrategyDescriptor {
            id: "priority_region_merge",
            handles: REGION_NEEDS_EXPANSION.as_str(),
            params: strategy_params_dto(
                <PriorityRegionMergeStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::RegionNeedsExpansionIssue,
                >>::params(&PriorityRegionMergeStrategy),
                &[],
            ),
            experimental: <PriorityRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::is_experimental(&PriorityRegionMergeStrategy),
            nested_suppressed_params: <PriorityRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::nested_suppressed_params(
                &PriorityRegionMergeStrategy
            ),
            nested_slots: nested_slots_dto(<PriorityRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::RegionNeedsExpansionIssue,
            >>::expected_nested(
                &PriorityRegionMergeStrategy
            )),
            visibility: None,
        },
        StrategyDescriptor {
            id: "missing_one_ways_from_passage",
            handles: MISSING_ONE_WAYS.as_str(),
            params: strategy_params_dto(
                <MissingOneWaysFromPassageStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingOneWaysIssue,
                >>::params(&MissingOneWaysFromPassageStrategy),
                &[],
            ),
            experimental: <MissingOneWaysFromPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingOneWaysIssue,
            >>::is_experimental(&MissingOneWaysFromPassageStrategy),
            nested_suppressed_params: <MissingOneWaysFromPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingOneWaysIssue,
            >>::nested_suppressed_params(
                &MissingOneWaysFromPassageStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "missing_one_ways_from_wall",
            handles: MISSING_ONE_WAYS.as_str(),
            params: strategy_params_dto(
                <MissingOneWaysFromWallStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingOneWaysIssue,
                >>::params(&MissingOneWaysFromWallStrategy),
                &[],
            ),
            experimental: <MissingOneWaysFromWallStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingOneWaysIssue,
            >>::is_experimental(&MissingOneWaysFromWallStrategy),
            nested_suppressed_params: <MissingOneWaysFromWallStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingOneWaysIssue,
            >>::nested_suppressed_params(
                &MissingOneWaysFromWallStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "missing_teleports",
            handles: MISSING_TELEPORTS.as_str(),
            // `cross_floor_mode`/`cross_floor_balance` (GitHub issue #381) only matter when a
            // teleport can actually land on a different floor -- meaningless with 1 floor (GitHub
            // issue #349 follow-up).
            params: strategy_params_dto(
                <MissingTeleportsStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingTeleportsIssue,
                >>::params(&MissingTeleportsStrategy),
                &[
                    ("cross_floor_mode", EntityVisibility::MultiFloorOnly),
                    ("cross_floor_balance", EntityVisibility::MultiFloorOnly),
                ],
            ),
            experimental: <MissingTeleportsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingTeleportsIssue,
            >>::is_experimental(&MissingTeleportsStrategy),
            nested_suppressed_params: <MissingTeleportsStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingTeleportsIssue,
            >>::nested_suppressed_params(
                &MissingTeleportsStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "remove_split",
            handles: INVALID_SPLIT_TILE.as_str(),
            params: strategy_params_dto(
                <RemoveSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidSplitTileIssue,
                >>::params(&RemoveSplitStrategy),
                &[],
            ),
            experimental: <RemoveSplitStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitTileIssue,
            >>::is_experimental(&RemoveSplitStrategy),
            nested_suppressed_params: <RemoveSplitStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitTileIssue,
            >>::nested_suppressed_params(&RemoveSplitStrategy),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "split_group_select",
            handles: INVALID_SPLIT_TILE_GROUP.as_str(),
            params: strategy_params_dto(
                <SplitGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidSplitTileGroupIssue,
                >>::params(&SplitGroupSelectStrategy),
                &[],
            ),
            experimental: <SplitGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitTileGroupIssue,
            >>::is_experimental(&SplitGroupSelectStrategy),
            nested_suppressed_params: <SplitGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitTileGroupIssue,
            >>::nested_suppressed_params(
                &SplitGroupSelectStrategy
            ),
            nested_slots: nested_slots_dto(<SplitGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitTileGroupIssue,
            >>::expected_nested(
                &SplitGroupSelectStrategy
            )),
            visibility: None,
        },
        StrategyDescriptor {
            id: "add_split",
            handles: MISSING_SPLIT_TILES.as_str(),
            // AddSplitStrategy's own generic StrategyParams (allow_lose/allow_add_connections plus
            // the standard add-strategy set: reserve_percent/src_mode/attempts_limit — GitHub issue
            // #486) plus its own construction-time param (GitHub issue #389: no longer a
            // `SplitGenerationConfig` — pattern topology moved to the rule-level `split_patterns`
            // param; this strategy only owns `max_split_nodes`/`pattern_weights`), appended
            // manually as one `AddSplitConfig`-kind param since it isn't a `StrategyParamKind`
            // maze-core can express (no serde there to parse it) — see `maze-runner`'s
            // `build_add_split_strategy`.
            params: {
                let default_strategy = AddSplitStrategy {
                    split_patterns: vec![],
                    max_split_nodes: 2,
                    pattern_weights: vec![],
                    protect_route: true,
                };
                let mut params = strategy_params_dto(
                    <AddSplitStrategy as RepairStrategy<
                        SquareTessellation,
                        maze_core::quality_control::MissingSplitTilesIssue,
                    >>::params(&default_strategy),
                    &[],
                );
                params.push(ParamDescriptor {
                    id: "split_config",
                    label: "Split settings",
                    kind: ParamKindDto::AddSplitConfig {
                        max_split_nodes_default: default_strategy.max_split_nodes,
                    },
                    visibility: None,
                });
                params
            },
            experimental: <AddSplitStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingSplitTilesIssue,
            >>::is_experimental(&AddSplitStrategy {
                split_patterns: vec![],
                max_split_nodes: 2,
                pattern_weights: vec![],
                protect_route: true,
            }),
            nested_suppressed_params: <AddSplitStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingSplitTilesIssue,
            >>::nested_suppressed_params(&AddSplitStrategy {
                split_patterns: vec![],
                max_split_nodes: 2,
                pattern_weights: vec![],
                protect_route: true,
            }),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "remove_split_node",
            handles: INVALID_SPLIT_NODE.as_str(),
            params: strategy_params_dto(
                <RemoveSplitNodeStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidSplitNodeIssue,
                >>::params(&RemoveSplitNodeStrategy),
                &[],
            ),
            experimental: <RemoveSplitNodeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeIssue,
            >>::is_experimental(&RemoveSplitNodeStrategy),
            nested_suppressed_params: <RemoveSplitNodeStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeIssue,
            >>::nested_suppressed_params(
                &RemoveSplitNodeStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "remove_split_node_connection",
            handles: INVALID_SPLIT_NODE_CONNECTION.as_str(),
            params: strategy_params_dto(
                <RemoveSplitNodeConnectionStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidSplitNodeConnectionIssue,
                >>::params(&RemoveSplitNodeConnectionStrategy),
                &[],
            ),
            experimental: <RemoveSplitNodeConnectionStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeConnectionIssue,
            >>::is_experimental(&RemoveSplitNodeConnectionStrategy),
            nested_suppressed_params: <RemoveSplitNodeConnectionStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeConnectionIssue,
            >>::nested_suppressed_params(
                &RemoveSplitNodeConnectionStrategy
            ),
            nested_slots: vec![],
            visibility: None,
        },
        StrategyDescriptor {
            id: "split_node_connection_group_select",
            handles: INVALID_SPLIT_NODE_CONNECTION_GROUP.as_str(),
            params: strategy_params_dto(
                <SplitNodeConnectionGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidSplitNodeConnectionGroupIssue,
                >>::params(&SplitNodeConnectionGroupSelectStrategy),
                &[],
            ),
            experimental: <SplitNodeConnectionGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeConnectionGroupIssue,
            >>::is_experimental(&SplitNodeConnectionGroupSelectStrategy),
            nested_suppressed_params: <SplitNodeConnectionGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeConnectionGroupIssue,
            >>::nested_suppressed_params(
                &SplitNodeConnectionGroupSelectStrategy
            ),
            nested_slots: nested_slots_dto(
                <SplitNodeConnectionGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidSplitNodeConnectionGroupIssue,
                >>::expected_nested(&SplitNodeConnectionGroupSelectStrategy),
            ),
            visibility: None,
        },
        StrategyDescriptor {
            id: "split_node_group_select",
            handles: INVALID_SPLIT_NODE_GROUP.as_str(),
            params: strategy_params_dto(
                <SplitNodeGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidSplitNodeGroupIssue,
                >>::params(&SplitNodeGroupSelectStrategy),
                &[],
            ),
            experimental: <SplitNodeGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeGroupIssue,
            >>::is_experimental(&SplitNodeGroupSelectStrategy),
            nested_suppressed_params: <SplitNodeGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeGroupIssue,
            >>::nested_suppressed_params(
                &SplitNodeGroupSelectStrategy
            ),
            nested_slots: nested_slots_dto(<SplitNodeGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitNodeGroupIssue,
            >>::expected_nested(
                &SplitNodeGroupSelectStrategy
            )),
            visibility: None,
        },
        StrategyDescriptor {
            id: "split_route_cut",
            handles: INVALID_SPLIT_ROUTE.as_str(),
            params: strategy_params_dto(
                <SplitRouteCutStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidSplitRouteIssue,
                >>::params(&SplitRouteCutStrategy),
                &[],
            ),
            experimental: <SplitRouteCutStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitRouteIssue,
            >>::is_experimental(&SplitRouteCutStrategy),
            nested_suppressed_params: <SplitRouteCutStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitRouteIssue,
            >>::nested_suppressed_params(
                &SplitRouteCutStrategy
            ),
            nested_slots: nested_slots_dto(<SplitRouteCutStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidSplitRouteIssue,
            >>::expected_nested(&SplitRouteCutStrategy)),
            visibility: None,
        },
        StrategyDescriptor {
            id: "add_vertical_passage",
            handles: MISSING_VERTICAL_PASSAGES.as_str(),
            params: strategy_params_dto(
                <AddVerticalPassageStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingVerticalPassagesIssue,
                >>::params(&AddVerticalPassageStrategy {
                    passage_type: maze_core::quality_control::VerticalPassageType::Any,
                }),
                &[],
            ),
            experimental: <AddVerticalPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingVerticalPassagesIssue,
            >>::is_experimental(&AddVerticalPassageStrategy {
                passage_type: maze_core::quality_control::VerticalPassageType::Any,
            }),
            nested_suppressed_params: <AddVerticalPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingVerticalPassagesIssue,
            >>::nested_suppressed_params(
                &AddVerticalPassageStrategy {
                    passage_type: maze_core::quality_control::VerticalPassageType::Any,
                },
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "remove_vertical_passage",
            handles: INVALID_VERTICAL_PASSAGE.as_str(),
            params: strategy_params_dto(
                <RemoveVerticalPassageStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidVerticalPassageIssue,
                >>::params(&RemoveVerticalPassageStrategy),
                &[],
            ),
            experimental: <RemoveVerticalPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidVerticalPassageIssue,
            >>::is_experimental(&RemoveVerticalPassageStrategy),
            nested_suppressed_params: <RemoveVerticalPassageStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidVerticalPassageIssue,
            >>::nested_suppressed_params(
                &RemoveVerticalPassageStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "vertical_passage_group_select",
            handles: INVALID_VERTICAL_PASSAGE_GROUP.as_str(),
            params: strategy_params_dto(
                <VerticalPassageGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidVerticalPassageGroupIssue,
                >>::params(&VerticalPassageGroupSelectStrategy),
                &[],
            ),
            experimental: <VerticalPassageGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidVerticalPassageGroupIssue,
            >>::is_experimental(&VerticalPassageGroupSelectStrategy),
            nested_suppressed_params: <VerticalPassageGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidVerticalPassageGroupIssue,
            >>::nested_suppressed_params(
                &VerticalPassageGroupSelectStrategy
            ),
            nested_slots: nested_slots_dto(
                <VerticalPassageGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidVerticalPassageGroupIssue,
                >>::expected_nested(&VerticalPassageGroupSelectStrategy),
            ),
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "add_elevator",
            handles: MISSING_ELEVATORS.as_str(),
            params: strategy_params_dto(
                <AddElevatorStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingElevatorsIssue,
                >>::params(&AddElevatorStrategy),
                &[],
            ),
            experimental: <AddElevatorStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingElevatorsIssue,
            >>::is_experimental(&AddElevatorStrategy),
            nested_suppressed_params: <AddElevatorStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingElevatorsIssue,
            >>::nested_suppressed_params(&AddElevatorStrategy),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "add_elevator_stop",
            handles: AREA_MISSING_ELEVATOR_STOPS.as_str(),
            params: strategy_params_dto(
                <AddElevatorStopStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::AreaMissingElevatorStopsIssue,
                >>::params(&AddElevatorStopStrategy),
                &[],
            ),
            experimental: <AddElevatorStopStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::AreaMissingElevatorStopsIssue,
            >>::is_experimental(&AddElevatorStopStrategy),
            nested_suppressed_params: <AddElevatorStopStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::AreaMissingElevatorStopsIssue,
            >>::nested_suppressed_params(
                &AddElevatorStopStrategy
            ),
            nested_slots: nested_slots_dto(<AddElevatorStopStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::AreaMissingElevatorStopsIssue,
            >>::expected_nested(
                &AddElevatorStopStrategy
            )),
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "add_elevator_stop_count",
            handles: MISSING_ELEVATOR_STOP_COUNT.as_str(),
            params: strategy_params_dto(
                <AddElevatorStopCountStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingElevatorStopCountIssue,
                >>::params(&AddElevatorStopCountStrategy),
                &[],
            ),
            experimental: <AddElevatorStopCountStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingElevatorStopCountIssue,
            >>::is_experimental(&AddElevatorStopCountStrategy),
            nested_suppressed_params: <AddElevatorStopCountStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingElevatorStopCountIssue,
            >>::nested_suppressed_params(
                &AddElevatorStopCountStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "add_elevator_height_stop",
            handles: MISSING_ELEVATOR_HEIGHT.as_str(),
            params: strategy_params_dto(
                <AddElevatorHeightStopStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::MissingElevatorHeightIssue,
                >>::params(&AddElevatorHeightStopStrategy),
                &[],
            ),
            experimental: <AddElevatorHeightStopStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingElevatorHeightIssue,
            >>::is_experimental(&AddElevatorHeightStopStrategy),
            nested_suppressed_params: <AddElevatorHeightStopStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::MissingElevatorHeightIssue,
            >>::nested_suppressed_params(
                &AddElevatorHeightStopStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "add_elevator_stop_for_gap",
            handles: EXCESSIVE_ELEVATOR_STOP_GAP.as_str(),
            params: strategy_params_dto(
                <AddElevatorStopForGapStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::ExcessiveElevatorStopGapIssue,
                >>::params(&AddElevatorStopForGapStrategy),
                &[],
            ),
            experimental: <AddElevatorStopForGapStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::ExcessiveElevatorStopGapIssue,
            >>::is_experimental(&AddElevatorStopForGapStrategy),
            nested_suppressed_params: <AddElevatorStopForGapStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::ExcessiveElevatorStopGapIssue,
            >>::nested_suppressed_params(
                &AddElevatorStopForGapStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "remove_elevator",
            handles: INVALID_ELEVATOR.as_str(),
            params: strategy_params_dto(
                <RemoveElevatorStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidElevatorIssue,
                >>::params(&RemoveElevatorStrategy),
                &[],
            ),
            experimental: <RemoveElevatorStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorIssue,
            >>::is_experimental(&RemoveElevatorStrategy),
            nested_suppressed_params: <RemoveElevatorStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorIssue,
            >>::nested_suppressed_params(
                &RemoveElevatorStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "replace_elevator_with_passages",
            handles: INVALID_ELEVATOR.as_str(),
            params: strategy_params_dto(
                <ReplaceElevatorWithPassagesStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidElevatorIssue,
                >>::params(&ReplaceElevatorWithPassagesStrategy),
                &[],
            ),
            experimental: <ReplaceElevatorWithPassagesStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorIssue,
            >>::is_experimental(&ReplaceElevatorWithPassagesStrategy),
            nested_suppressed_params: <ReplaceElevatorWithPassagesStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorIssue,
            >>::nested_suppressed_params(
                &ReplaceElevatorWithPassagesStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "elevator_group_select",
            handles: INVALID_ELEVATOR_GROUP.as_str(),
            params: strategy_params_dto(
                <ElevatorGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidElevatorGroupIssue,
                >>::params(&ElevatorGroupSelectStrategy),
                &[],
            ),
            experimental: <ElevatorGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorGroupIssue,
            >>::is_experimental(&ElevatorGroupSelectStrategy),
            nested_suppressed_params: <ElevatorGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorGroupIssue,
            >>::nested_suppressed_params(
                &ElevatorGroupSelectStrategy
            ),
            nested_slots: nested_slots_dto(<ElevatorGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorGroupIssue,
            >>::expected_nested(
                &ElevatorGroupSelectStrategy
            )),
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "remove_elevator_stop",
            handles: INVALID_ELEVATOR_STOP.as_str(),
            params: strategy_params_dto(
                <RemoveElevatorStopStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidElevatorStopIssue,
                >>::params(&RemoveElevatorStopStrategy),
                &[],
            ),
            experimental: <RemoveElevatorStopStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorStopIssue,
            >>::is_experimental(&RemoveElevatorStopStrategy),
            nested_suppressed_params: <RemoveElevatorStopStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorStopIssue,
            >>::nested_suppressed_params(
                &RemoveElevatorStopStrategy
            ),
            nested_slots: vec![],
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "elevator_stop_group_select",
            handles: INVALID_ELEVATOR_STOP_GROUP.as_str(),
            params: strategy_params_dto(
                <ElevatorStopGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidElevatorStopGroupIssue,
                >>::params(&ElevatorStopGroupSelectStrategy),
                &[],
            ),
            experimental: <ElevatorStopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorStopGroupIssue,
            >>::is_experimental(&ElevatorStopGroupSelectStrategy),
            nested_suppressed_params: <ElevatorStopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorStopGroupIssue,
            >>::nested_suppressed_params(
                &ElevatorStopGroupSelectStrategy
            ),
            nested_slots: nested_slots_dto(<ElevatorStopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidElevatorStopGroupIssue,
            >>::expected_nested(
                &ElevatorStopGroupSelectStrategy
            )),
            visibility: Some(EntityVisibility::MultiFloorOnly),
        },
        StrategyDescriptor {
            id: "cross_element_group_select",
            handles: INVALID_CROSS_ELEMENT_GROUP.as_str(),
            params: strategy_params_dto(
                <CrossElementGroupSelectStrategy as RepairStrategy<
                    SquareTessellation,
                    maze_core::quality_control::InvalidCrossElementGroupIssue,
                >>::params(&CrossElementGroupSelectStrategy {
                    protect_route: true,
                }),
                &[],
            ),
            experimental: <CrossElementGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidCrossElementGroupIssue,
            >>::is_experimental(&CrossElementGroupSelectStrategy {
                protect_route: true,
            }),
            nested_suppressed_params: <CrossElementGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidCrossElementGroupIssue,
            >>::nested_suppressed_params(
                &CrossElementGroupSelectStrategy {
                    protect_route: true,
                },
            ),
            nested_slots: nested_slots_dto(<CrossElementGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                maze_core::quality_control::InvalidCrossElementGroupIssue,
            >>::expected_nested(
                &CrossElementGroupSelectStrategy {
                    protect_route: true,
                },
            )),
            visibility: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // GitHub issue #349: `scored_endpoints`'s cross_floor_weight/elevator_stop_weight are
    // meaningless on a single-floor maze, so the web UI hides them via this tag — pins the wiring
    // between the strategy's own param ids and the visibility override list, since a typo in
    // either id would silently leave the param always-visible with no compiler signal.
    #[test]
    fn scored_endpoints_marks_floor_weights_multi_floor_only() {
        let strategies = available_strategies_list();
        let scored = strategies
            .iter()
            .find(|s| s.id == "scored_endpoints")
            .unwrap();
        for id in ["cross_floor_weight", "elevator_stop_weight"] {
            let param = scored.params.iter().find(|p| p.id == id).unwrap();
            assert_eq!(param.visibility, Some(EntityVisibility::MultiFloorOnly));
        }
    }

    // GitHub issue #381/#349 follow-up: `missing_teleports`'s cross-floor mode/balance only
    // matter when a teleport can actually land on a different floor.
    #[test]
    fn missing_teleports_marks_cross_floor_params_multi_floor_only() {
        let strategies = available_strategies_list();
        let strategy = strategies
            .iter()
            .find(|s| s.id == "missing_teleports")
            .unwrap();
        for id in ["cross_floor_mode", "cross_floor_balance"] {
            let param = strategy.params.iter().find(|p| p.id == id).unwrap();
            assert_eq!(param.visibility, Some(EntityVisibility::MultiFloorOnly));
        }
    }

    #[test]
    fn missing_loops_teleport_exposes_ordered_loop_params() {
        let strategy = available_strategies_list()
            .into_iter()
            .find(|s| s.id == "missing_loops_teleport")
            .expect("missing_loops_teleport must be registered");
        let ids: Vec<&str> = strategy.params.iter().map(|p| p.id).collect();
        assert_eq!(
            ids,
            vec![
                "entry_pick",
                "exit_pick",
                "desired_length",
                "allow_out_of_interval",
                "teleport_loop_one_way_chance",
                "reserve_percent",
                "attempts_limit",
            ]
        );

        let entry = strategy
            .params
            .iter()
            .find(|p| p.id == "entry_pick")
            .unwrap();
        assert!(matches!(
            entry.kind,
            ParamKindDto::Enum { ref default, .. } if *default == "dead_end_priority"
        ));
        let exit = strategy
            .params
            .iter()
            .find(|p| p.id == "exit_pick")
            .unwrap();
        assert!(matches!(
            exit.kind,
            ParamKindDto::Enum { ref default, .. } if *default == "dead_end_priority"
        ));
        let one_way = strategy
            .params
            .iter()
            .find(|p| p.id == "teleport_loop_one_way_chance")
            .unwrap();
        assert!(matches!(
            one_way.kind,
            ParamKindDto::Float { default, min, max }
                if default == 50.0 && min == 0.0 && max == 100.0
        ));
    }

    #[test]
    fn every_other_param_is_always_visible() {
        for strategy in available_strategies_list() {
            for param in strategy.params {
                if strategy.id == "scored_endpoints"
                    && (param.id == "cross_floor_weight" || param.id == "elevator_stop_weight")
                {
                    continue;
                }
                if strategy.id == "missing_teleports"
                    && (param.id == "cross_floor_mode" || param.id == "cross_floor_balance")
                {
                    continue;
                }
                if (strategy.id == "invalid_loop_random" || strategy.id == "invalid_loop_scored")
                    && param.id == "vertical_passage_priority"
                {
                    continue;
                }
                if strategy.id == "missing_loops_vertical"
                    && param.id == "vertical_loop_one_way_chance"
                {
                    continue;
                }
                assert_eq!(
                    param.visibility, None,
                    "strategy {} param {} should be always-visible",
                    strategy.id, param.id
                );
            }
        }
    }

    #[test]
    fn loop_strategies_mark_vertical_entities_multi_floor_only() {
        let strategies = available_strategies_list();

        for strategy_id in ["invalid_loop_random", "invalid_loop_scored"] {
            let strategy = strategies.iter().find(|s| s.id == strategy_id).unwrap();
            let param = strategy
                .params
                .iter()
                .find(|p| p.id == "vertical_passage_priority")
                .unwrap();
            assert_eq!(param.visibility, Some(EntityVisibility::MultiFloorOnly));
        }

        let vertical = strategies
            .iter()
            .find(|s| s.id == "missing_loops_vertical")
            .unwrap();
        let param = vertical
            .params
            .iter()
            .find(|p| p.id == "vertical_loop_one_way_chance")
            .unwrap();
        assert_eq!(param.visibility, Some(EntityVisibility::MultiFloorOnly));
    }

    // GitHub issue #349/#560 follow-up: every strategy that only makes sense with vertical passages/
    // elevators (which don't exist on a single-floor maze) is hidden from the selection dialogs
    // there — mirrors `only_vertical_passage_and_elevator_checks_are_multi_floor_only` in
    // `checks_catalog.rs`.
    #[test]
    fn only_vertical_passage_and_elevator_strategies_are_multi_floor_only() {
        let strategies = available_strategies_list();
        let hidden: Vec<&str> = strategies
            .iter()
            .filter(|s| s.visibility == Some(EntityVisibility::MultiFloorOnly))
            .map(|s| s.id)
            .collect();
        let mut hidden_sorted = hidden.clone();
        hidden_sorted.sort();
        assert_eq!(
            hidden_sorted,
            vec![
                "add_elevator",
                "add_elevator_height_stop",
                "add_elevator_stop",
                "add_elevator_stop_count",
                "add_elevator_stop_for_gap",
                "add_vertical_passage",
                "elevator_group_select",
                "elevator_region_merge",
                "elevator_stop_group_select",
                "missing_loops_vertical",
                "remove_elevator",
                "remove_elevator_stop",
                "remove_vertical_passage",
                "replace_elevator_with_passages",
                "vertical_passage_group_select",
                "vertical_passage_region_merge",
            ],
            "unexpected set of multi-floor-only strategies: {hidden:?}"
        );
    }

    // GitHub issue #486: element-adding strategies surface `reserve_percent`/`attempts_limit` as
    // dispatcher-owned when run nested. The web UI hides those rows on a nested node keyed on this
    // list; a suppressed id that isn't in the strategy's own `params` would be a dangling
    // reference the web can't act on, so pin the invariant.
    #[test]
    fn every_suppressed_param_id_is_one_of_the_strategys_own_params() {
        for strategy in available_strategies_list() {
            for id in strategy.nested_suppressed_params {
                assert!(
                    strategy.params.iter().any(|p| p.id == *id),
                    "strategy {} suppresses param {} it does not declare",
                    strategy.id,
                    id
                );
            }
        }
    }

    #[test]
    fn add_strategies_suppress_reserve_and_attempts_when_nested() {
        let strategies = available_strategies_list();
        for id in [
            "missing_one_ways_from_wall",
            "missing_one_ways_from_passage",
            "add_vertical_passage",
            "add_elevator_stop",
            "add_split",
        ] {
            let s = strategies.iter().find(|s| s.id == id).unwrap();
            assert_eq!(
                s.nested_suppressed_params,
                &["reserve_percent", "attempts_limit"],
                "strategy {id}"
            );
        }
    }
}
