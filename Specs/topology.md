# Topology: folds and fold groups

Data model and structural validation of per-floor topology (GitHub issue #831, part of the topology epic). A **fold** glues one face of a cell to one face of another cell (or of the same cell), turning a flat field into a cylinder, torus or twisted surface. This layer is pure data plus validation; structural validation knows nothing about the field's cell set. Activity and neighbor lookup against a field are described below (GitHub issue #832); rendering is out of scope.

Module: `maze-core/src/space/topology.rs`.

## Model

```rust
pub struct FoldEnd<C> { pub cell: C, pub face_idx: usize }   // face_idx = position in faces_of(cell)
pub struct Fold<C>    { pub a: FoldEnd<C>, pub b: FoldEnd<C>, pub twist: bool, pub group: FoldGroupId }
pub struct FoldGroup  { pub id: FoldGroupId, pub folds: Vec<FoldId> }
pub struct Topology<T: Tessellation> { /* fingerprint, folds, groups, (cell, face_idx) index */ }
```

- A `Topology` describes one floor. Storing one per `LevelId` is left to the future owner of per-floor data (no map exists in this layer yet).
- `Topology<T>` implements `Clone`/`Debug` manually, so `T` itself needs neither (only `T::CellId` is stored).
- `FoldId` is the index of the fold in `Topology::folds()`. `FoldGroupId` is unique within one topology.
- `fold_of(cell, face_idx) -> Option<(&Fold, FoldSide)>` returns the fold gluing that face and which side (`A`/`B`) the face is on.
- `twist` is part of the model: it fixes the endpoint correspondence of the glued boundary pieces (reversed versus default), so it affects topology semantics, not only rendering.
- **Groups are the editable unit.** Operations address whole groups. Folds are never regrouped heuristically from geometry.
- A topology without folds changes nothing: with no folds all existing behaviour is unchanged.

## Fingerprint

A topology stores a `TessellationFingerprint`: a canonical string of the tessellation config (kind + params). `face_idx` is stable only within one config, so `validate` first compares the stored fingerprint with the current one and fails with `FingerprintMismatch` when they differ. Producing the canonical string is the factory's job (`maze-wasm` / `maze-runner`), core only compares.

## Two-level validation

1. **Structural (this module, `Topology::validate`)** — independent of the field, over **all** stored folds including inactive ones (folds whose cells are not in the field). Checks, returning the first violation in fold order:
   - fingerprint matches;
   - both ends: the cell is valid for the tessellation (`is_valid_cell`) and `face_idx < faces_of(cell).len()`;
   - no fold glues a face to itself (`a == b`); two different faces of one cell may be glued together;
   - a face belongs to at most one fold (across both sides of all folds);
   - every fold belongs to exactly one group: its `group` exists, that group lists it, and no group (including that one) lists it more than once; groups reference existing folds; group ids are unique.

   Every `TopologyError` variant names the offending fold (or group), and `Display` carries the reason.
2. **Field-dependent (GitHub issue #832, `Field::set_topology`)** — activity of each fold relative to the field, see below. Connectivity stays a later concern.

## Activity

`Field::set_topology(topology, &fingerprint)` validates structurally, then resolves every fold against the field's cell set (`Field::fold_activity()`, indexed by `FoldId`). The field's cell set is fixed at construction, so there is no other change to react to; resolution is a pure function of topology and cell set. A fold is `Active` or `Inactive(reason)`; checked in this order, folds considered in fold order:

- `MissingCell` — an end cell is not in the field.
- `InteriorNeighbor` — a glued face has an ordinary in-field tessellation neighbour; the fold must not silently override it. A face with no neighbour, or whose neighbour is outside the field, may be glued.
- `DuplicateNeighbor` — gluing would make a cell neighbour the same cell twice among the ordinary in-field neighbours and the folds accepted before it (the v1 constraint below).

Inactive folds are ignored by adjacency.

## Effective adjacency

`Field::neighbor_via(cell, face) -> Option<Crossing { cell, face, orientation }>` (and `MultiLevelField::neighbor_via(level, cell, face)`) is the adjacency every maze algorithm uses: an active fold glued at `(cell, face)` wins, otherwise `Tessellation::neighbor`. It is not filtered by field membership. Without active folds it equals `Tessellation::neighbor` with an unflipped orientation. `Field::neighbors`, `Field::is_straight`, `Field::face_index_toward` and the split-pattern logic, split QC and repair go through it. Gluing is reciprocal: crossing a fold and then the returned face leads back, also for twisted folds.

`Tessellation::neighbor` stays the base adjacency (geometry, `field_ops`, tessellation implementations). A guard test (`maze-core/tests/neighbor_guard_test.rs`) forbids direct `.neighbor(` calls outside `space/` and the runner's geometry snapshot.

## Crossing orientation

`Orientation { flips, entry }` separates chirality change from direction correspondence. `flips` is `false` for ordinary neighbours and untwisted folds, `true` for a twisted fold (`Fold::twist`). `entry` is the face the crossing leaves through. Contract: with equal face counts, the face at circular offset `k` from the entry face maps to the face at offset `-k` from the exit face (`flips == false`, the ordinary mirror across a shared side) or `+k` (`flips == true`). `Crossing::transfer(tessellation, from, face)` applies it and returns `None` when the face counts differ. Adapting algorithms to use `transfer` is deferred; the contract is fixed.

## v1 constraint

A cell has **at most one face toward a given neighbour** (`Specs/space.md`, "Topology contract"; `Field::neighbors` relies on it). Folds must not break it in v1: gluing must not make a cell neighbour the same cell through two faces. Structural validation does not check it; activity resolution does (`DuplicateNeighbor`).
