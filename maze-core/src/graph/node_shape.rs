//! Node shapes and their count limits — see `Specs/node-shape-limits.md` (GitHub issue #1008).

use crate::graph::Graph;
use crate::graph::classify::{GeometricNodeClass, classify_by_neighbors, shape_neighbors};
use crate::ids::NodeId;
use crate::space::{MultiLevelField, Tessellation, TessellationGeometry};
use std::collections::{BTreeMap, BTreeSet};

/// Interior angle of a turn in whole degrees. `0` means the angle could not be resolved.
pub type TurnAngle = u16;

const STRAIGHT_ANGLE: u16 = 180;

/// The open faces of a junction as their cyclic arrangement around the cell. Rotations of one
/// arrangement are the same layout; mirror images are different ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum JunctionLayout {
    /// Only the number of passages is known — the faces could not be resolved (a split cell, a
    /// passage to another level). Never one of `possible_node_shapes`.
    Unresolved(usize),
    /// The open faces among `sides`, as angular ranks (`Field::face_ranks`) rotated to the
    /// canonical form: the lexicographically smallest rank list, which always starts at `0`.
    /// `faces` holds the ranks as a bit mask.
    Faces { sides: u8, faces: u16 },
}

/// Most faces a cell may have for its junction layouts to be told apart.
const MAX_LAYOUT_SIDES: usize = 16;

impl JunctionLayout {
    /// The layout of a junction whose open faces have the given angular ranks among `sides` faces.
    /// `Unresolved` when there are fewer than three, a rank is out of range or the cell has more
    /// than `MAX_LAYOUT_SIDES` faces.
    pub fn from_ranks(sides: usize, ranks: &[usize]) -> Self {
        let unresolved = Self::Unresolved(ranks.len());
        if ranks.len() < 3 || sides > MAX_LAYOUT_SIDES || ranks.iter().any(|&r| r >= sides) {
            return unresolved;
        }
        let mut best: Option<Vec<usize>> = None;
        for &origin in ranks {
            let mut rotated: Vec<usize> = ranks
                .iter()
                .map(|&rank| (rank + sides - origin) % sides)
                .collect();
            rotated.sort_unstable();
            if best.as_ref().is_none_or(|b| rotated < *b) {
                best = Some(rotated);
            }
        }
        let faces = best
            .unwrap_or_default()
            .iter()
            .fold(0u16, |mask, &rank| mask | (1 << rank));
        Self::Faces {
            sides: sides as u8,
            faces,
        }
    }

    pub fn degree(self) -> usize {
        match self {
            Self::Unresolved(n) => n,
            Self::Faces { faces, .. } => faces.count_ones() as usize,
        }
    }

    /// The canonical ranks of the open faces; empty when unresolved.
    pub fn faces(self) -> Vec<usize> {
        match self {
            Self::Unresolved(_) => Vec::new(),
            Self::Faces { faces, .. } => (0..16).filter(|&r| faces & (1 << r) != 0).collect(),
        }
    }

    fn key(self) -> String {
        match self {
            Self::Unresolved(n) => format!("junction_{n}"),
            Self::Faces { sides, .. } => {
                let faces: Vec<String> = self.faces().iter().map(|r| r.to_string()).collect();
                format!("junction_{sides}_{}", faces.join("-"))
            }
        }
    }

    fn from_key(rest: &str) -> Option<Self> {
        let Some((sides, faces)) = rest.split_once('_') else {
            let n: usize = rest.parse().ok()?;
            return (n >= 3).then_some(Self::Unresolved(n));
        };
        let sides: usize = sides.parse().ok()?;
        let ranks: Vec<usize> = faces
            .split('-')
            .map(|r| r.parse().ok())
            .collect::<Option<_>>()?;
        // Only the canonical spelling is a key: a rotated one would be a second name for a shape.
        let layout = Self::from_ranks(sides, &ranks);
        (matches!(layout, Self::Faces { .. }) && layout.key() == format!("junction_{rest}"))
            .then_some(layout)
    }
}

