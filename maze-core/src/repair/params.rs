use rand::RngCore;
use rand::seq::SliceRandom;
use std::collections::HashMap;

/// Descriptor for a single configurable parameter of a repair strategy.
pub struct StrategyParam {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: StrategyParamKind,
}

pub enum StrategyParamKind {
    Float {
        default: f64,
        min: f64,
        max: f64,
    },
    Bool {
        default: bool,
    },
    Enum {
        options: &'static [&'static str],
        default: &'static str,
    },
    /// A `[min, max]` range, e.g. a desired distance band — see `MissingTeleportsStrategy`'s
    /// `PARAM_DESIRED_LENGTH` (GitHub issue #212). `default_min`/`default_max` bound the same
    /// range the UI slider starts at; `min`/`max` bound what a config override may set either
    /// endpoint to.
    Interval {
        default_min: f64,
        default_max: f64,
        min: f64,
        max: f64,
    },
    /// A fixed 5-value priority enum (`PriorityLevel`) between two candidate groups — see
    /// `PriorityLevel`'s own doc comment. Distinct from a plain `Enum` so the web UI can render
    /// every occurrence with one shared, hardcoded-once set of 5 labels/explanations instead of
    /// each param needing its own i18n entries (GitHub issue #381 follow-up).
    Priority {
        default: PriorityLevel,
    },
}

/// Runtime value for a strategy parameter.
#[derive(Clone, Debug)]
pub enum StrategyParamValue {
    Float(f64),
    Bool(bool),
    Enum(String),
    Interval(f64, f64),
    Priority(PriorityLevel),
}

impl StrategyParamValue {
    pub fn as_float(&self) -> Option<f64> {
        if let Self::Float(v) = self {
            Some(*v)
        } else {
            None
        }
    }

    pub fn as_interval(&self) -> Option<(f64, f64)> {
        if let Self::Interval(lo, hi) = self {
            Some((*lo, *hi))
        } else {
            None
        }
    }

    pub fn as_priority(&self) -> Option<PriorityLevel> {
        if let Self::Priority(p) = self {
            Some(*p)
        } else {
            None
        }
    }
}

/// How strongly a repair strategy should prefer one of two candidate groups ("preferred" vs.
/// "other") over the other when picking among feasible candidates — e.g.
/// `MissingTeleportsStrategy`'s choice between an exit unreachable from entry vs. one at the
/// desired distance (GitHub issue #381), or `AddElevatorStopCountStrategy`'s choice between a
/// floor outside vs. inside an elevator's current range. `order_zones` turns a level plus the two
/// groups into the ordered list of zones a strategy should try in turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriorityLevel {
    /// Only the "preferred" group is tried; the whole entry attempt fails if it's empty.
    Required,
    /// The "preferred" group is tried first, falling back to "other" only if it's empty.
    Preferred,
    /// Both groups are merged into one and picked from without any preference.
    Indifferent,
    /// The "other" group is tried first, falling back to "preferred" only if it's empty.
    Discouraged,
    /// Only the "other" group is tried; the whole entry attempt fails if it's empty.
    Forbidden,
}

impl PriorityLevel {
    pub const ALL: [PriorityLevel; 5] = [
        PriorityLevel::Required,
        PriorityLevel::Preferred,
        PriorityLevel::Indifferent,
        PriorityLevel::Discouraged,
        PriorityLevel::Forbidden,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PriorityLevel::Required => "required",
            PriorityLevel::Preferred => "preferred",
            PriorityLevel::Indifferent => "indifferent",
            PriorityLevel::Discouraged => "discouraged",
            PriorityLevel::Forbidden => "forbidden",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "required" => Some(PriorityLevel::Required),
            "preferred" => Some(PriorityLevel::Preferred),
            "indifferent" => Some(PriorityLevel::Indifferent),
            "discouraged" => Some(PriorityLevel::Discouraged),
            "forbidden" => Some(PriorityLevel::Forbidden),
            _ => None,
        }
    }

    /// Orders `preferred`/`other` into the zone list a caller should try in turn (first zone that
    /// yields a usable candidate wins) — mirrors `AddElevatorStopCountStrategy`'s own
    /// `ordered_zones` match, generalized. `Required`/`Forbidden` restrict to a single group with
    /// no fallback zone at all (an empty result means the whole attempt fails, not that the other
    /// group gets tried); `Indifferent` merges both into one zone and shuffles it, so a caller that
    /// consumes it in order (not just picking one random element) doesn't get a hidden
    /// preferred-then-other bias.
    pub fn order_zones<T>(
        self,
        preferred: Vec<T>,
        other: Vec<T>,
        rng: &mut dyn RngCore,
    ) -> Vec<Vec<T>> {
        match self {
            PriorityLevel::Required => vec![preferred],
            PriorityLevel::Forbidden => vec![other],
            PriorityLevel::Preferred => vec![preferred, other],
            PriorityLevel::Discouraged => vec![other, preferred],
            PriorityLevel::Indifferent => {
                let mut merged = preferred;
                merged.extend(other);
                merged.shuffle(rng);
                vec![merged]
            }
        }
    }
}

