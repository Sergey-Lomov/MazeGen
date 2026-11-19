use crate::generation_config::TessellationConfig;
use maze_core::space::{Tessellation, ZoneCell, ZoneId, ZoneIndex, ZoneKind, ZoneSet};
use maze_runner::runner::tessellation_factory::{
    CellCodec, TessellationVisitor, build_tessellation,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// Wire form of a zone: `cells` are `[floor, x, y]` triples, `floor` being the index in the
/// client's `floors` array and `[x, y]` the tessellation's wire point.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ZoneDto {
    pub id: u32,
    pub name: String,
    pub kind: ZoneKindDto,
    pub cells: Vec<[i32; 3]>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ZoneKindDto {
    Auto,
    Manual,
}

impl From<ZoneKindDto> for ZoneKind {
    fn from(kind: ZoneKindDto) -> Self {
        match kind {
            ZoneKindDto::Auto => ZoneKind::Auto,
            ZoneKindDto::Manual => ZoneKind::Manual,
        }
    }
}

impl From<ZoneKind> for ZoneKindDto {
    fn from(kind: ZoneKind) -> Self {
        match kind {
            ZoneKind::Auto => ZoneKindDto::Auto,
            ZoneKind::Manual => ZoneKindDto::Manual,
        }
    }
}

#[derive(Deserialize)]
struct ZonesConfig {
    tessellation: TessellationConfig,
    zones: Vec<ZoneDto>,
}

#[derive(Deserialize)]
struct ZonesOfCellsConfig {
    tessellation: TessellationConfig,
    zones: Vec<ZoneDto>,
    cells: Vec<[i32; 3]>,
}

/// Validates zones against the tessellation (every cell must be a cell of it, ids must be unique)
/// and returns them normalized: cells deduplicated and in core's deterministic order. The error
/// names the zone and the first offending cell.
#[wasm_bindgen]
pub fn zones_normalize(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: ZonesConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let zones = zones_normalize_for(&cfg).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&zones).unwrap())
}

/// Cell-to-zones lookup for hover tooltips: `result[i]` lists the ids (zone order) of the zones
/// containing `cells[i]`. A queried cell must be a cell of the tessellation.
#[wasm_bindgen]
pub fn zones_of_cells(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: ZonesOfCellsConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let ids = zones_of_cells_for(&cfg).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&ids).unwrap())
}

fn zones_normalize_for(cfg: &ZonesConfig) -> Result<Vec<ZoneDto>, String> {
    build_tessellation(
        &cfg.tessellation,
        Normalize {
            zones: &cfg.zones,
        },
    )?
}

fn zones_of_cells_for(cfg: &ZonesOfCellsConfig) -> Result<Vec<Vec<u32>>, String> {
    build_tessellation(
        &cfg.tessellation,
        OfCells {
            zones: &cfg.zones,
            cells: &cfg.cells,
        },
    )?
}

fn decode_cells<T: Tessellation>(
    tessellation: &T,
    codec: &CellCodec<T>,
    cells: &[[i32; 3]],
) -> Result<Vec<ZoneCell<T::CellId>>, String> {
    cells
        .iter()
        .map(|&[floor, x, y]| {
            let floor = usize::try_from(floor).map_err(|_| format!("invalid floor {floor}"))?;
            let cell = (codec.from_xy)(x, y);
            if !tessellation.is_valid_cell(cell) {
                return Err(format!("invalid cell [{x}, {y}]"));
            }
            Ok(ZoneCell::new(floor, cell))
        })
        .collect()
}

fn build_set<T: Tessellation>(
    tessellation: &T,
    codec: &CellCodec<T>,
    zones: &[ZoneDto],
) -> Result<ZoneSet<T::CellId>, String> {
    let entries = zones
        .iter()
        .map(|zone| {
            let cells = decode_cells(tessellation, codec, &zone.cells)
                .map_err(|e| format!("zone {}: {e}", zone.id))?;
            Ok((ZoneId::new(zone.id), zone.name.clone(), zone.kind.into(), cells))
        })
        .collect::<Result<Vec<_>, String>>()?;
    ZoneSet::from_zones(entries)
}

struct Normalize<'a> {
    zones: &'a [ZoneDto],
}

