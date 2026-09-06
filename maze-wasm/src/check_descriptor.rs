use serde::Serialize;
use wasm_bindgen::prelude::*;
use maze_core::quality_control::{Comparison, CycleKind, GeometricFloorMode, FloorScope, VerticalPassageType, TeleportDirectionFilter, TeleportFloorKindFilter};
use maze_core::RegionClass;

/// Conditional-visibility tag (GitHub issue #349) — shared by `ParamDescriptor`, `CheckDescriptor`
/// and `StrategyDescriptor`. On a param, the web UI hides that param's whole row (label + control)
/// when the condition doesn't hold, leaving its stored value untouched (so re-adding a floor
/// doesn't force the user to reconfigure it). On a check/strategy, the web UI omits it from the
/// *selection* dialogs only (`IssueSelectDialog`/`CheckSelectDialog`/`StrategySelectDialog`/
/// `AddCheckToRuleDialog`/`NestedStrategySelectDialog`/`NewRuleStrategyDialog`) — a rule already built on a
/// now-hidden check/strategy stays exactly as configured, visible on its own card, and still
/// runs at generation time; only the ability to newly pick it is gated. Purely a UI hint in every
/// case: core/wasm never branch on this themselves, and a hidden entity still crosses the wasm
/// boundary and is still applied by generation — only rendering is affected.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EntityVisibility {
    /// Hidden whenever the maze has fewer than 2 floors. First consumers: `ScoredEndpointsStrategy`'s
    /// `vertical_passage_weight`/`elevator_weight` params (GitHub issue #390), and every check/
    /// strategy that only makes sense with vertical passages/elevators, which don't exist on a
    /// single-floor maze (GitHub issue #349 follow-up).
    MultiFloorOnly,
}

#[derive(Serialize)]
pub struct ParamDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: ParamKindDto,
    /// `None` means always visible — see `EntityVisibility`'s own doc comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<EntityVisibility>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ParamKindDto {
    Float { default: f64, min: f64, max: f64 },
    Integer { default: i64, min: i64, max: i64 },
    Bool { default: bool },
    Enum { options: Vec<&'static str>, default: &'static str },
    Interval { default_min: f64, default_max: f64, min: f64, max: f64 },
    /// A fixed 5-value priority enum between two candidate groups — see
    /// `maze_core::repair::PriorityLevel`'s own doc comment. Rendered by the web UI with one
    /// shared, hardcoded-once set of labels/explanations (`priority.*` i18n keys), not per-param
    /// entries the way a plain `Enum` needs (GitHub issue #381 follow-up).
    Priority { default: &'static str },
    /// A split-pattern list (GitHub issue #247) — signals the web UI to render the dedicated
    /// pattern-list dialog instead of a generic input. Value is carried as a JSON-serialized
    /// `Vec<SplitPatternDto>` string in the check/strategy's own `params` map (the same wire shape
    /// `SplitGenerationConfigDto.patterns` uses; see `maze-runner`'s `parse_split_patterns_param`).
    /// `with_weights` distinguishes a plain "all vs this list" filter (a check's own pattern-list
    /// param, no weights) from a full weighted pattern pool with an unconstrained-mode switch (a
    /// strategy's own pattern-selection config).
    PatternList { with_weights: bool },
    /// A full split-generation config — pattern mode toggle, `max_split_nodes` (unconstrained
    /// mode), and a weighted pattern list (pattern mode) — bundled behind one settings button that
    /// opens the same dialog generation's own split settings use (`AddSplitStrategy`'s `patterns`
    /// param, GitHub issue #247). Value round-trips as a JSON-serialized
    /// `SplitGenerationConfigDto` string (the same wire shape `GenerateConfig.split_generation`
    /// uses; see `maze-runner`'s `parse_split_config_param`), not the flat `PatternList` shape
    /// above — a `PatternList` param has no mode switch or node-count field of its own.
    SplitGenerationConfig,
    /// `AddSplitStrategy`'s own construction-time param (GitHub issue #389) — pattern topology no
    /// longer lives here (moved to the rule-level `split_patterns` param, see
    /// `RuleParamDescriptorDto`), so this only carries `max_split_nodes`'s default. The web UI
    /// decides at render time which control to show: a plain integer input for `max_split_nodes`
    /// when the owning rule's own `split_patterns` is empty, or a locked pattern-list editor (topology
    /// from `split_patterns`, weights from this param's own value) when it's non-empty — see
    /// `maze-runner`'s `build_add_split_strategy`. Value round-trips as a JSON-serialized
    /// `Vec<f64>` (the `pattern_weights` wire shape) when in pattern mode, or a plain integer
    /// string when in non-pattern mode — same "which shape depends on sibling rule state" contract
    /// `add_vertical_passage`'s slider overrides already follow, just for a param whose control
    /// type itself switches, not just its value.
    AddSplitConfig { max_split_nodes_default: u32 },
}

