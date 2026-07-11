pub mod params;
pub mod result;
pub mod strategy;
pub mod strategies;
pub mod snapshot;
pub mod nested_dispatch;

pub use params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
pub use result::RepairResult;
pub use strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig};
pub use snapshot::SnapshotStack;
pub use nested_dispatch::{dispatch_weighted, WeightedCandidate};
pub use strategies::{RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy, InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, MissingLoopsRandomStrategy, ExpandRegionPassageStrategy, TeleportRegionMergeStrategy, MissingRegionsStrategy, ReduceSccCountStrategy, RemoveTeleportStrategy, TeleportGroupProximityStrategy, WeightedRegionMergeStrategy, PARAM_PRIORITY as TELEPORT_GROUP_PROXIMITY_PARAM_PRIORITY, PRIORITY_RANDOM as TELEPORT_GROUP_PROXIMITY_PRIORITY_RANDOM, PRIORITY_PROBLEMATIC as TELEPORT_GROUP_PROXIMITY_PRIORITY_PROBLEMATIC};
