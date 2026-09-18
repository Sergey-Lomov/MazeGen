use crate::dto::{
    CrossElementPayloadEntryDto, IssueEdgeGroupPayloadDto, IssueMissingElevatorStopsPayloadDto,
    IssueRegionPayloadDto, IssueRouteEdgeDto, IssueRoutePayloadDto, IssueSplitGroupPayloadDto,
    IssueSplitTilePayloadDto, OneWayDirectionDto, SplitFaceRequirementDto,
};
use maze_core::{
    generation::{OneWayDirection, SplitFaceRequirement},
    quality_control::{
        CrossElementPayloadEntry, IssueEdgeGroupPayload, IssueMissingElevatorStopsPayload,
        IssueRegionPayload, IssueRoutePayload, IssueSplitGroupPayload, IssueSplitTilePayload,
    },
};
use std::collections::HashMap;

pub(super) fn edge_group_map_dto(
    map: HashMap<String, Vec<IssueEdgeGroupPayload>>,
) -> HashMap<String, Vec<IssueEdgeGroupPayloadDto>> {
    map.into_iter()
        .map(|(k, v)| {
            (
                k,
                v.into_iter()
                    .map(|g| IssueEdgeGroupPayloadDto {
                        edges: g.edges,
                        preset_locked: g.preset_locked,
                    })
                    .collect(),
            )
        })
        .collect()
}

fn split_tile_dto(tile: IssueSplitTilePayload) -> IssueSplitTilePayloadDto {
    IssueSplitTilePayloadDto {
        nodes: tile.nodes,
        preset_locked: tile.preset_locked,
    }
}

pub(super) fn split_group_map_dto(
    map: HashMap<String, Vec<IssueSplitGroupPayload>>,
) -> HashMap<String, Vec<IssueSplitGroupPayloadDto>> {
    map.into_iter()
        .map(|(k, v)| {
            (
                k,
                v.into_iter()
                    .map(|g| IssueSplitGroupPayloadDto {
                        tiles: g.tiles.into_iter().map(split_tile_dto).collect(),
                        preset_locked: g.preset_locked,
                    })
                    .collect(),
            )
        })
        .collect()
}

pub(super) fn route_payload_map_dto(
    map: HashMap<String, Vec<IssueRoutePayload>>,
) -> HashMap<String, Vec<IssueRoutePayloadDto>> {
    map.into_iter()
        .map(|(k, v)| {
            (
                k,
                v.into_iter()
                    .map(|r| IssueRoutePayloadDto {
                        edges: r
                            .edges
                            .into_iter()
                            .map(|e| IssueRouteEdgeDto {
                                from: e.from,
                                to: e.to,
                                is_split_edge: e.is_split_edge,
                            })
                            .collect(),
                        preset_locked: r.preset_locked,
                    })
                    .collect(),
            )
        })
        .collect()
}

pub(super) fn region_payload_map_dto(
    map: HashMap<String, Vec<IssueRegionPayload>>,
) -> HashMap<String, Vec<IssueRegionPayloadDto>> {
    map.into_iter()
        .map(|(k, v)| {
            (
                k,
                v.into_iter()
                    .map(|r| IssueRegionPayloadDto {
                        region: r.region,
                        preset_locked: r.preset_locked,
                    })
                    .collect(),
            )
        })
        .collect()
}

pub(super) fn missing_elevator_stops_map_dto(
    map: HashMap<String, Vec<IssueMissingElevatorStopsPayload>>,
) -> HashMap<String, Vec<IssueMissingElevatorStopsPayloadDto>> {
    map.into_iter()
        .map(|(k, v)| {
            (
                k,
                v.into_iter()
                    .map(|e| IssueMissingElevatorStopsPayloadDto {
                        edges: e.edges,
                        missing: e.missing,
                        available: e.available,
                        preset_locked: e.preset_locked,
                    })
                    .collect(),
            )
        })
        .collect()
}

fn cross_element_entry_dto(entry: CrossElementPayloadEntry) -> CrossElementPayloadEntryDto {
    CrossElementPayloadEntryDto {
        kind: entry.kind.to_string(),
        edges: entry.edges,
        nodes: entry.nodes,
        tile: entry.tile.map(split_tile_dto),
        removable: entry.removable,
        preset_locked: entry.preset_locked,
    }
}

pub(super) fn cross_element_group_map_dto(
    map: HashMap<String, Vec<Vec<CrossElementPayloadEntry>>>,
) -> HashMap<String, Vec<Vec<CrossElementPayloadEntryDto>>> {
    map.into_iter()
        .map(|(k, v)| {
            (
                k,
                v.into_iter()
                    .map(|pair| pair.into_iter().map(cross_element_entry_dto).collect())
                    .collect(),
            )
        })
        .collect()
}

pub(super) fn split_face_requirement_dto(req: SplitFaceRequirement) -> SplitFaceRequirementDto {
    match req {
        SplitFaceRequirement::Passage => SplitFaceRequirementDto::Passage,
        SplitFaceRequirement::OneWay(OneWayDirection::Forward) => SplitFaceRequirementDto::OneWay {
            direction: OneWayDirectionDto::Forward,
        },
        SplitFaceRequirement::OneWay(OneWayDirection::Backward) => {
            SplitFaceRequirementDto::OneWay {
                direction: OneWayDirectionDto::Backward,
            }
        }
        SplitFaceRequirement::Wall => SplitFaceRequirementDto::Wall,
        SplitFaceRequirement::Unspecified => SplitFaceRequirementDto::Unspecified,
    }
}