#[derive(Serialize)]
pub struct CheckDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub issue_kinds: Vec<&'static str>,
    pub params: Vec<ParamDescriptor>,
    /// Whether more than one independent instance of this check type may be active at once
    /// (across rules, or within the same rule) — see GitHub issue #60. `false` for every check
    /// except `min_region_count`: a second `min_region_count` instance with a different
    /// `region_class` is a legitimate, common configuration ("at least 2 trap regions" AND
    /// separately "at least 2 alternative regions"); no other check has an analogous use case
    /// for running twice with different params, so this stays opt-in per check rather than a
    /// blanket allowance. The web store/UI enforce this (see `addCheck`/`createRule` in
    /// `generationSlice.ts`) — wasm/core themselves don't reject a duplicate, since nothing
    /// downstream of this flag depends on it being correct for repair/QC to function.
    pub allow_multiple_instances: bool,
    /// `None` means always offered — see `EntityVisibility`'s own doc comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<EntityVisibility>,
}

/// Rule-level parameter descriptor (GitHub issue #253) — same shape as `ParamDescriptor` plus
/// `applies_to`, the list of check `type_id`s / strategy `id`s that actually consume this
/// parameter. A rule only shows this parameter when at least one of its own checks or its
/// strategy appears in `applies_to` — not every rule shares the same rule-level parameter set
/// (e.g. `protect_route` is meaningless for a `min_region_count` rule). The web UI filters
/// `available_rule_params()`'s list against a rule's own composition using this field before
/// rendering, reusing the existing `ParamFields` component for the values themselves.
#[derive(Serialize)]
pub struct RuleParamDescriptorDto {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: ParamKindDto,
    pub applies_to: &'static [&'static str],
}

/// Rule-level parameter descriptors (GitHub issue #253) — one entry per
/// `maze_core::quality_control::RULE_PARAM_DESCRIPTORS` item. `id`/type/default/`applies_to` come
/// straight from `RULE_PARAM_DESCRIPTORS` — the single source of truth `maze-runner`'s
/// `resolve_rule_params` also reads — only `label` is decided here (the web side ignores it
/// anyway, resolving display text from its own i18n keyed by `id`, same as every other
/// `ParamDescriptor.label` in this module).
pub fn rule_params_list() -> Vec<RuleParamDescriptorDto> {
    use maze_core::quality_control::{RULE_PARAM_DESCRIPTORS, RuleParamKind, PARAM_PROTECT_ROUTE, PARAM_VERTICAL_PASSAGE_TYPE, PARAM_SPLIT_PATTERNS, VerticalPassageType};
    RULE_PARAM_DESCRIPTORS.iter().map(|d| {
        let kind = match d.kind {
            RuleParamKind::Bool { default } => ParamKindDto::Bool { default },
            RuleParamKind::VerticalPassageTypeEnum { default } => ParamKindDto::Enum {
                options: VerticalPassageType::ALL_VALUES.iter().map(|t| t.as_str()).collect(),
                default: default.as_str(),
            },
            // No weight input at rule-level (GitHub issue #389) — `SplitPattern::weight` here is
            // only a fallback default for `AddSplitStrategy`'s own `pattern_weights` override.
            RuleParamKind::PatternList => ParamKindDto::PatternList { with_weights: false },
        };
        let label = match d.id {
            id if id == PARAM_PROTECT_ROUTE => "Protect start-finish route",
            id if id == PARAM_VERTICAL_PASSAGE_TYPE => "Type",
            id if id == PARAM_SPLIT_PATTERNS => "Split patterns",
            other => other,
        };
        RuleParamDescriptorDto { id: d.id, label, kind, applies_to: d.applies_to }
    }).collect()
}

