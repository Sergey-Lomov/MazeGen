/// Which teleport portals a check considers, filtered by whether the portal crosses floors —
/// GitHub issue #379 follow-up. A portal is `InterFloor` when its two endpoints share no floor
/// (see `floors_of_node`), `SameFloor` when they share at least one. Used by
/// `MaxTeleportCountCheck`/`MaxTeleportDensityCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportFloorKindFilter {
    /// Every portal, same-floor or inter-floor alike.
    Any,
    /// Only portals whose endpoints share no floor.
    InterFloor,
    /// Only portals whose endpoints share at least one floor.
    SameFloor,
}

impl TeleportFloorKindFilter {
    pub const ALL_VALUES: [TeleportFloorKindFilter; 3] = [
        TeleportFloorKindFilter::Any,
        TeleportFloorKindFilter::InterFloor,
        TeleportFloorKindFilter::SameFloor,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TeleportFloorKindFilter::Any => "any",
            TeleportFloorKindFilter::InterFloor => "inter_floor",
            TeleportFloorKindFilter::SameFloor => "same_floor",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "any" => Some(TeleportFloorKindFilter::Any),
            "inter_floor" => Some(TeleportFloorKindFilter::InterFloor),
            "same_floor" => Some(TeleportFloorKindFilter::SameFloor),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for f in TeleportFloorKindFilter::ALL_VALUES {
            assert_eq!(TeleportFloorKindFilter::from_str(f.as_str()), Some(f));
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(TeleportFloorKindFilter::from_str("not_a_filter"), None);
    }
}