/// The shape of a node: dead end, a corridor (a pass through two neighbors) refined by its angle,
/// or a junction refined by the arrangement of its open faces. Rotations of one shape are the
/// same value; mirror images are different ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NodeShape {
    DeadEnd,
    Straight,
    Turn(TurnAngle),
    Junction(JunctionLayout),
}

impl NodeShape {
    /// Neighbor count of a node of this shape.
    pub fn degree(self) -> usize {
        match self {
            NodeShape::DeadEnd => 1,
            NodeShape::Straight | NodeShape::Turn(_) => 2,
            NodeShape::Junction(layout) => layout.degree(),
        }
    }

    fn angle(self) -> Option<u16> {
        match self {
            NodeShape::Straight => Some(STRAIGHT_ANGLE),
            NodeShape::Turn(angle) => Some(angle),
            NodeShape::DeadEnd | NodeShape::Junction(_) => None,
        }
    }

    /// The uniform similarity order, closest first: fewer edges to change, then — between two
    /// degree-2 shapes — the smaller angular difference.
    pub fn distance(self, other: NodeShape) -> (usize, u16) {
        let degrees = self.degree().abs_diff(other.degree());
        let angles = match (self.angle(), other.angle()) {
            (Some(a), Some(b)) => a.abs_diff(b),
            _ => 0,
        };
        (degrees, angles)
    }

    /// Stable string id: `dead_end`, `straight`, `turn_<degrees>`, `junction_<sides>_<faces>` (the
    /// canonical open faces joined by `-`, e.g. `junction_6_0-1-3`); `junction_<n>` for a junction
    /// whose faces are unresolved.
    pub fn key(self) -> String {
        match self {
            NodeShape::DeadEnd => "dead_end".to_string(),
            NodeShape::Straight => "straight".to_string(),
            NodeShape::Turn(angle) => format!("turn_{angle}"),
            NodeShape::Junction(layout) => layout.key(),
        }
    }

    pub fn from_key(key: &str) -> Option<NodeShape> {
        match key {
            "dead_end" => Some(NodeShape::DeadEnd),
            "straight" => Some(NodeShape::Straight),
            _ => {
                if let Some(angle) = key.strip_prefix("turn_") {
                    return angle.parse().ok().map(NodeShape::Turn);
                }
                JunctionLayout::from_key(key.strip_prefix("junction_")?).map(NodeShape::Junction)
            }
        }
    }
}

/// Cell type of a node: the shape template (`ShapeDescriptor::key`, e.g. `regular:4`) of its cell.
/// A tessellation with several cell types (the 4.8.8 square and octagon) has several; a cell
/// without a template is `UNTEMPLATED_CELL_TYPE`.
pub type CellType = String;

pub const UNTEMPLATED_CELL_TYPE: &str = "cell";

/// A node shape within one cell type: a square's turn and an octagon's turn are different limits.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TypedShape {
    pub cell_type: CellType,
    pub shape: NodeShape,
}

impl TypedShape {
    pub fn new(cell_type: impl Into<CellType>, shape: NodeShape) -> Self {
        Self {
            cell_type: cell_type.into(),
            shape,
        }
    }
}

pub fn cell_type_of<T: Tessellation>(tessellation: &T, cell: T::CellId) -> CellType {
    tessellation.shape_of(cell).map_or_else(
        || UNTEMPLATED_CELL_TYPE.to_string(),
        |shape| shape.descriptor().key().to_string(),
    )
}

fn turn_shape(angle: Option<f64>) -> NodeShape {
    NodeShape::Turn(angle.map_or(0, |a| a.round() as TurnAngle))
}