impl TessellationVisitor for Normalize<'_> {
    type Output = Result<Vec<ZoneDto>, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let set = build_set(&*tessellation, &codec, self.zones)?;
        Ok(set
            .zones()
            .iter()
            .map(|zone| ZoneDto {
                id: zone.id().raw(),
                name: zone.name.clone(),
                kind: zone.kind.into(),
                cells: zone
                    .cells()
                    .map(|c| {
                        let (x, y) = (codec.to_xy)(c.cell);
                        [c.floor as i32, x, y]
                    })
                    .collect(),
            })
            .collect())
    }
}

struct OfCells<'a> {
    zones: &'a [ZoneDto],
    cells: &'a [[i32; 3]],
}

impl TessellationVisitor for OfCells<'_> {
    type Output = Result<Vec<Vec<u32>>, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let set = build_set(&*tessellation, &codec, self.zones)?;
        let queries = decode_cells(&*tessellation, &codec, self.cells)?;
        let index = ZoneIndex::build(&set);
        Ok(queries
            .into_iter()
            .map(|q| index.zones_of(q.floor, q.cell).iter().map(|id| id.raw()).collect())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maze_runner::config::TessellationKind;

    fn square() -> TessellationConfig {
        TessellationConfig {
            kind: TessellationKind::Square,
            params: serde_json::Map::new(),
        }
    }

    fn zone(id: u32, kind: ZoneKindDto, cells: Vec<[i32; 3]>) -> ZoneDto {
        ZoneDto {
            id,
            name: format!("z{id}"),
            kind,
            cells,
        }
    }

    #[test]
    fn normalize_dedups_cells_and_keeps_ids() {
        let cfg = ZonesConfig {
            tessellation: square(),
            zones: vec![zone(5, ZoneKindDto::Manual, vec![[0, 1, 1], [0, 0, 0], [0, 1, 1]])],
        };
        let out = zones_normalize_for(&cfg).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, 5);
        assert_eq!(out[0].cells.len(), 2);
    }

    #[test]
    fn normalize_rejects_duplicate_ids() {
        let cfg = ZonesConfig {
            tessellation: square(),
            zones: vec![
                zone(1, ZoneKindDto::Auto, vec![]),
                zone(1, ZoneKindDto::Manual, vec![]),
            ],
        };
        assert_eq!(zones_normalize_for(&cfg), Err("duplicate zone id 1".to_string()));
    }

    #[test]
    fn normalize_names_zone_with_invalid_cell() {
        let cfg = ZonesConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::SquareOctagon,
                params: serde_json::Map::new(),
            },
            zones: vec![zone(3, ZoneKindDto::Manual, vec![[0, 0, 0], [0, 1, 2]])],
        };
        assert_eq!(
            zones_normalize_for(&cfg),
            Err("zone 3: invalid cell [1, 2]".to_string())
        );
    }

    #[test]
    fn normalize_rejects_a_negative_floor() {
        let cfg = ZonesConfig {
            tessellation: square(),
            zones: vec![zone(4, ZoneKindDto::Auto, vec![[-1, 0, 0]])],
        };
        assert_eq!(
            zones_normalize_for(&cfg),
            Err("zone 4: invalid floor -1".to_string())
        );
    }

    #[test]
    fn zone_wire_shape_matches_the_web_mirror() {
        let json = serde_json::json!({
            "id": 2,
            "name": "a",
            "kind": "manual",
            "cells": [[1, 3, -4]],
        });
        let dto: ZoneDto = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(
            dto,
            ZoneDto {
                id: 2,
                name: "a".to_string(),
                kind: ZoneKindDto::Manual,
                cells: vec![[1, 3, -4]],
            }
        );
        assert_eq!(serde_json::to_value(&dto).unwrap(), json);
        assert_eq!(serde_json::to_value(ZoneKindDto::Auto).unwrap(), "auto");
    }

    #[test]
    fn zones_of_cells_lists_overlapping_zones_per_floor() {
        let cfg = ZonesOfCellsConfig {
            tessellation: square(),
            zones: vec![
                zone(1, ZoneKindDto::Manual, vec![[0, 0, 0], [0, 1, 0]]),
                zone(2, ZoneKindDto::Auto, vec![[0, 1, 0], [1, 1, 0]]),
            ],
            cells: vec![[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
        };
        assert_eq!(
            zones_of_cells_for(&cfg),
            Ok(vec![vec![1], vec![1, 2], vec![2], vec![]])
        );
    }
}
