use super::super::preset_setup_event::PresetSetupEvent;
use super::super::test_utils::*;
use super::*;
use crate::IdGenerator;
use crate::event_log::EventLog;
use crate::space::{SquarePoint, SquareTessellation};

mod connections;
mod locked;
mod repair;
mod resolve;
mod split_slots;
mod teleport;
mod vertical;

fn node_at(field: &MultiLevelField<crate::space::SquareTessellation>, x: i32, y: i32) -> NodeId {
    let level = field.single_level_id();
    field.node_at(level, SquarePoint { x, y }).unwrap()
}

fn original(x: i32, y: i32) -> PresetEndpoint {
    PresetEndpoint::original((x, y))
}

fn split(x: i32, y: i32, slot: u32) -> PresetEndpoint {
    PresetEndpoint {
        point: (x, y),
        slot: Some(slot),
        level: None,
    }
}

/// Runs `build_preset_state` on a square field with the identity cell mapping and no debug state.
#[allow(clippy::too_many_arguments)]
fn build(
    graph: &mut Graph,
    field: &mut MultiLevelField<SquareTessellation>,
    ids: &mut IdGenerator,
    connections: &[PresetConnection],
    passages: &[PresetVerticalPassage],
    elevators: &[PresetElevator],
    locked: &[LockedNode],
    split_points: &[((i32, i32), u32, u32)],
    log: Option<&mut EventLog<PresetSetupEvent>>,
) -> Result<PresetState, String> {
    build_preset_state(
        graph,
        field,
        ids,
        connections,
        passages,
        elevators,
        locked,
        split_points,
        |x, y| SquarePoint { x, y },
        log,
        None,
    )
}
