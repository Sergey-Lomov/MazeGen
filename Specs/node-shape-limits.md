# Node Shape Limits (GitHub issue #1008)

Quality-control check and issue kind that keep the number of nodes of each **shape** within
configured limits. Use case: assembling a maze from a constructor's fixed set of pieces. The
repair strategy that acts on the issue is a separate task; this spec covers the shape vocabulary,
the limits structure, the check, the issue and its wiring (payload, debug tape, runner, wasm, UI).

Scope is ordinary two-way passages only. One-way edges, teleports, vertical transitions, elevators
and split patterns do not take part, and shapes are not distinguished finer than described below.

## Node shape (`NodeShape`, `maze-core/src/graph/node_shape.rs`)

A node's shape refines `GeometricNodeClass` (`graph-analytics.md`, `classify_node`). The neighbor
notion is identical — bidirectional `EdgeKind::Basic` neighbors only — so the degree of every shape
agrees with the analytics for every node. Two refinements: `Turn` is split by its angle and
`Junction` by the arrangement of its open faces. The statistics keep the coarse
`GeometricNodeClass`; they do not use `NodeShape`.

```rust
pub enum NodeShape {
    DeadEnd,
    Straight,
    Turn(TurnAngle),          // interior angle in whole degrees, 0 < angle < 180
    Junction(JunctionLayout), // n >= 3 neighbors
}
pub enum JunctionLayout {
    Unresolved(usize),                   // only the degree is known
    Faces { sides: u8, faces: u16 },     // canonical open faces, a bit mask of ranks
}
```

### Junction layouts

A junction is told apart by which faces of its cell are open, up to rotation (not reflection). Faces
are ordered by their angular rank around the cell center (`Field::face_ranks`: the direction of
`contact_point - center`, counterclockwise from +x); the open ranks, rotated so that the
lexicographically smallest rank list results (it always starts at `0`), are the layout. A hexagon
therefore has four three-way junctions — `0-1-2`, `0-1-3`, `0-2-3` (the mirror image of `0-1-3`) and
`0-2-4` — and three four-way ones; a square has one three-way and one four-way. Layouts need at most
16 faces per cell (`MAX_LAYOUT_SIDES`). `Unresolved(n)` is the fallback when the faces cannot be
resolved (a split cell, a neighbor on another level); it is never one of `possible_node_shapes`.

## Availability

The rule is not offered on tessellations with irregular cells (`Tessellation::cells_vary_in_size`:
Voronoi, radial rings) — they have no fixed set of shapes — nor on tessellations with a cell of more
than 8 sides (a dodecagon alone has 351 junction shapes). This is a product limit, not a technical
one, expressed through the general check availability mechanic (`Specs/quality-feature.md`,
"Check availability"): the `node_shape_limits` descriptor declares
`requires: [RegularCells, MaxCellSides { max: 8 }]` (`maze-wasm/src/checks_catalog.rs`). In the
selection dialogs the rule stays listed, disabled, with a tooltip naming the failing requirement (two
different texts: irregular cells / cells above 8 sides); a rule already holding the check keeps it, flagged
`cannot_apply` (delete-only problem), when a tessellation change makes it unavailable
(`quality-feature.md`, "Rule problems").

`TurnAngle` is the angle at the cell's center between the contact points of the two passage faces
(`TessellationGeometry::contact_point`, `Tessellation::center`), rounded to whole degrees. The
angle is a property of the pass `from -> via -> to` through `via`'s cell
(`Field::pass_angle_degrees`), computed like `Field::is_straight`. It makes the vocabulary
tessellation-specific without any per-tessellation table:

| Tessellation | Shapes of degree 2 |
|---|---|
| Square, Brick, Curved quadrilateral | `Straight`, `Turn(90)` |
| Hex | `Straight`, `Turn(60)` (sharp), `Turn(120)` (soft) |
| Mixed (triangle + square + hexagon, ...) | `Straight` where some cell allows it, plus every angle some cell produces |

Rotations and mirror images are the same shape: on a hexagon a turn through faces 1-2 and a turn
through faces 2-3 are both `Turn(60)`. If the angle of a non-straight pass cannot be resolved,
the shape is `Turn(0)` ("unknown angle"); it never occurs for a pass between two tessellation
neighbors of one level.

