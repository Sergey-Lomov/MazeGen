use std::collections::HashMap;
use maze_core::quality_control::{RuleParams, RuleParamKind, RULE_PARAM_DESCRIPTORS};

/// Resolves a `QcRuleConfig.params` raw string map into a typed `RuleParams` — see GitHub issue
/// #253. Every key must match a descriptor in `RULE_PARAM_DESCRIPTORS`; an unrecognized key
/// (typo, or a parameter from a config newer than this build) is an error, not a silent ignore —
/// this project has no external config consumers, so there is no forward-compatibility need to
/// weigh against catching a mistyped/stale key immediately.
pub(crate) fn resolve_rule_params(raw: &HashMap<String, String>) -> Result<RuleParams, String> {
    for key in raw.keys() {
        if !RULE_PARAM_DESCRIPTORS.iter().any(|d| d.id == key.as_str()) {
            return Err(format!("unknown rule param: {key}"));
        }
    }

    let mut params = RuleParams::default();
    for descriptor in RULE_PARAM_DESCRIPTORS {
        let RuleParamKind::Bool { default } = descriptor.kind;
        let value = raw.get(descriptor.id)
            .map(|raw| match raw.as_str() {
                "true" | "1" => true,
                "false" | "0" => false,
                _ => default,
            })
            .unwrap_or(default);
        match descriptor.id {
            maze_core::quality_control::PARAM_PROTECT_ROUTE => params.protect_route = value,
            _ => unreachable!("RuleParamDescriptor {} has no matching RuleParams field — add one", descriptor.id),
        }
    }
    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_protect_route_to_true_when_absent() {
        let params = resolve_rule_params(&HashMap::new()).unwrap();
        assert!(params.protect_route);
    }

    #[test]
    fn parses_false_and_zero_as_false() {
        for raw in ["false", "0"] {
            let mut map = HashMap::new();
            map.insert("protect_route".to_string(), raw.to_string());
            let params = resolve_rule_params(&map).unwrap();
            assert!(!params.protect_route, "{raw} must resolve to false");
        }
    }

    #[test]
    fn unparseable_value_falls_back_to_default() {
        let mut map = HashMap::new();
        map.insert("protect_route".to_string(), "garbage".to_string());
        let params = resolve_rule_params(&map).unwrap();
        assert!(params.protect_route);
    }

    #[test]
    fn unknown_key_is_an_error() {
        let mut map = HashMap::new();
        map.insert("protect_rooute".to_string(), "false".to_string());
        let err = resolve_rule_params(&map).unwrap_err();
        assert!(err.contains("protect_rooute"));
    }

    /// Catalog↔struct sync invariant — every descriptor in `RULE_PARAM_DESCRIPTORS` must be
    /// handled by `resolve_rule_params`'s own match; a descriptor added without a matching arm
    /// panics here via the `unreachable!` above, rather than staying silently unresolved.
    #[test]
    fn every_descriptor_resolves_without_panicking() {
        let raw: HashMap<String, String> = RULE_PARAM_DESCRIPTORS.iter()
            .map(|d| (d.id.to_string(), "true".to_string()))
            .collect();
        resolve_rule_params(&raw).unwrap();
    }
}