/// The shape of `node`: `classify_node`'s class refined by geometry — a turn by its angle, a
/// junction by the arrangement of its open faces. Neighbors are the node's bidirectional
/// `EdgeKind::Basic` neighbors, exactly as in `classify_node`.
pub fn classify_node_shape<T: Tessellation>(
    graph: &Graph,
    node: NodeId,
    field: &MultiLevelField<T>,
) -> NodeShape {
    let neighbors = shape_neighbors(graph, node);
    match classify_by_neighbors(node, &neighbors, field) {
        GeometricNodeClass::DeadEnd => NodeShape::DeadEnd,
        GeometricNodeClass::Straight => NodeShape::Straight,
        GeometricNodeClass::Turn => {
            turn_shape(field.pass_angle_degrees(neighbors[0], node, neighbors[1]))
        }
        GeometricNodeClass::Junction(n) => NodeShape::Junction(
            field
                .neighbor_face_ranks(node, &neighbors)
                .map_or(JunctionLayout::Unresolved(n), |(sides, ranks)| {
                    JunctionLayout::from_ranks(sides, &ranks)
                }),
        ),
    }
}

/// The shape of `node` together with its cell type.
pub fn classify_typed_shape<T: Tessellation>(
    graph: &Graph,
    node: NodeId,
    field: &MultiLevelField<T>,
) -> TypedShape {
    let cell_type = field.cell_of(node).map_or_else(
        || UNTEMPLATED_CELL_TYPE.to_string(),
        |cell| cell_type_of(field.tessellation(), cell),
    );
    TypedShape {
        cell_type,
        shape: classify_node_shape(graph, node, field),
    }
}

/// Every node of the field grouped by its typed shape; each list is sorted.
pub fn nodes_by_shape<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
) -> BTreeMap<TypedShape, Vec<NodeId>> {
    let mut by_shape: BTreeMap<TypedShape, Vec<NodeId>> = BTreeMap::new();
    for node in field.all_node_ids() {
        by_shape
            .entry(classify_typed_shape(graph, node, field))
            .or_default()
            .push(node);
    }
    by_shape
}

/// Every typed shape a node of this field can take — depends on the field only, never on the
/// graph. Junctions of a cell type are every arrangement (up to rotation) of three or more of the
/// faces any of its cells has inside the field.
pub fn possible_node_shapes<T: Tessellation>(field: &MultiLevelField<T>) -> BTreeSet<TypedShape> {
    let tessellation = field.tessellation();
    let mut shapes: BTreeSet<TypedShape> = BTreeSet::new();
    for level in field.levels_ordered() {
        let Some(level_field) = field.field_of(level) else {
            continue;
        };
        for cell in level_field.all_cells() {
            let cell_type = cell_type_of(tessellation, cell);
            let ranks = level_field.face_ranks(cell);
            let (faces, open_ranks): (Vec<T::Face>, Vec<usize>) = tessellation
                .faces_of(cell)
                .iter()
                .enumerate()
                .filter(|&(_, &face)| {
                    level_field
                        .neighbor_via(cell, face)
                        .is_some_and(|crossing| level_field.contains(crossing.cell))
                })
                .map(|(i, &face)| (face, ranks[i]))
                .unzip();
            shapes.insert(TypedShape::new(cell_type.clone(), NodeShape::DeadEnd));
            let center = tessellation.center(cell);
            for (i, &in_face) in faces.iter().enumerate() {
                for &out_face in &faces[i + 1..] {
                    if tessellation.is_straight(cell, in_face, out_face) {
                        shapes.insert(TypedShape::new(cell_type.clone(), NodeShape::Straight));
                        continue;
                    }
                    let a = tessellation.contact_point(cell, in_face) - center;
                    let b = tessellation.contact_point(cell, out_face) - center;
                    let angle = (a.length() > 0.0 && b.length() > 0.0).then(|| {
                        (a.dot(b) / (a.length() * b.length()))
                            .clamp(-1.0, 1.0)
                            .acos()
                            .to_degrees()
                    });
                    shapes.insert(TypedShape::new(cell_type.clone(), turn_shape(angle)));
                }
            }
            if open_ranks.len() > MAX_LAYOUT_SIDES {
                continue;
            }
            for subset in 1u32..(1 << open_ranks.len()) {
                if subset.count_ones() < 3 {
                    continue;
                }
                let chosen: Vec<usize> = (0..open_ranks.len())
                    .filter(|&i| subset & (1 << i) != 0)
                    .map(|i| open_ranks[i])
                    .collect();
                shapes.insert(TypedShape::new(
                    cell_type.clone(),
                    NodeShape::Junction(JunctionLayout::from_ranks(ranks.len(), &chosen)),
                ));
            }
        }
    }
    shapes
}