#[wasm_bindgen]
pub fn available_rule_params() -> JsValue {
    serde_wasm_bindgen::to_value(&rule_params_list()).unwrap()
}

/// Dropdown restricting `min_region_size`/`min_region_ratio` to one `RegionClass`, defaulting to
/// `"all"` (every class, the checks' pre-#54 behavior) — see GitHub issue #54.
pub fn region_class_filter_param() -> ParamDescriptor {
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
        visibility: None,
    }
}


/// Shared `comparison` param descriptor — GitHub issue #177: checks merged around `Comparison`
/// (min/max validating a single entity, both flagging the same issue kind) expose one `comparison`
/// enum param instead of being two near-duplicate check types. `default` is the merged check's
/// pre-#177 fixed operator, so an unset param reproduces the old check's exact behavior.
pub fn comparison_param(default: Comparison) -> ParamDescriptor {
    ParamDescriptor {
        id: "comparison",
        label: "Comparison",
        kind: ParamKindDto::Enum {
            options: Comparison::ALL.iter().map(|c| c.as_str()).collect(),
            default: default.as_str(),
        },
        visibility: None,
    }
}

/// Shared `floor_mode` param descriptor — GitHub issue #342: geometric (coordinate-based) distance
/// checks (`teleport_geometric_length`, `one_way_group_geometric_proximity`,
/// `split_group_geometric_proximity`) expose how a cross-floor pair is treated, since raw x-y
/// distance is meaningless across floors (each floor has its own independent coordinate system).
/// `default` is `SameFloorOnly` for all three (pre-#342 behavior for the checks that already
/// effectively ignored cross-floor pairs, and the safest choice for the two that didn't).
pub fn geometric_floor_mode_param(default: GeometricFloorMode) -> ParamDescriptor {
    ParamDescriptor {
        id: "floor_mode",
        label: "Floor mode",
        kind: ParamKindDto::Enum {
            options: GeometricFloorMode::ALL.iter().map(|m| m.as_str()).collect(),
            default: default.as_str(),
        },
        // Meaningless with 1 floor -- every pair is trivially same-floor, so the mode has nothing
        // to distinguish (GitHub issue #349 follow-up).
        visibility: Some(EntityVisibility::MultiFloorOnly),
    }
}

/// Shared `cycle_kind` param descriptor — GitHub issue #217: every loop-based check built on
/// `cycle_check_core::find_invalid_cycles` (`loop_length`, `external_escape_diversity`,
/// `loop_distance_from_start`, `loop_distance_from_finish`) exposes this same enum so a user can
/// restrict evaluation to bidirectional loops, one-way shortcuts, or every cycle regardless of
/// directionality. Default `"any"` reproduces the pre-#217 behavior.
pub fn cycle_kind_param() -> ParamDescriptor {
    ParamDescriptor {
        id: "cycle_kind",
        label: "Cycle kind",
        kind: ParamKindDto::Enum {
            options: CycleKind::ALL.iter().map(|k| k.as_str()).collect(),
            default: CycleKind::Any.as_str(),
        },
        visibility: None,
    }
}

/// Shared `floor_scope` param descriptor — GitHub issue #369: every count/density-style QC check
/// (except region-based checks and `scc_count`) exposes whether its threshold is evaluated over
/// the whole maze or independently per floor (an entity spanning floors counts toward every floor
/// it touches under `PerFloor`). `default` is `WholeMaze` for count-style checks (the pre-#369
/// behavior) and `PerFloor` for density-style checks (per-floor coverage is the more meaningful
/// default for a per-100-cells share).
pub fn floor_scope_param(default: FloorScope) -> ParamDescriptor {
    ParamDescriptor {
        id: "floor_scope",
        label: "Floor scope",
        kind: ParamKindDto::Enum {
            options: FloorScope::ALL.iter().map(|s| s.as_str()).collect(),
            default: default.as_str(),
        },
        // WholeMaze and PerFloor collapse to the same behavior with 1 floor (GitHub issue #349
        // follow-up).
        visibility: Some(EntityVisibility::MultiFloorOnly),
    }
}