`NodeShape::key()` is the stable string id used by limits and the wire (`dead_end`, `straight`,
`turn_<degrees>`, `junction_<sides>_<ranks>` such as `junction_6_0-1-3`, `junction_<n>` for an
unresolved junction); `NodeShape::from_key` is its inverse and accepts only the canonical rotation.

### Possible shapes (`possible_node_shapes`)

`possible_node_shapes(&MultiLevelField) -> BTreeSet<NodeShape>` lists every shape a node of this
field can take: `DeadEnd`; for every cell and every pair of its faces that have a neighbor
(`Field::neighbor_via`) the pass shape (`Straight` or `Turn(angle)`); every junction
layout of three or more of the faces a cell of that type has inside the field. It is
the vocabulary the UI offers for limits and the reference for "unreachable limit" decisions. It
depends on the field only, never on the graph.

### Cell types (`TypedShape`)

A tessellation can mix cell types (the 4.8.8 square and octagon), and the same shape of different
cell types is a different piece: a square's `Turn(90)` and an octagon's `Turn(135)` are limited
independently, and the same key in two cell types too. The cell type of a node is the shape template
key of its cell (`ShapeDescriptor::key`, e.g. `regular:4`, `regular:8`; `cell` for a cell without a
template). `TypedShape { cell_type, shape }` is the unit every limit, count and violation is keyed by:

- `nodes_by_shape` groups the nodes of the field by `TypedShape`;
- `possible_node_shapes(&MultiLevelField) -> BTreeSet<TypedShape>` is computed per cell type: `DeadEnd`,
  the pass shapes of that type's cells, and every junction layout of three or more of the in-field faces of any cell
  of that type.

Irregular tessellations (cells without a regular shape template) are not handled specially yet; they
fall back to the `cell` type.

## Limits (`NodeShapeLimits`)

```rust
pub struct CountRange { pub min: Option<u32>, pub max: Option<u32> }   // min <= max when both set
pub struct NodeShapeLimits(BTreeMap<TypedShape, CountRange>);
```

Limits are tied to the tessellation's cell types, so changing the tessellation resets them (see the
web wiring below).

- An exact count is `min == max`. A shape with no entry, or an entry with both bounds `None`, is
  unconstrained.
- `CountRange::new(min, max)` rejects `min > max`.
- Limits count nodes over the whole maze (every floor). A per-floor scope is not part of this
  version.

## Check `node_shape_limits` (`NodeShapeLimitsCheck`)

Params: `limits: NodeShapeLimits`. Emits one `ViolatedNodeShapeLimitsIssue` when at least one limited
shape is out of range, otherwise nothing.

1. Count the nodes of every typed shape (`classify_typed_shape`) over all floors.
2. A shape with `count > max` is an **excess** of `count - max`. A shape with `count < min` is a
   **deficit** of `min - count`.
3. A limit on a shape that is not in `possible_node_shapes` can never be met by any repair: such a
   limit is skipped (no deficit is reported for it; a `max` on it is trivially satisfied). The
   check never reports a violation the strategy cannot possibly fix by changing connections.

## Issue `ViolatedNodeShapeLimits` (`ViolatedNodeShapeLimitsIssue`)

A new `IssueKind` (`violated_node_shape_limits`), a semantic category: "the shape mix violates the
configured limits". It carries the violation, so a strategy needs no recount:

```rust
pub struct ShapeLimitViolation {
    pub shape: TypedShape,
    pub kind: LimitViolationKind,       // Excess | Deficit
    pub amount: u32,               // how many nodes must leave (Excess) or join (Deficit) this shape
    pub nodes: Vec<NodeId>,        // current nodes of `shape`, sorted
    pub counterparts: Vec<NodeShape>,
}
```

`counterparts` answers "what can it be replaced with / where can nodes come from":

- **Excess**: shapes a node of `shape` may be turned into — every shape of the same cell type in
  `possible_node_shapes` other than `shape` that still has room (`count < max`, or no `max`).
- **Deficit**: shapes whose nodes may be turned into `shape` — every other shape of the same cell type
  (a node cannot change its cell) that has a surplus
  over its own `min` (`count > min`, an unset `min` counting as 0) and is not itself in deficit.

