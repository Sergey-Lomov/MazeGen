/// Shared cross-floor policy for checks measuring a geometric (coordinate-based) distance between
/// two points — see GitHub issue #342. A plain Euclidean x-y distance is meaningless across floors
/// (two floors reuse the same coordinate range independently), so every such check needs an
/// explicit policy for a pair spanning different floors instead of silently mixing unrelated
/// coordinate systems. Used by `TeleportGeometricLengthCheck`/`OneWayGroupGeometricProximityCheck`,
/// mirrors `Comparison`'s "shared parametrizing enum" shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometricFloorMode {
    /// Floor is ignored — plain x-y distance, same as before floors existed.
    Ignore,
    /// Floor difference becomes a third coordinate, one unit per floor apart, folded into the
    /// same Euclidean distance as x/y (`space::floor_aware_distance`/`floor_aware_xy_distance`).
    AsCoordinate,
    /// A pair spanning different floors never fails the check, regardless of `Comparison` — the
    /// check's own scan skips it before computing any distance at all (never calls
    /// `floor_aware_distance`/`floor_aware_xy_distance` for such a pair).
    SameFloorOnly,
}

impl GeometricFloorMode {
    pub const ALL: [GeometricFloorMode; 3] = [
        GeometricFloorMode::Ignore,
        GeometricFloorMode::AsCoordinate,
        GeometricFloorMode::SameFloorOnly,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            GeometricFloorMode::Ignore => "ignore",
            GeometricFloorMode::AsCoordinate => "as_coordinate",
            GeometricFloorMode::SameFloorOnly => "same_floor_only",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "ignore" => Some(GeometricFloorMode::Ignore),
            "as_coordinate" => Some(GeometricFloorMode::AsCoordinate),
            "same_floor_only" => Some(GeometricFloorMode::SameFloorOnly),
            _ => None,
        }
    }

    /// Whether `floor_aware_distance`/`floor_aware_xy_distance` should fold the floor
    /// difference into the distance as a third coordinate — `Ignore` and `SameFloorOnly` both
    /// pass `false` here (`SameFloorOnly` never reaches the distance call for a cross-floor pair
    /// in the first place, but same-floor pairs under it still compute a plain x-y distance).
    pub fn include_height(self) -> bool {
        matches!(self, GeometricFloorMode::AsCoordinate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for m in GeometricFloorMode::ALL {
            assert_eq!(GeometricFloorMode::from_str(m.as_str()), Some(m));
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(GeometricFloorMode::from_str("not_a_mode"), None);
    }

    #[test]
    fn include_height_only_for_as_coordinate() {
        assert!(!GeometricFloorMode::Ignore.include_height());
        assert!(GeometricFloorMode::AsCoordinate.include_height());
        assert!(!GeometricFloorMode::SameFloorOnly.include_height());
    }
}