/// Shared `passage_type` param descriptor for the 4 min/max vertical-passage count/ratio checks
/// and the 2 group-proximity checks (GitHub issue #343 follow-up) — which logical `VerticalPassage`
/// passages participate (any, two-way only, one-way in either/a specific direction).
pub fn vertical_passage_type_param(default: VerticalPassageType) -> ParamDescriptor {
    ParamDescriptor {
        id: "passage_type",
        label: "Type",
        kind: ParamKindDto::Enum {
            options: VerticalPassageType::ALL_VALUES.iter().map(|t| t.as_str()).collect(),
            default: default.as_str(),
        },
        visibility: None,
    }
}

pub fn teleport_direction_param(default: TeleportDirectionFilter) -> ParamDescriptor {
    ParamDescriptor {
        id: "teleport_direction",
        label: "Direction",
        kind: ParamKindDto::Enum {
            options: TeleportDirectionFilter::ALL_VALUES.iter().map(|t| t.as_str()).collect(),
            default: default.as_str(),
        },
        visibility: None,
    }
}

pub fn teleport_floor_kind_param(default: TeleportFloorKindFilter) -> ParamDescriptor {
    ParamDescriptor {
        id: "teleport_floor_kind",
        label: "Floor kind",
        kind: ParamKindDto::Enum {
            options: TeleportFloorKindFilter::ALL_VALUES.iter().map(|t| t.as_str()).collect(),
            default: default.as_str(),
        },
        // Every teleport collapses to SameFloor with 1 floor -- the filter has nothing to
        // distinguish (GitHub issue #349 follow-up).
        visibility: Some(EntityVisibility::MultiFloorOnly),
    }
}

/// Shared `same_type_only` param descriptor for the 2 `VerticalPassage` proximity checks (GitHub
/// issue #343 follow-up) — when enabled, a pair is only compared/flagged if both candidates' own
/// passages share the same concrete type (`TwoWay`/`OneWayDown`/`OneWayUp`).
pub fn vertical_passage_same_type_only_param() -> ParamDescriptor {
    ParamDescriptor {
        id: "same_type_only",
        label: "Same type only",
        kind: ParamKindDto::Bool { default: false },
        visibility: None,
    }
}

/// Shared `count_incoming` param descriptor — only matters for one-way passages. For the 4 min/max
/// vertical-passage count/ratio checks under `FloorScope::PerFloor` (GitHub issue #343 follow-up):
/// when off, a one-way passage counts only toward its `from` floor; when on, it also counts toward
/// its `to` floor. Ignored entirely under `FloorScope::WholeMaze`. For the 2 proximity checks:
/// when off, a one-way passage's `to` end is excluded from the proximity scan entirely (only its
/// `from` end participates); when on, both ends participate, same as a two-way passage's two ends.
/// Each caller passes its own `default` since the two families disagree on it (count/ratio checks
/// default to off, proximity checks default to on).
pub fn vertical_passage_count_incoming_param(default: bool) -> ParamDescriptor {
    ParamDescriptor {
        id: "count_incoming",
        label: "Count incoming",
        kind: ParamKindDto::Bool { default },
        visibility: None,
    }
}

/// One "include this element type" bool param for the 2 cross-element proximity checks (GitHub
/// issue #376) — there is no multi-select param kind, so the type set is 7 independent bools. A
/// set with zero enabled types makes the check a silent no-op; one enabled type is a valid
/// same-type scan.
pub fn cross_element_include_param(id: &'static str, label: &'static str, default: bool, visibility: Option<EntityVisibility>) -> ParamDescriptor {
    ParamDescriptor {
        id,
        label,
        kind: ParamKindDto::Bool { default },
        // `include_vertical_passage` / `include_elevator_stop` pass `MultiFloorOnly` — both element
        // types only exist on a multi-floor maze, so the toggle is meaningless with 1 floor (same
        // rationale as `geometric_floor_mode_param`). Every other `include_*` toggle passes `None`.
        visibility,
    }
}