#[cfg(test)]
mod priority_level_tests {
    use super::*;
    use crate::random::MazeRng;
    use rand::SeedableRng;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for p in PriorityLevel::ALL {
            assert_eq!(PriorityLevel::from_str(p.as_str()), Some(p));
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(PriorityLevel::from_str("not_a_priority"), None);
    }

    #[test]
    fn order_zones_required_is_preferred_only_no_fallback() {
        let mut rng = MazeRng::seed_from_u64(1);
        assert_eq!(
            PriorityLevel::Required.order_zones(vec![1], vec![2], &mut rng),
            vec![vec![1]]
        );
    }

    #[test]
    fn order_zones_forbidden_is_other_only_no_fallback() {
        let mut rng = MazeRng::seed_from_u64(1);
        assert_eq!(
            PriorityLevel::Forbidden.order_zones(vec![1], vec![2], &mut rng),
            vec![vec![2]]
        );
    }

    #[test]
    fn order_zones_preferred_falls_back_to_other() {
        let mut rng = MazeRng::seed_from_u64(1);
        assert_eq!(
            PriorityLevel::Preferred.order_zones(vec![1], vec![2], &mut rng),
            vec![vec![1], vec![2]]
        );
    }

    #[test]
    fn order_zones_discouraged_falls_back_to_preferred() {
        let mut rng = MazeRng::seed_from_u64(1);
        assert_eq!(
            PriorityLevel::Discouraged.order_zones(vec![1], vec![2], &mut rng),
            vec![vec![2], vec![1]]
        );
    }

    #[test]
    fn order_zones_indifferent_merges_into_one_zone() {
        let mut rng = MazeRng::seed_from_u64(1);
        let zones = PriorityLevel::Indifferent.order_zones(vec![1], vec![2], &mut rng);
        assert_eq!(zones.len(), 1);
        let mut merged = zones[0].clone();
        merged.sort();
        assert_eq!(merged, vec![1, 2]);
    }

    #[test]
    fn order_zones_indifferent_shuffles_the_merged_zone() {
        // A large enough merged zone that "shuffled" vs "preferred-then-other" is distinguishable
        // for at least one of a few different seeds -- guards against a no-op shuffle silently
        // reintroducing the preferred-then-other bias `order_zones` is meant to remove.
        let preferred: Vec<i32> = (0..20).collect();
        let other: Vec<i32> = (20..40).collect();
        let unshuffled: Vec<i32> = preferred.iter().chain(other.iter()).copied().collect();
        let saw_different_order = (0..10u64).any(|seed| {
            let mut rng = MazeRng::seed_from_u64(seed);
            let zones =
                PriorityLevel::Indifferent.order_zones(preferred.clone(), other.clone(), &mut rng);
            zones[0] != unshuffled
        });
        assert!(
            saw_different_order,
            "expected at least one seed to produce a shuffled order"
        );
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
        StrategyParamKind::Interval {
            default_min,
            default_max,
            ..
        } => StrategyParamValue::Interval(*default_min, *default_max),
        StrategyParamKind::Priority { default } => StrategyParamValue::Priority(*default),
    }
}

fn parse_param(raw: &str, kind: &StrategyParamKind) -> Option<StrategyParamValue> {
    match kind {
        StrategyParamKind::Float { min, max, .. } => raw
            .parse::<f64>()
            .ok()
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
            let lo = lo_raw
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())?;
            let hi = hi_raw
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())?;
            if lo > hi {
                return None;
            }
            Some(StrategyParamValue::Interval(
                lo.clamp(*min, *max),
                hi.clamp(*min, *max),
            ))
        }
        StrategyParamKind::Priority { .. } => {
            PriorityLevel::from_str(raw).map(StrategyParamValue::Priority)
        }
    }
}
