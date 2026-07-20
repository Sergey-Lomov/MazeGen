use std::collections::HashMap;

/// Descriptor for a single configurable parameter of a repair strategy.
pub struct StrategyParam {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: StrategyParamKind,
}

pub enum StrategyParamKind {
    Float { default: f64, min: f64, max: f64 },
    Bool { default: bool },
    Enum { options: &'static [&'static str], default: &'static str },
    /// A `[min, max]` range, e.g. a desired distance band — see `MissingTeleportsStrategy`'s
    /// `PARAM_DESIRED_LENGTH` (GitHub issue #212). `default_min`/`default_max` bound the same
    /// range the UI slider starts at; `min`/`max` bound what a config override may set either
    /// endpoint to.
    Interval { default_min: f64, default_max: f64, min: f64, max: f64 },
}

/// Runtime value for a strategy parameter.
#[derive(Clone, Debug)]
pub enum StrategyParamValue {
    Float(f64),
    Bool(bool),
    Enum(String),
    Interval(f64, f64),
}

impl StrategyParamValue {
    pub fn as_float(&self) -> Option<f64> {
        if let Self::Float(v) = self { Some(*v) } else { None }
    }

    pub fn as_interval(&self) -> Option<(f64, f64)> {
        if let Self::Interval(lo, hi) = self { Some((*lo, *hi)) } else { None }
    }
}

pub type StrategyParams = HashMap<&'static str, StrategyParamValue>;

/// Build a params map from strategy descriptors, applying overrides from config.
/// Config values are raw strings; conversion follows the param kind.
/// Invalid or out-of-range override values fall back to the param default.
pub fn build_params(
    descriptors: &'static [StrategyParam],
    overrides: Option<&HashMap<String, String>>,
) -> StrategyParams {
    let mut map = StrategyParams::new();
    for param in descriptors {
        let value = overrides
            .and_then(|o| o.get(param.id))
            .and_then(|raw| parse_param(raw, &param.kind));
        let value = value.unwrap_or_else(|| default_value(&param.kind));
        map.insert(param.id, value);
    }
    map
}

fn default_value(kind: &StrategyParamKind) -> StrategyParamValue {
    match kind {
        StrategyParamKind::Float { default, .. } => StrategyParamValue::Float(*default),
        StrategyParamKind::Bool { default } => StrategyParamValue::Bool(*default),
        StrategyParamKind::Enum { default, .. } => StrategyParamValue::Enum(default.to_string()),
        StrategyParamKind::Interval { default_min, default_max, .. } => StrategyParamValue::Interval(*default_min, *default_max),
    }
}

fn parse_param(raw: &str, kind: &StrategyParamKind) -> Option<StrategyParamValue> {
    match kind {
        StrategyParamKind::Float { min, max, .. } => raw.parse::<f64>().ok()
            .filter(|v| v.is_finite())
            .map(|v| StrategyParamValue::Float(v.clamp(*min, *max))),
        StrategyParamKind::Bool { .. } => match raw {
            "true" | "1" => Some(StrategyParamValue::Bool(true)),
            "false" | "0" => Some(StrategyParamValue::Bool(false)),
            _ => None,
        },
        StrategyParamKind::Enum { options, .. } => {
            if options.contains(&raw) {
                Some(StrategyParamValue::Enum(raw.to_string()))
            } else {
                None
            }
        }
        // "min,max" — same two-number encoding a config override would round-trip from the UI's
        // own interval slider serialization.
        StrategyParamKind::Interval { min, max, .. } => {
            let (lo_raw, hi_raw) = raw.split_once(',')?;
            let lo = lo_raw.trim().parse::<f64>().ok().filter(|v| v.is_finite())?;
            let hi = hi_raw.trim().parse::<f64>().ok().filter(|v| v.is_finite())?;
            if lo > hi {
                return None;
            }
            Some(StrategyParamValue::Interval(lo.clamp(*min, *max), hi.clamp(*min, *max)))
        }
    }
}
