use serde::Serialize;
use maze_core::quality_control::{Comparison, CycleKind};
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

/// Shared `protect_route` param descriptor (GitHub issue #78) — every per-teleport check gets
/// this exact id/label/default, so it's declared once instead of repeated per `CheckDescriptor`.
pub fn protect_route_param() -> ParamDescriptor {
    ParamDescriptor {
        id: "protect_route",
        label: "Protect route teleports",
        kind: ParamKindDto::Bool { default: true },
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
