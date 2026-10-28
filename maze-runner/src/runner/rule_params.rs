use crate::config::parse_split_patterns_param;
use maze_core::quality_control::{
    RULE_PARAM_DESCRIPTORS, RuleParamKind, RuleParams, VerticalPassageType,
};
use std::collections::HashMap;

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
        match descriptor.kind {
            RuleParamKind::Bool { default } => {
                let value = raw
                    .get(descriptor.id)
                    .map(|raw| match raw.as_str() {
                        "true" | "1" => true,
                        "false" | "0" => false,
                        _ => default,
                    })
                    .unwrap_or(default);
                match descriptor.id {
                    maze_core::quality_control::PARAM_PROTECT_ROUTE => params.protect_route = value,
                    maze_core::quality_control::PARAM_APPROXIMATE_TOPOLOGY => {
                        params.approximate_topology = value
                    }
                    _ => unreachable!(
                        "RuleParamDescriptor {} has no matching RuleParams field — add one",
                        descriptor.id
                    ),
                }
            }
            RuleParamKind::VerticalPassageTypeEnum { default } => {
                let value = raw
                    .get(descriptor.id)
                    .and_then(|raw| VerticalPassageType::from_str(raw))
                    .unwrap_or(default);
                match descriptor.id {
                    maze_core::quality_control::PARAM_VERTICAL_PASSAGE_TYPE => {
                        params.vertical_passage_type = value
                    }
                    _ => unreachable!(
                        "RuleParamDescriptor {} has no matching RuleParams field — add one",
                        descriptor.id
                    ),
                }
            }
            RuleParamKind::PatternList => {
                let value = parse_split_patterns_param(raw.get(descriptor.id));
                match descriptor.id {
                    maze_core::quality_control::PARAM_SPLIT_PATTERNS => {
                        params.split_patterns = value
                    }
                    _ => unreachable!(
                        "RuleParamDescriptor {} has no matching RuleParams field — add one",
                        descriptor.id
                    ),
                }
            }
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
    fn approximate_topology_defaults_to_false_and_parses_true() {
        assert!(
            !resolve_rule_params(&HashMap::new())
                .unwrap()
                .approximate_topology
        );
        let mut map = HashMap::new();
        map.insert("approximate_topology".to_string(), "true".to_string());
        assert!(resolve_rule_params(&map).unwrap().approximate_topology);
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

    #[test]
    fn defaults_split_patterns_to_empty_when_absent() {
        let params = resolve_rule_params(&HashMap::new()).unwrap();
        assert!(params.split_patterns.is_empty());
    }

    #[test]
    fn parses_split_patterns_from_json() {
        let mut map = HashMap::new();
        map.insert(
            "split_patterns".to_string(),
            r#"[{"shape":"regular:4","node_count":2,"faces":[[],[]],"weight":1.0}]"#.to_string(),
        );
        let params = resolve_rule_params(&map).unwrap();
        assert_eq!(params.split_patterns.len(), 1);
        assert_eq!(params.split_patterns[0].node_count, 2);
    }

    /// Catalog↔struct sync invariant — every descriptor in `RULE_PARAM_DESCRIPTORS` must be
    /// handled by `resolve_rule_params`'s own match; a descriptor added without a matching arm
    /// panics here via the `unreachable!` above, rather than staying silently unresolved.
    #[test]
    fn every_descriptor_resolves_without_panicking() {
        let raw: HashMap<String, String> = RULE_PARAM_DESCRIPTORS
            .iter()
            .map(|d| (d.id.to_string(), "true".to_string()))
            .collect();
        resolve_rule_params(&raw).unwrap();
    }
}
