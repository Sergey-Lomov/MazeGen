/// Shared scope policy for count/density-style checks that can be evaluated either against the
/// whole maze at once or independently per floor — see GitHub issue #369 (split out of #342, which
/// covers geometric/distance checks becoming floor-aware; this covers count/density checks
/// instead). Mirrors `GeometricFloorMode`'s "shared parametrizing enum" shape, but is check-level,
/// not rule-level: count/density checks are almost always mutually exclusive within a rule, and
/// several rules mix a count/density check with other checks for which a floor split has no
/// meaning, so there is no natural rule-wide value to share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FloorScope {
    /// Threshold evaluated once, against the whole maze (every floor combined) — behavior
    /// unchanged from before floors existed.
    WholeMaze,
    /// Threshold evaluated independently per floor. An entity spanning two floors (e.g. a
    /// cross-floor teleport) counts toward both floors' own tally.
    PerFloor,
}

impl FloorScope {
    pub const ALL: [FloorScope; 2] = [FloorScope::WholeMaze, FloorScope::PerFloor];

    pub fn as_str(self) -> &'static str {
        match self {
            FloorScope::WholeMaze => "whole_maze",
            FloorScope::PerFloor => "per_floor",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "whole_maze" => Some(FloorScope::WholeMaze),
            "per_floor" => Some(FloorScope::PerFloor),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for m in FloorScope::ALL {
            assert_eq!(FloorScope::from_str(m.as_str()), Some(m));
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(FloorScope::from_str("not_a_mode"), None);
    }
}
