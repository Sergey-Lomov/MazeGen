use crate::generation_config::TessellationConfig;
use maze_core::space::geometry::Point;
use maze_core::space::{
    AutoZoneFloor, AutoZoneKey, Tessellation, ZoneCell, ZoneId, ZoneIndex, ZoneKind, ZoneSet,
    compute_auto_zones,
};
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

/// One floor of an automatic-zones request as it comes over the wire: how many of the flat `cells`
/// array's points are the floor's, its crease segments in world units and whether its topology has
/// folds. The cells travel apart, as one flat `Int32Array`, because marshalling tens of thousands of
/// small arrays through serde dominates the call otherwise.
#[derive(Deserialize)]
struct AutoZoneFloorWire {
    count: usize,
    #[serde(default)]
    creases: Vec<[[f64; 2]; 2]>,
    #[serde(default)]
    folded: bool,
}

#[derive(Deserialize)]
struct AutoZonesWire {
    tessellation: TessellationConfig,
    floors: Vec<AutoZoneFloorWire>,
}

/// One floor of an automatic-zones request: its field cells as wire points, its crease segments in
/// world units and whether its topology has folds.
struct AutoZoneFloorDto {
    cells: Vec<[i32; 2]>,
    creases: Vec<[[f64; 2]; 2]>,
    folded: bool,
}

struct AutoZonesConfig {
    tessellation: TessellationConfig,
    floors: Vec<AutoZoneFloorDto>,
}

/// Joins the wire metadata with the flat cells (`x0, y0, x1, y1, ...`, floors one after another).
fn auto_config_from_flat(wire: AutoZonesWire, flat: &[i32]) -> Result<AutoZonesConfig, String> {
    let total: usize = wire.floors.iter().map(|f| f.count).sum();
    if flat.len() != total * 2 {
        return Err(format!(
            "cells hold {} values, floors announce {} cells",
            flat.len(),
            total
        ));
    }
    let mut points = flat.chunks_exact(2).map(|p| [p[0], p[1]]);
    let floors = wire
        .floors
        .into_iter()
        .map(|floor| AutoZoneFloorDto {
            cells: points.by_ref().take(floor.count).collect(),
            creases: floor.creases,
            folded: floor.folded,
        })
        .collect();
    Ok(AutoZonesConfig {
        tessellation: wire.tessellation,
        floors,
    })
}

/// A zone's cells as one flat array (`floor0, x0, y0, floor1, x1, y1, ...`).
fn flatten_zone_cells(cells: &[[i32; 3]]) -> Vec<i32> {
    cells.iter().flatten().copied().collect()
}

/// An automatic zone: its identity key (`maze`, `floor:F`, `type:F:T`, `edge:F`, `face:F:I`, `region:F:I`) and
/// its cells as `[floor, x, y]`.
#[derive(Clone, Debug, PartialEq)]
pub struct AutoZoneDto {
    pub key: String,
    pub cells: Vec<[i32; 3]>,
}

/// Computes the automatic zones of the field (`Specs/zones.md`, "Automatic zones"). `config` holds
/// the tessellation and each floor's cell count, creases and fold flag; `cells` is every floor's
/// field cells as one flat `x, y` array. Every cell must be a cell of the tessellation. Returns an
/// array of `[key, Int32Array]` pairs, the array holding the zone's cells as `floor, x, y` triples.
#[wasm_bindgen]
pub fn zones_compute_auto(config: JsValue, cells: &[i32]) -> Result<JsValue, JsValue> {
    let wire: AutoZonesWire = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let cfg = auto_config_from_flat(wire, cells).map_err(|e| JsValue::from_str(&e))?;
    let zones = auto_zones_for(&cfg).map_err(|e| JsValue::from_str(&e))?;
    let out = js_sys::Array::new();
    for zone in &zones {
        let pair = js_sys::Array::new();
        pair.push(&JsValue::from_str(&zone.key));
        pair.push(&js_sys::Int32Array::from(flatten_zone_cells(&zone.cells).as_slice()));
        out.push(&pair);
    }
    Ok(out.into())
}

fn auto_zones_for(cfg: &AutoZonesConfig) -> Result<Vec<AutoZoneDto>, String> {
    build_tessellation(&cfg.tessellation, AutoZones { floors: &cfg.floors })?
}

fn auto_key_string(key: AutoZoneKey) -> String {
    match key {
        AutoZoneKey::Maze => "maze".to_string(),
        AutoZoneKey::CellType { floor, index } => format!("type:{floor}:{index}"),
        AutoZoneKey::Floor(f) => format!("floor:{f}"),
        AutoZoneKey::FieldEdge(f) => format!("edge:{f}"),
        AutoZoneKey::Face { floor, index } => format!("face:{floor}:{index}"),
        AutoZoneKey::Region { floor, index } => format!("region:{floor}:{index}"),
    }
}

struct AutoZones<'a> {
    floors: &'a [AutoZoneFloorDto],
}