Both lists are ordered by one uniform similarity order, closest first (`NodeShape::distance`):

1. fewer edges to change first — the absolute difference of the shapes' neighbor counts
   (`DeadEnd` = 1, `Straight`/`Turn` = 2, a junction = its number of open faces);
2. then, for two degree-2 shapes, the angular difference (`Straight` = 180°);
3. then the shape order (`Ord`), for determinism.

A shape never lists itself. The list may be empty — then no replacement exists, and the strategy
reports the limits unsatisfiable.

`IssueMerge`: violations of the same `(shape, kind)` are unified — larger `amount`, union of
`nodes`, `counterparts` re-derived by the producing check (the merged list keeps the first
occurrence order and drops duplicates). Different checks flagging different shapes append.

## Wiring

- **Payload** (`issue_payload`): the flat `IssuePayload::ViolatedNodeShapeLimits { violations:
  Vec<IssueShapeLimitViolationPayload> }` - not keyed by source check, because one check produces the issue
  and merging already unified the per-shape entries. `IssueShapeLimitViolationPayload { cell_type, shape, kind, amount,
  nodes, counterparts }` carries the cell type key and `NodeShape::key()` strings (`shape`, `counterparts`, closest first),
  `LimitViolationKind` and base-graph node ids. Mirrored by `IssuePayloadDto::ViolatedNodeShapeLimits`
  (`kind` is `"excess" | "deficit"`) and canonicalized by `maze-runner`'s `canonical.rs`.
- **Debug tape**: QC event wire tag `18` (`write_issue_payload` / `readIssuePayload`): per violation the
  cell type string, the shape string, a kind byte (0 excess, 1 deficit), `amount: u32`, a counted node list and a counted list of
  strings. The debug tree highlights all nodes of all violations as singleton cells.
- **Runner**: `qc_kind_registry!` maps `node_shape_limits` to `ViolatedNodeShapeLimits`
  (`build_violated_node_shape_limits_check`); the `limits` param is a JSON object keyed by
  cell type, then by `NodeShape::key()`, with `{"min", "max"}` values (`null` or absent = unbounded), parsed by
  `parse_node_shape_limits_param` (unknown keys, inverted ranges and malformed JSON are dropped).
- **Wasm**: `CheckDescriptor` `node_shape_limits` with the `ParamKindDto::NodeShapeLimits` param
  `limits`; the export `tessellation_node_shapes(tessellation)` returns, per cell type,
  `{ cell_type, example_cell, face_ranks, shapes }`: the shape keys the tessellation can produce for it,
  a fully surrounded sample cell of that type for the icons, and the angular rank of each of its faces
  (what a junction key's face numbers refer to) (`runner::node_shapes`: `possible_node_shapes` over
  a sample field around the origin for the shape vocabulary, each type drawn on the tessellation's own sample cell,
  `Tessellation::sample_cells`; a tessellation without sample cells, i.e. an irregular one, yields none).