/// Inclusive bounds on a node count; a `None` bound is open. An exact count is `min == max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CountRange {
    min: Option<u32>,
    max: Option<u32>,
}

impl CountRange {
    /// `None` when both bounds are set and `min > max`.
    pub fn new(min: Option<u32>, max: Option<u32>) -> Option<Self> {
        match (min, max) {
            (Some(min), Some(max)) if min > max => None,
            _ => Some(Self { min, max }),
        }
    }

    pub fn exact(count: u32) -> Self {
        Self {
            min: Some(count),
            max: Some(count),
        }
    }

    pub fn min(&self) -> Option<u32> {
        self.min
    }

    pub fn max(&self) -> Option<u32> {
        self.max
    }
}

/// Count limits per typed shape. A shape without an entry is unconstrained.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NodeShapeLimits(BTreeMap<TypedShape, CountRange>);

impl NodeShapeLimits {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(
        mut self,
        cell_type: impl Into<CellType>,
        shape: NodeShape,
        range: CountRange,
    ) -> Self {
        self.0.insert(TypedShape::new(cell_type, shape), range);
        self
    }

    pub fn get(&self, shape: &TypedShape) -> CountRange {
        self.0.get(shape).copied().unwrap_or_default()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&TypedShape, CountRange)> + '_ {
        self.0.iter().map(|(shape, &range)| (shape, range))
    }

    pub fn is_empty(&self) -> bool {
        self.0.values().all(|r| r.min.is_none() && r.max.is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::EdgeKind;
    use crate::space::{
        HexPoint, HexTessellation, SquarePoint, SquareTessellation, hex_hexagon, square_rect,
    };
    use std::sync::Arc;

    fn square(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        (field, graph)
    }

    fn hex() -> (MultiLevelField<HexTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), hex_hexagon(2), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        (field, graph)
    }

    fn hex_node(field: &MultiLevelField<HexTessellation>, q: i32, r: i32) -> NodeId {
        field
            .node_at(field.single_level_id(), HexPoint { q, r })
            .unwrap()
    }

    #[test]
    fn square_pass_shapes_are_straight_and_turn_90() {
        let (field, mut graph) = square(3, 3);
        let at = |x, y| {
            field
                .node_at(field.single_level_id(), SquarePoint { x, y })
                .unwrap()
        };
        graph.add_bidirectional_edge(at(0, 1), at(1, 1), EdgeKind::Basic);
        graph.add_bidirectional_edge(at(1, 1), at(2, 1), EdgeKind::Basic);
        graph.add_bidirectional_edge(at(1, 0), at(0, 0), EdgeKind::Basic);
        graph.add_bidirectional_edge(at(1, 0), at(1, 1), EdgeKind::Basic);
        assert_eq!(
            classify_node_shape(&graph, at(1, 1), &field),
            junction(4, &[0, 1, 2])
        );
        assert_eq!(
            classify_node_shape(&graph, at(1, 0), &field),
            NodeShape::Turn(90)
        );
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        graph.add_bidirectional_edge(at(0, 1), at(1, 1), EdgeKind::Basic);
        graph.add_bidirectional_edge(at(1, 1), at(2, 1), EdgeKind::Basic);
        assert_eq!(
            classify_node_shape(&graph, at(1, 1), &field),
            NodeShape::Straight
        );
    }

    #[test]
    fn hex_distinguishes_sharp_and_soft_turns_and_ignores_rotation() {
        let (field, mut graph) = hex();
        let center = hex_node(&field, 0, 0);
        // Neighbors of the origin in face order E, NE, NW, W, SW, SE.
        let ring = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)];
        let at = |i: usize| hex_node(&field, ring[i % 6].0, ring[i % 6].1);
        // Adjacent faces: sharp turn; faces two apart: soft turn; opposite faces: straight.
        graph.add_bidirectional_edge(center, at(0), EdgeKind::Basic);
        graph.add_bidirectional_edge(center, at(1), EdgeKind::Basic);
        assert_eq!(
            classify_node_shape(&graph, center, &field),
            NodeShape::Turn(60)
        );
        let mut rotated = Graph::new();
        for node in field.all_node_ids() {
            rotated.add_node(node);
        }
        rotated.add_bidirectional_edge(center, at(2), EdgeKind::Basic);
        rotated.add_bidirectional_edge(center, at(3), EdgeKind::Basic);
        assert_eq!(
            classify_node_shape(&rotated, center, &field),
            NodeShape::Turn(60),
            "a rotated sharp turn is the same shape"
        );
        let mut soft = Graph::new();
        for node in field.all_node_ids() {
            soft.add_node(node);
        }
        soft.add_bidirectional_edge(center, at(0), EdgeKind::Basic);
        soft.add_bidirectional_edge(center, at(2), EdgeKind::Basic);
        assert_eq!(
            classify_node_shape(&soft, center, &field),
            NodeShape::Turn(120)
        );
        let mut straight = Graph::new();
        for node in field.all_node_ids() {
            straight.add_node(node);
        }
        straight.add_bidirectional_edge(center, at(0), EdgeKind::Basic);
        straight.add_bidirectional_edge(center, at(3), EdgeKind::Basic);
        assert_eq!(
            classify_node_shape(&straight, center, &field),
            NodeShape::Straight
        );
    }

    #[test]
    fn one_way_edges_do_not_count_as_shape_neighbors() {
        let (field, mut graph) = square(3, 1);
        let level = field.single_level_id();
        let at = |x| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        graph.add_bidirectional_edge(at(0), at(1), EdgeKind::Basic);
        graph.add_edge(at(1), at(2), EdgeKind::Basic);
        assert_eq!(
            classify_node_shape(&graph, at(1), &field),
            NodeShape::DeadEnd
        );
    }

    fn junction(sides: usize, faces: &[usize]) -> NodeShape {
        NodeShape::Junction(JunctionLayout::from_ranks(sides, faces))
    }

    fn typed(cell_type: &str, shapes: &[NodeShape]) -> BTreeSet<TypedShape> {
        shapes
            .iter()
            .map(|&shape| TypedShape::new(cell_type, shape))
            .collect()
    }

    #[test]
    fn possible_shapes_follow_the_tessellation() {
        let (square_field, _) = square(3, 3);
        assert_eq!(
            possible_node_shapes(&square_field),
            typed(
                "regular:4",
                &[
                    NodeShape::DeadEnd,
                    NodeShape::Straight,
                    NodeShape::Turn(90),
                    junction(4, &[0, 1, 2]),
                    junction(4, &[0, 1, 2, 3]),
                ]
            )
        );
        let (hex_field, _) = hex();
        assert_eq!(
            possible_node_shapes(&hex_field),
            typed(
                "regular:6",
                &[
                    NodeShape::DeadEnd,
                    NodeShape::Straight,
                    NodeShape::Turn(60),
                    NodeShape::Turn(120),
                    // Three faces: consecutive, 1-2 gap, 2-1 gap (the mirror image), alternating.
                    junction(6, &[0, 1, 2]),
                    junction(6, &[0, 1, 3]),
                    junction(6, &[0, 2, 3]),
                    junction(6, &[0, 2, 4]),
                    junction(6, &[0, 1, 2, 3]),
                    junction(6, &[0, 1, 2, 4]),
                    junction(6, &[0, 1, 3, 4]),
                    junction(6, &[0, 1, 2, 3, 4]),
                    junction(6, &[0, 1, 2, 3, 4, 5]),
                ]
            )
        );
    }

    #[test]
    fn hex_junctions_follow_the_arrangement_of_the_faces_up_to_rotation() {
        let (field, _) = hex();
        let center = hex_node(&field, 0, 0);
        // Neighbors of the origin in cyclic face order E, NE, NW, W, SW, SE.
        let ring = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)];
        let at = |i: usize| hex_node(&field, ring[i % 6].0, ring[i % 6].1);
        let shape_of = |faces: [usize; 3]| {
            let mut graph = Graph::new();
            for node in field.all_node_ids() {
                graph.add_node(node);
            }
            for face in faces {
                graph.add_bidirectional_edge(center, at(face), EdgeKind::Basic);
            }
            classify_node_shape(&graph, center, &field)
        };
        assert_eq!(shape_of([0, 1, 2]), junction(6, &[0, 1, 2]));
        assert_eq!(
            shape_of([2, 3, 4]),
            junction(6, &[0, 1, 2]),
            "a rotated arrangement is the same shape"
        );
        assert_eq!(shape_of([1, 3, 5]), junction(6, &[0, 2, 4]));
        // Gaps 1-2-3 and 1-3-2 around the cell are mirror images of each other.
        let (a, b) = (shape_of([1, 2, 4]), shape_of([1, 2, 5]));
        assert_ne!(a, b, "mirror images are different shapes");
        assert_eq!(
            BTreeSet::from([a, b]),
            BTreeSet::from([junction(6, &[0, 1, 3]), junction(6, &[0, 2, 3])])
        );
        assert_eq!(
            shape_of([0, 1, 3]),
            shape_of([3, 4, 0]),
            "rotation keeps the shape"
        );
    }

    #[test]
    fn key_round_trips() {
        for shape in [
            NodeShape::DeadEnd,
            NodeShape::Straight,
            NodeShape::Turn(60),
            junction(6, &[0, 1, 3]),
            junction(4, &[0, 1, 2, 3]),
            NodeShape::Junction(JunctionLayout::Unresolved(5)),
        ] {
            assert_eq!(NodeShape::from_key(&shape.key()), Some(shape));
        }
        assert_eq!(junction(6, &[0, 1, 3]).key(), "junction_6_0-1-3");
        assert_eq!(NodeShape::from_key("junction_2"), None);
        assert_eq!(
            NodeShape::from_key("junction_6_1-2-3"),
            None,
            "only the canonical rotation is a key"
        );
        assert_eq!(NodeShape::from_key("junction_6_0-1"), None);
        assert_eq!(NodeShape::from_key("turn_x"), None);
        assert_eq!(NodeShape::from_key("nope"), None);
    }

    #[test]
    fn distance_orders_by_edges_to_change_then_angle() {
        let turn90 = NodeShape::Turn(90);
        let three = junction(6, &[0, 1, 2]);
        let four = junction(6, &[0, 1, 2, 3]);
        assert!(turn90.distance(NodeShape::Turn(120)) < turn90.distance(NodeShape::Straight));
        assert!(turn90.distance(NodeShape::Straight) < turn90.distance(NodeShape::DeadEnd));
        assert!(turn90.distance(NodeShape::DeadEnd) == turn90.distance(three));
        assert!(turn90.distance(three) < turn90.distance(four));
    }

    #[test]
    fn count_range_rejects_min_above_max() {
        assert!(CountRange::new(Some(3), Some(2)).is_none());
        assert_eq!(
            CountRange::new(Some(2), Some(2)),
            Some(CountRange::exact(2))
        );
        assert!(CountRange::new(None, Some(0)).is_some());
    }
}