impl TessellationVisitor for AutoZones<'_> {
    type Output = Result<Vec<AutoZoneDto>, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let floors = self
            .floors
            .iter()
            .enumerate()
            .map(|(index, floor)| {
                let cells = floor
                    .cells
                    .iter()
                    .map(|&[x, y]| {
                        let cell = (codec.from_xy)(x, y);
                        if tessellation.is_valid_cell(cell) {
                            Ok(cell)
                        } else {
                            Err(format!("floor {index}: invalid cell [{x}, {y}]"))
                        }
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(AutoZoneFloor {
                    cells,
                    creases: floor
                        .creases
                        .iter()
                        .map(|&[a, b]| [Point::new(a[0], a[1]), Point::new(b[0], b[1])])
                        .collect(),
                    folded: floor.folded,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let dto: Vec<AutoZoneDto> = compute_auto_zones(&*tessellation, &floors)
            .into_iter()
            .map(|zone| AutoZoneDto {
                key: auto_key_string(zone.key),
                cells: zone
                    .cells
                    .into_iter()
                    .map(|c| {
                        let (x, y) = (codec.to_xy)(c.cell);
                        [c.floor as i32, x, y]
                    })
                    .collect(),
            })
            .collect();
        Ok(dto)
    }
}

fn zones_normalize_for(cfg: &ZonesConfig) -> Result<Vec<ZoneDto>, String> {
    build_tessellation(&cfg.tessellation, Normalize { zones: &cfg.zones })?
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
            Ok((
                ZoneId::new(zone.id),
                zone.name.clone(),
                zone.kind.into(),
                cells,
            ))
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
            .map(|q| {
                index
                    .zones_of(q.floor, q.cell)
                    .iter()
                    .map(|id| id.raw())
                    .collect()
            })
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
            zones: vec![zone(
                5,
                ZoneKindDto::Manual,
                vec![[0, 1, 1], [0, 0, 0], [0, 1, 1]],
            )],
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
        assert_eq!(
            zones_normalize_for(&cfg),
            Err("duplicate zone id 1".to_string())
        );
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
    fn auto_zones_cover_the_maze_and_key_their_zones() {
        let cfg = AutoZonesConfig {
            tessellation: square(),
            floors: vec![AutoZoneFloorDto {
                cells: vec![[0, 0], [1, 0]],
                creases: vec![],
                folded: false,
            }],
        };
        let zones = auto_zones_for(&cfg).unwrap();
        let keys: Vec<_> = zones.iter().map(|z| z.key.as_str()).collect();
        assert_eq!(keys, ["maze", "edge:0"]);
        assert_eq!(zones[0].cells, vec![[0, 0, 0], [0, 1, 0]]);
    }

    #[test]
    fn auto_zones_key_cell_type_zones_by_floor_and_type_index() {
        let cfg = AutoZonesConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::SquareOctagon,
                params: serde_json::Map::new(),
            },
            floors: vec![
                AutoZoneFloorDto { cells: vec![[0, 0], [1, 1]], creases: vec![], folded: false },
                AutoZoneFloorDto { cells: vec![[0, 0], [1, 1]], creases: vec![], folded: false },
            ],
        };
        let keys: Vec<_> = auto_zones_for(&cfg).unwrap().into_iter().map(|z| z.key).collect();
        for key in ["type:0:0", "type:0:1", "type:1:0", "type:1:1"] {
            assert!(keys.iter().any(|k| k == key), "{key} missing from {keys:?}");
        }
    }

    #[test]
    fn auto_zones_reject_an_invalid_cell() {
        let cfg = AutoZonesConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::SquareOctagon,
                params: serde_json::Map::new(),
            },
            floors: vec![AutoZoneFloorDto {
                cells: vec![[1, 2]],
                creases: vec![],
                folded: false,
            }],
        };
        assert_eq!(
            auto_zones_for(&cfg),
            Err("floor 0: invalid cell [1, 2]".to_string())
        );
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

    #[test]
    fn flat_cells_are_split_between_the_floors() {
        let wire = AutoZonesWire {
            tessellation: square(),
            floors: vec![
                AutoZoneFloorWire { count: 2, creases: vec![], folded: false },
                AutoZoneFloorWire { count: 1, creases: vec![], folded: true },
            ],
        };
        let cfg = auto_config_from_flat(wire, &[0, 0, 1, 0, 5, 6]).unwrap();
        assert_eq!(cfg.floors[0].cells, vec![[0, 0], [1, 0]]);
        assert_eq!(cfg.floors[1].cells, vec![[5, 6]]);
        assert!(cfg.floors[1].folded);
    }

    #[test]
    fn flat_cells_must_match_the_announced_counts() {
        let wire = AutoZonesWire {
            tessellation: square(),
            floors: vec![AutoZoneFloorWire { count: 2, creases: vec![], folded: false }],
        };
        assert!(auto_config_from_flat(wire, &[0, 0, 1]).is_err());
    }

    #[test]
    fn zone_cells_flatten_to_floor_x_y_triples() {
        assert_eq!(flatten_zone_cells(&[[0, 1, 2], [1, 3, 4]]), vec![0, 1, 2, 1, 3, 4]);
    }
}
