//! Wire form of a floor's topology (GitHub issue #836, `Specs/topology.md`, "Wire form"): the
//! shared shape of the `topology` key of `GenerateConfig` / `ComputeAnalyticsConfig` and of the
//! project file's `topology` section. Cells use the tessellation's wire point encoding.

use crate::config_dto::TessellationConfig;
use maze_core::space::{
    Fold, FoldEnd, FoldGroup, FoldGroupId, FoldId, MultiLevelField, Tessellation,
    TessellationFingerprint, Topology,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One side of a fold: a wire cell and the position of the face in the cell's `faces_of`.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct FoldEndDto {
    pub cell: [i32; 2],
    pub face_idx: usize,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct FoldDto {
    pub a: FoldEndDto,
    pub b: FoldEndDto,
    #[serde(default)]
    pub twist: bool,
    pub group: u32,
}

/// `folds` are indices into `TopologyDto::folds`.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct FoldGroupDto {
    pub id: u32,
    pub folds: Vec<usize>,
}

/// Topology of one floor. `fingerprint` is the canonical string of the tessellation config the
/// topology was authored for (`tessellation_fingerprint`).
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct TopologyDto {
    pub fingerprint: String,
    #[serde(default)]
    pub folds: Vec<FoldDto>,
    #[serde(default)]
    pub groups: Vec<FoldGroupDto>,
}

/// Canonical rendering of a tessellation config: the kind name followed by the params as JSON
/// with sorted keys, e.g. `square{}` or `radial{"first_ring_cells":9,...}`. The same config
/// always yields the same string. A whole-valued number renders as an integer whether it arrived
/// as `1` or `1.0`, so the web client (`tessellationFingerprint`) produces the same string.
pub fn tessellation_fingerprint(config: &TessellationConfig) -> TessellationFingerprint {
    let kind = serde_json::to_value(config.kind)
        .expect("a tessellation kind serializes to JSON")
        .as_str()
        .expect("a tessellation kind serializes to a string")
        .to_string();
    let params: BTreeMap<&String, serde_json::Value> = config
        .params
        .iter()
        .map(|(key, value)| (key, canonical_number(value)))
        .collect();
    let params = serde_json::to_string(&params).expect("JSON params serialize to a string");
    TessellationFingerprint::new(format!("{kind}{params}"))
}

fn canonical_number(value: &serde_json::Value) -> serde_json::Value {
    match value.as_f64() {
        Some(number) if value.is_f64() && number.fract() == 0.0 && number.abs() < 1e15 => {
            serde_json::Value::from(number as i64)
        }
        _ => value.clone(),
    }
}