- **Web**: `NodeShapeLimitsEditor` (opened from the param row of `ParamFields`) edits the JSON value -
  one row per shape of the tessellation (always all of them); a tessellation with several cell types
  shows a tab per cell type at the top, so every shape of every type has its own limit (a single type
  has no tab bar). Each row has a tile icon
  (`NodeShapeIcon`: the type's example cell as it looks in a maze, walls on every face except the shape's own,
  drawn by the maze's wall pipeline over a mini maze from `pixi/nodeShapeTile`), an optional min and max (`NumberInput` with `allowEmpty`,
  0..9999, so rejected input is explained by its hint); an empty bound is no limit, and rows with neither bound are not serialized.
  `nodeShapeLabel` names a shape key, `nodeShapeCellTypeLabel` a cell type. A junction with a known layout is
  named by what tells it apart within its cell type (`siblings` = the type's shape keys): the degree alone
  ("Junction of 3") when it is the only junction of that degree, the faces in the name ("Junction 1-2-4", which already
  imply the degree) when several share it; without `siblings` both are shown. Keys count faces from 0 (`0-1-3`), labels from 1. All rows of a cell type sit in one
  grid, so the Min and Max inputs align across rows whatever the name lengths. The icons are drawn on one shared
  WebGL context (`pixi/sharedOffscreenRenderer`: renders are queued, each is copied into a plain 2D canvas), not
  one `Application` per row, so a long list stays under the browser's context limit; a lost WebGL context drops the
  shared application and the next render builds a fresh one. A shape key is parsed in one place (`pixi/nodeShapeKey`,
  `parseNodeShapeKey`), shared by the labels and the icon tiles. The rule is named "Shape limits"
  (ru "Лимиты форм"). The limits are tessellation-sensitive: `qcForTessellation` resets the `limits` param
  to none when the tessellation changes and flags the check `limits_reset` (`needs_reconfiguration`, cleared by editing the limits). Irregular tessellations need their own handling later. The issue is listed under "General rules" in the add-rules dialog;
  its bubble highlights the nodes of all violations.
  The check records two details for the bubble: `shapes` (comma-separated violated `cell_type/shape_key`, shown in the
  title) and `violations` (`;`-separated `cell_type/shape_key:excess|deficit:count:limit`, where `limit` is the crossed
  bound); the cell type is named in the labels only when several are involved; shape names follow the editor's rule above,
  the vocabulary coming from `features/nodeShapeSiblings` (a registry `nodeShapeVocabulary` fills with the applied
  tessellation's shapes, so `issueRegistry` and the store do not import each other; unregistered = full labels); the description lists one bullet per entry, e.g. "Dead end: count 7, above the allowed 5".
  The limits dialog (`NodeShapeLimitsDialog`) edits a draft: the confirm button applies it, closing cancels.
  Analytics also exposes an on-demand “Cell shape statistics” dialog (GitHub issue #1085). It counts
  the currently displayed graph with the same core `nodes_by_shape` classifier as this check, then
  groups each `TypedShape` count by cell type and shape. The request runs only when the dialog is
  opened; it is not added to generation or the ordinary analytics snapshot.

## Repair strategy (`NodeShapeRebalanceStrategy`, GitHub issue #1025)

Handles `VIOLATED_NODE_SHAPE_LIMITS`; id `node_shape_rebalance`, no parameters. The issue carries `limits` (every enforced limit, not only the violated ones; `NodeShapeLimits::tighten` merges two issues: larger min, smaller max), so one move is judged against all limits at once. Without limits the strategy fails.

- **Score**: `sum of shortfalls` over all limits (excess above a max plus deficit below a min). A move is accepted only if it strictly lowers the score, so the strategy itself cannot oscillate; among equal scores fewer flips win.
- **Move**: an all-or-nothing set of passage flips (open a wall between two adjacent nodes, or close a passage). Walls blocked by the preset state are never opened; preset edges are never closed.
- **Connectivity invariant**: every strongly connected component of the maze before the move stays whole (merging is allowed), so a move never splits the maze. The check runs on the best candidates only, in score order; up to 128 improving candidates are kept (deduplicated: the same move found from either end counts once), because in a tree-like maze the best-scoring ones are often pure closings that all split it.
- **Phase 1, local**: combinations of at most 2 passages incident to pivot nodes (excess: the violation's nodes; deficit: nodes of the counterpart shapes). **Phase 2, region**: flip combinations inside a connected region around a pivot, at growing sizes. Both are bounded by evaluation budgets and bail out on the cooperative deadline (`crate::deadline::expired()`, `Specs/repair.md`).
- **One apply, several moves**: the first valid candidate is joined by further candidates that touch other nodes, lower the score again and keep connectivity together with it (at most 64 extra connectivity checks), so a large excess costs few repair iterations instead of one per node. The set is still strictly score-lowering, so it cannot oscillate.
- **Unsatisfiable limits**: per cell type, the strategy fails at once when the mins need more nodes than the cell type has (shapes impossible for the cell type skipped), or when every shape its nodes can take is capped and the caps hold fewer nodes than it has.
- A set of several flips is returned as one `MutationCommand::Atomic` (`Specs/repair.md`).
- Not considered: other rules' limits (e.g. a new loop opened by a flip) — those rules fire on the next iteration and repair it with their own strategies.

## Open points (not in this version)

- Generator integration: the generator does not yet respect the limits; only repair does.
- Per-floor limits.
- A field-aware vocabulary: the editor offers the shapes of the tessellation's sample field, not of the user's actual field.
