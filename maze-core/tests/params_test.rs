use maze_core::repair::params::build_params;
use maze_core::repair::{StrategyParam, StrategyParamKind, StrategyParamValue};
use std::collections::HashMap;

// --- build_params: no overrides ---

#[test]
fn build_params_defaults_when_no_overrides() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "w",
        label: "w",
        kind: StrategyParamKind::Float {
            default: 3.0,
            min: 0.0,
            max: 10.0,
        },
    }];
    let result = build_params(PARAMS, None);
    assert_eq!(result["w"].as_float(), Some(3.0));
}

#[test]
fn build_params_applies_valid_float_override() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "w",
        label: "w",
        kind: StrategyParamKind::Float {
            default: 3.0,
            min: 0.0,
            max: 10.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("w".to_string(), "7.5".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["w"].as_float(), Some(7.5));
}

#[test]
fn build_params_clamps_float_above_max() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "w",
        label: "w",
        kind: StrategyParamKind::Float {
            default: 3.0,
            min: 0.0,
            max: 10.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("w".to_string(), "999.0".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["w"].as_float(), Some(10.0));
}

#[test]
fn build_params_clamps_float_below_min() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "w",
        label: "w",
        kind: StrategyParamKind::Float {
            default: 3.0,
            min: 0.0,
            max: 10.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("w".to_string(), "-5.0".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["w"].as_float(), Some(0.0));
}

#[test]
fn build_params_falls_back_to_default_on_invalid_float() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "w",
        label: "w",
        kind: StrategyParamKind::Float {
            default: 3.0,
            min: 0.0,
            max: 10.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("w".to_string(), "not_a_number".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["w"].as_float(), Some(3.0));
}

#[test]
fn build_params_rejects_nan_float() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "w",
        label: "w",
        kind: StrategyParamKind::Float {
            default: 3.0,
            min: 0.0,
            max: 10.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("w".to_string(), "NaN".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["w"].as_float(), Some(3.0));
}

// --- Bool ---

#[test]
fn build_params_bool_true() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "flag",
        label: "flag",
        kind: StrategyParamKind::Bool { default: false },
    }];
    for raw in &["true", "1"] {
        let mut overrides = HashMap::new();
        overrides.insert("flag".to_string(), raw.to_string());
        let result = build_params(PARAMS, Some(&overrides));
        assert!(
            matches!(result["flag"], StrategyParamValue::Bool(true)),
            "raw={raw}"
        );
    }
}

#[test]
fn build_params_bool_false() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "flag",
        label: "flag",
        kind: StrategyParamKind::Bool { default: true },
    }];
    for raw in &["false", "0"] {
        let mut overrides = HashMap::new();
        overrides.insert("flag".to_string(), raw.to_string());
        let result = build_params(PARAMS, Some(&overrides));
        assert!(
            matches!(result["flag"], StrategyParamValue::Bool(false)),
            "raw={raw}"
        );
    }
}

#[test]
fn build_params_bool_invalid_falls_back_to_default() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "flag",
        label: "flag",
        kind: StrategyParamKind::Bool { default: true },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("flag".to_string(), "yes".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert!(matches!(result["flag"], StrategyParamValue::Bool(true)));
}

// --- Enum ---

#[test]
fn build_params_enum_valid_override() {
    static OPTIONS: &[&str] = &["a", "b", "c"];
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "mode",
        label: "mode",
        kind: StrategyParamKind::Enum {
            options: OPTIONS,
            default: "a",
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("mode".to_string(), "b".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert!(matches!(&result["mode"], StrategyParamValue::Enum(v) if v == "b"));
}

#[test]
fn build_params_enum_invalid_falls_back_to_default() {
    static OPTIONS: &[&str] = &["a", "b", "c"];
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "mode",
        label: "mode",
        kind: StrategyParamKind::Enum {
            options: OPTIONS,
            default: "a",
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("mode".to_string(), "z".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert!(matches!(&result["mode"], StrategyParamValue::Enum(v) if v == "a"));
}

// --- Interval ---

#[test]
fn build_params_defaults_interval_when_no_overrides() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "range",
        label: "range",
        kind: StrategyParamKind::Interval {
            default_min: 2.0,
            default_max: 8.0,
            min: 0.0,
            max: 100.0,
        },
    }];
    let result = build_params(PARAMS, None);
    assert_eq!(result["range"].as_interval(), Some((2.0, 8.0)));
}

#[test]
fn build_params_applies_valid_interval_override() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "range",
        label: "range",
        kind: StrategyParamKind::Interval {
            default_min: 2.0,
            default_max: 8.0,
            min: 0.0,
            max: 100.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("range".to_string(), "10,20".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["range"].as_interval(), Some((10.0, 20.0)));
}

#[test]
fn build_params_interval_override_tolerates_surrounding_whitespace() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "range",
        label: "range",
        kind: StrategyParamKind::Interval {
            default_min: 2.0,
            default_max: 8.0,
            min: 0.0,
            max: 100.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("range".to_string(), " 10 , 20 ".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["range"].as_interval(), Some((10.0, 20.0)));
}

#[test]
fn build_params_clamps_interval_endpoints_to_bounds() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "range",
        label: "range",
        kind: StrategyParamKind::Interval {
            default_min: 2.0,
            default_max: 8.0,
            min: 0.0,
            max: 100.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("range".to_string(), "-50,999".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["range"].as_interval(), Some((0.0, 100.0)));
}

#[test]
fn build_params_rejects_interval_with_min_above_max() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "range",
        label: "range",
        kind: StrategyParamKind::Interval {
            default_min: 2.0,
            default_max: 8.0,
            min: 0.0,
            max: 100.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("range".to_string(), "20,10".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(
        result["range"].as_interval(),
        Some((2.0, 8.0)),
        "lo > hi must fall back to the default, not swap or clamp into a degenerate range"
    );
}

#[test]
fn build_params_rejects_interval_missing_comma() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "range",
        label: "range",
        kind: StrategyParamKind::Interval {
            default_min: 2.0,
            default_max: 8.0,
            min: 0.0,
            max: 100.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("range".to_string(), "10".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["range"].as_interval(), Some((2.0, 8.0)));
}

#[test]
fn build_params_rejects_interval_with_non_numeric_endpoint() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "range",
        label: "range",
        kind: StrategyParamKind::Interval {
            default_min: 2.0,
            default_max: 8.0,
            min: 0.0,
            max: 100.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("range".to_string(), "abc,20".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["range"].as_interval(), Some((2.0, 8.0)));
}

#[test]
fn build_params_rejects_interval_with_nan_endpoint() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "range",
        label: "range",
        kind: StrategyParamKind::Interval {
            default_min: 2.0,
            default_max: 8.0,
            min: 0.0,
            max: 100.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("range".to_string(), "NaN,20".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["range"].as_interval(), Some((2.0, 8.0)));
}

// --- unknown override key is ignored ---

#[test]
fn build_params_unknown_override_key_ignored() {
    static PARAMS: &[StrategyParam] = &[StrategyParam {
        id: "w",
        label: "w",
        kind: StrategyParamKind::Float {
            default: 1.0,
            min: 0.0,
            max: 10.0,
        },
    }];
    let mut overrides = HashMap::new();
    overrides.insert("unknown".to_string(), "99".to_string());
    let result = build_params(PARAMS, Some(&overrides));
    assert_eq!(result["w"].as_float(), Some(1.0));
    assert!(!result.contains_key("unknown"));
}
