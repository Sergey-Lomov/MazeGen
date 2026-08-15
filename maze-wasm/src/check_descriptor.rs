use serde::Serialize;
use wasm_bindgen::prelude::*;
use maze_core::quality_control::{Comparison, CycleKind, GeometricFloorMode};
use maze_core::RegionClass;

#[derive(Serialize)]
pub struct ParamDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: ParamKindDto,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ParamKindDto {
    Float { default: f64, min: f64, max: f64 },
    Integer { default: i64, min: i64, max: i64 },
    Bool { default: bool },
    Enum { options: Vec<&'static str>, default: &'static str },
    Interval { default_min: f64, default_max: f64, min: f64, max: f64 },
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
    use maze_core::quality_control::{RULE_PARAM_DESCRIPTORS, RuleParamKind, PARAM_PROTECT_ROUTE};
    RULE_PARAM_DESCRIPTORS.iter().map(|d| {
        let kind = match d.kind {
            RuleParamKind::Bool { default } => ParamKindDto::Bool { default },
        };
        let label = match d.id {
            id if id == PARAM_PROTECT_ROUTE => "Protect start-finish route",
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
    }
}

/// Shared `patterns` param descriptor for `SplitCountCheck`/`SplitDensityCheck` (GitHub issue
/// #247) — "all splits count" (empty list, the default) vs. "only splits matching one of these
/// patterns". No weights: a check's pattern list is a pure membership filter, unlike
/// `AddSplitStrategy`'s own weighted selection pool.
pub fn split_patterns_filter_param() -> ParamDescriptor {
    ParamDescriptor {
        id: "patterns",
        label: "Split patterns",
        kind: ParamKindDto::PatternList { with_weights: false },
    }
}
