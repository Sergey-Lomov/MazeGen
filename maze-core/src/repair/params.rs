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
}

/// Runtime value for a strategy parameter.
#[derive(Clone, Debug)]
pub enum StrategyParamValue {
    Float(f64),
    Bool(bool),
    Enum(String),
}

impl StrategyParamValue {
    pub fn as_float(&self) -> Option<f64> {
        if let Self::Float(v) = self { Some(*v) } else { None }
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
    }
}