/// Decodes and structurally validates a floor's topology. The fingerprint is checked first, so a
/// topology authored for another config is rejected before any cell is interpreted. Wire cells
/// are validated like other wire points: `cell_from_xy` returns `None` for a point it cannot
/// decode and every decoded cell must be valid for `tessellation`. Errors name the offending fold
/// or group.
pub fn decode_topology<T: Tessellation>(
    dto: &TopologyDto,
    tessellation: &T,
    cell_from_xy: impl Fn(i32, i32) -> Option<T::CellId>,
    current: &TessellationFingerprint,
) -> Result<Topology<T>, String> {
    if dto.fingerprint != current.as_str() {
        return Err(format!(
            "topology was authored for tessellation `{}`, current is `{}`",
            dto.fingerprint,
            current.as_str()
        ));
    }
    let end = |fold: usize, side: &str, end: &FoldEndDto| -> Result<FoldEnd<T::CellId>, String> {
        let [x, y] = end.cell;
        match cell_from_xy(x, y).filter(|&cell| tessellation.is_valid_cell(cell)) {
            Some(cell) => Ok(FoldEnd {
                cell,
                face_idx: end.face_idx,
            }),
            None => Err(format!("folds[{fold}].{side}: invalid cell [{x}, {y}]")),
        }
    };
    let folds = dto
        .folds
        .iter()
        .enumerate()
        .map(|(i, fold)| {
            Ok(Fold {
                a: end(i, "a", &fold.a)?,
                b: end(i, "b", &fold.b)?,
                twist: fold.twist,
                group: FoldGroupId(fold.group),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let groups = dto
        .groups
        .iter()
        .map(|group| FoldGroup {
            id: FoldGroupId(group.id),
            folds: group.folds.iter().map(|&fold| FoldId(fold)).collect(),
        })
        .collect();
    let topology = Topology::new(current.clone(), folds, groups);
    topology
        .validate(tessellation, current)
        .map_err(|error| error.to_string())?;
    Ok(topology)
}

/// Encodes a topology into its wire form (the inverse of `decode_topology`).
pub fn encode_topology<T: Tessellation>(
    topology: &Topology<T>,
    cell_to_xy: impl Fn(T::CellId) -> (i32, i32),
) -> TopologyDto {
    let end = |end: &FoldEnd<T::CellId>| {
        let (x, y) = cell_to_xy(end.cell);
        FoldEndDto {
            cell: [x, y],
            face_idx: end.face_idx,
        }
    };
    TopologyDto {
        fingerprint: topology.fingerprint().as_str().to_string(),
        folds: topology
            .folds()
            .iter()
            .map(|fold| FoldDto {
                a: end(&fold.a),
                b: end(&fold.b),
                twist: fold.twist,
                group: fold.group.0,
            })
            .collect(),
        groups: topology
            .groups()
            .iter()
            .map(|group| FoldGroupDto {
                id: group.id.0,
                folds: group.folds.iter().map(|fold| fold.0).collect(),
            })
            .collect(),
    }
}

/// Installs the per-floor topologies of a config on `field`, in `levels_ordered` order. A missing
/// or `null` entry leaves the floor without folds. More entries than floors is an error, as is
/// any invalid topology; errors are prefixed with the floor index.
pub fn install_topologies<T: Tessellation>(
    field: &mut MultiLevelField<T>,
    topologies: &[Option<TopologyDto>],
    tessellation: &T,
    cell_from_xy: impl Fn(i32, i32) -> Option<T::CellId>,
    config: &TessellationConfig,
) -> Result<(), String> {
    let levels: Vec<_> = field.levels_ordered().collect();
    if topologies.len() > levels.len() {
        return Err(format!(
            "topology has {} entries for {} floors",
            topologies.len(),
            levels.len()
        ));
    }
    let fingerprint = tessellation_fingerprint(config);
    for (floor, (level, dto)) in levels.into_iter().zip(topologies).enumerate() {
        let Some(dto) = dto else { continue };
        let topology = decode_topology(dto, tessellation, &cell_from_xy, &fingerprint)
            .map_err(|error| format!("topology[{floor}]: {error}"))?;
        field
            .set_topology(level, topology, &fingerprint)
            .map_err(|error| format!("topology[{floor}]: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_dto::TessellationKind;
    use maze_core::space::{SquarePoint, SquareTessellation};

    fn config() -> TessellationConfig {
        TessellationConfig {
            kind: TessellationKind::Square,
            params: serde_json::Map::new(),
        }
    }

    fn square(x: i32, y: i32) -> Option<SquarePoint> {
        Some(SquarePoint { x, y })
    }

    fn cylinder() -> TopologyDto {
        let end = |x, face_idx| FoldEndDto {
            cell: [x, 0],
            face_idx,
        };
        TopologyDto {
            fingerprint: "square{}".to_string(),
            folds: vec![FoldDto {
                a: end(2, 0),
                b: end(0, 2),
                twist: false,
                group: 0,
            }],
            groups: vec![FoldGroupDto {
                id: 0,
                folds: vec![0],
            }],
        }
    }

    #[test]
    fn fingerprint_is_canonical() {
        assert_eq!(tessellation_fingerprint(&config()).as_str(), "square{}");
        let mut radial = config();
        radial.kind = TessellationKind::Radial;
        radial.params.insert("max_cells".into(), 3000.into());
        radial.params.insert("first_ring_cells".into(), 9.into());
        assert_eq!(
            tessellation_fingerprint(&radial).as_str(),
            r#"radial{"first_ring_cells":9,"max_cells":3000}"#
        );
    }

    #[test]
    fn fingerprint_ignores_float_spelling_of_whole_numbers() {
        let mut voronoi = config();
        voronoi.kind = TessellationKind::Voronoi;
        voronoi.params.insert("jitter".into(), 0.15.into());
        voronoi.params.insert("seed".into(), serde_json::json!(1.0));
        assert_eq!(
            tessellation_fingerprint(&voronoi).as_str(),
            r#"voronoi{"jitter":0.15,"seed":1}"#
        );
    }

    #[test]
    fn wire_round_trips() {
        let fingerprint = tessellation_fingerprint(&config());
        let topology =
            decode_topology(&cylinder(), &SquareTessellation, square, &fingerprint).unwrap();
        let dto = encode_topology(&topology, |p: SquarePoint| (p.x, p.y));
        assert_eq!(dto, cylinder());
        let json = serde_json::to_string(&dto).unwrap();
        assert_eq!(serde_json::from_str::<TopologyDto>(&json).unwrap(), dto);
    }

    #[test]
    fn omitted_twist_defaults_to_false() {
        let json = r#"{ "fingerprint": "square{}", "folds": [
            { "a": { "cell": [2, 0], "face_idx": 0 }, "b": { "cell": [0, 0], "face_idx": 2 }, "group": 0 }
        ], "groups": [{ "id": 0, "folds": [0] }] }"#;
        let dto: TopologyDto = serde_json::from_str(json).unwrap();
        assert_eq!(dto, cylinder());
    }

    #[test]
    fn rejects_fingerprint_mismatch_with_both_configs() {
        let mut dto = cylinder();
        dto.fingerprint = "hex{}".to_string();
        let fingerprint = tessellation_fingerprint(&config());
        let error = decode_topology(&dto, &SquareTessellation, square, &fingerprint)
            .map(|_| ())
            .unwrap_err();
        assert!(
            error.contains("hex{}") && error.contains("square{}"),
            "{error}"
        );
    }

    #[test]
    fn rejects_undecodable_and_invalid_cells_naming_the_fold() {
        let fingerprint = tessellation_fingerprint(&config());
        let none = |_, _| None;
        let error = decode_topology(&cylinder(), &SquareTessellation, none, &fingerprint)
            .map(|_| ())
            .unwrap_err();
        assert!(error.contains("folds[0].a"), "{error}");
    }

    #[test]
    fn rejects_structural_violations_with_reasons() {
        let fingerprint = tessellation_fingerprint(&config());
        let check = |mutate: fn(&mut TopologyDto), needle: &str| {
            let mut dto = cylinder();
            mutate(&mut dto);
            let error = decode_topology(&dto, &SquareTessellation, square, &fingerprint)
                .map(|_| ())
                .unwrap_err();
            assert!(error.contains(needle), "{needle}: {error}");
        };
        check(|dto| dto.folds[0].a.face_idx = 9, "face 9");
        check(|dto| dto.folds[0].b = dto.folds[0].a, "glued to itself");
        check(|dto| dto.groups.clear(), "group 0 does not exist");
        check(|dto| dto.groups[0].folds = vec![], "belongs to no group");
        check(|dto| dto.groups[0].folds = vec![3], "unknown fold 3");
    }
}
