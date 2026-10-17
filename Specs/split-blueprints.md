# Split-Node Blueprints

Split-node blueprints (GitHub issue #235) are built-in, predefined multi-node configurations a
user can apply to a split point instead of building one by hand, face by face, in the split-node
editor. Offered in three places: post-edit's `ManageSplitNodesDialog`, the preset stage's
`PresetSplitNodesDialog`, and — converted into a `SplitPattern` — `SplitSettingsDialog`'s
generation-time pattern list.

Deliberately distinct from `SplitPattern` (`Specs/split-patterns.md`): a pattern is a
generation-time construct, weighted and applied by the wasm generator during `CustomVertexBased`.
A blueprint is a plain client-side template — applying it directly rewrites the current point's
nodes/edges (post-edit/preset) or is converted once into a fresh `SplitPattern` (generation
settings); it is never itself sent to wasm and never stored in the project file.

## Wire type (`maze-web/src/pixi/splitBlueprints.ts`, TS-only — no Rust/wasm counterpart)

- **`SplitNodeBlueprint`** — `{ id, degree, nodeFaces }`. `id` is unique only within its own
  degree's list — used as a React `key`, nothing else; no label is shown anywhere, the preview
  thumbnail itself is the only UI for picking a blueprint. `degree` is the tile degree
  (`getNeighborData(cfg, x, y).offsets.length`) the blueprint applies to. `nodeFaces[i]` is a list
  of 0-indexed face offsets that minted node `i` (node `0` is always the point's pre-existing
  original node, same convention as `SplitPattern`) gets a `Passage` on — every other face of the
  tile is implicitly `Wall`.

## Built-in registry (`BLUEPRINTS_BY_DEGREE`)

Filtered by tile degree, **not** by tessellation `type` — two different tessellations sharing the
same tile shape (e.g. a future tessellation with square cells) reuse the same blueprint set
without duplication. Currently defined:

- **Degree 3 (triangle)** — 1 blueprint: a cross-through pair (two nodes, each connecting the
  original node's two non-shared faces to one shared face).
- **Degree 4 (square)** — 2 blueprints: opposite pairs (N/S vs E/W) and adjacent pairs.
- **Degree 6 (hex)** — 7 blueprints: opposite pairs, skip pairs, two "wide pair + far pair"
  variants, three-opposite-pairs, opposite-pair-plus-two-skip-pairs, and a diagonal divider whose
  two nodes own opposite groups of three adjacent faces.

`blueprintsForDegree(degree)` returns the list for a degree, or `[]` if none are defined.

## Rotation (`rotateBlueprint`, `fittingRotation`)

A point at the field's boundary has some faces with no neighbor at all — a blueprint whose
required faces land there can't be applied as authored. Rather than a manual rotate control, every
caller tries every rotation automatically:

- **`rotateBlueprint(blueprint, offset)`** shifts every face index by `offset` steps (mod
  `degree`) around the tile's faces.
- **`fittingRotation(blueprint, isBoundary)`** tries every rotation `0..degree-1` and returns the
  first one whose required faces all avoid the boundary, or `null` if none do (e.g. a blueprint
  whose nodes together require every face of the tile can never fit a boundary point, since
  rotating doesn't shrink the set of faces used — only relabels which node owns which).

A blueprint with no fitting rotation is offered disabled in the UI, with an explanatory hint.

## Applying to a split point — full replace

Both `applySplitBlueprint` (post-edit, `postEditSlice.ts`) and `applyPresetSplitBlueprint` (preset
stage, `presetConnectionsSlice.ts`) apply a blueprint as a **full replace** of the point's current
state, not an overlay:

1. Every node currently at the point — the original node plus every declared slot — has its
   split-face connections rebuilt. Vertex elements are preserved: the original node remains
   Node 0, existing slots are matched to the resulting blueprint nodes in slot order, and an
   element whose old slot is dropped is retargeted to Node 0. This applies to start/finish/
   gen-source markers, teleports, vertical passages, elevators, and locks; no occupied-cell guard
   rejects the template operation.
2. One fresh slot is minted per blueprint node beyond the first (`blueprint.nodeFaces.length - 1`
   slots total).
3. For every node, every declared face gets a `Passage` to its in-field neighbor; a face pointing
   outside the field is silently skipped (no connection can exist there). The neighbor is resolved
   to whichever of its nodes actually has a decided connection back toward this point already
   (`resolvePresetPartnerAt`/`resolvePostEditPartnerAt`, GitHub issue #243) — **not** the neighbor's
   currently active UI slot: if the neighbor is itself split, picking "the" active node regardless
   of which of its nodes really connects here would silently wire the passage to the wrong node
   while leaving the neighbor's real connecting node's entry orphaned. Falls back to the active
   slot only when the neighbor has no decided entry on this face yet. In the preset stage, every
   other node of an already-split neighbor (every one that isn't the resolved partner) also gets an
   explicit `wall` on this same face, unless it already has its own decided entry — otherwise that
   node's side of the face would silently stay `undefined` instead of reading as forbidden.
4. Every other face of the tile — one not in the blueprint's `nodeFaces[i]` list — is left with no
   explicit decision in post-edit (already reads as `Wall` by default, see `postEditUtils.ts`'s
   `tileFaceKindOf`-equivalent convention) but gets an **explicit** `wall` entry in the preset
   stage, since presets default to `undefined` (optional) rather than `wall` — leaving it absent
   would read as "undecided" instead of "forbidden by this blueprint."

Both actions bound their face loop by `min(blueprint.degree, offsets.length)` (the tile's real
degree), not `blueprint.degree` alone — defensive against a blueprint authored for a different
degree being passed directly (the normal UI flow always picks one via `blueprintsForDegree`, so
this only matters for a direct/programmatic call).

## Generation-time pattern conversion (`blueprintToSplitPattern`)

`SplitSettingsDialog`'s pattern list offers the same built-in blueprints as a one-click "add a
standard pattern" shortcut, converting a blueprint into a fresh `SplitPattern` and appending it —
no editor opens, matching `handleAddPattern`'s own instant-add behavior for a blank pattern. No
boundary/rotation concept applies here: a pattern isn't tied to any specific field point. For a
blueprint, conversion is direct and unrotated: face indices follow core's `faces_of` order, the
same order the generator reads. Every declared face becomes a
`Passage` requirement; every other face is simply absent from `faces[i]` (core already treats "no
entry" as `Wall`). `weight` is always `1.0`, matching a freshly added blank pattern's default.

## UI

- **`ManageSplitNodesDialog`/`PresetSplitNodesDialog`** (via `SplitNodesDialogView`): a
  horizontally scrolling strip of small preview thumbnails above the tile diagram, one per fitting
  blueprint (`tileNodesForBlueprint` builds the same `TileFaceEditor`/`TileFaceNode[]` shape used
  everywhere else a tile preview is drawn). The preview's anchor point is the dialog's own `point`,
  not a fixed `[0,0]` — a triangle tile's shape (up vs down) depends on `(x+y) % 2`
  (`getNeighborData`), so a fixed anchor could render the preview in the opposite orientation from
  the point the blueprint will actually apply to. Clicking a thumbnail opens a confirm modal (full
  replace is destructive) before calling `applySplitBlueprint`/`applyPresetSplitBlueprint`. A
  blueprint with no fitting rotation renders disabled, with a shared hint below the strip
  explaining why.
- **`SplitSettingsDialog`**: the same strip style below the pattern list, labeled "add a standard
  pattern" — clicking a thumbnail calls `blueprintToSplitPattern` and appends the result directly,
  no confirmation (adding a pattern is non-destructive, unlike overwriting a split point).

## Semantic node names (`splitNodeNames.ts`, GitHub issue #487)

For a hand-built split the generic "Node N" / "N{N}" numbering (`splitNodeLabel` /
`splitNodeLabelShort`) is fine, but for a split point whose current face configuration matches a
recognized special-split topology the node roles are meaningful and the numbers hide them.

`splitNodeSemanticNames(nodes)` reuses `detectSplitSpecialShapeKind` (`splitFaceLayout.ts`) — the
same recognition the canvas renderer and node-point positioning already use — then derives each
node's role from `faceKindsByNode` alone (which face indices it owns), no tile geometry needed.
Returns a `{ full, short }` name per node in row order (original node first, then each slot), or
`null` for an unrecognized topology, any one-way connection, or a node with no recognized role.

Named topologies (node order matches `buildSplitPassagesCore`'s own per-kind branch):

| kind | nodes | names (in the order the function returns them) |
|---|---|---|
| `bridge` (degree 4) | 2 | node 0 through passage **"Corridor"**, node 1 crossing **"Bridge"** |
| `diagonal` / divider (degree 4) | 2 | **"Corridor 1"** / **"Corridor 2"** (row order) |
| `hex_bridge` | 2 | node 0 **"Corridor"**, node 1 **"Bridge"** |
| `hex_diagonal` (two non-opposite pairs) | 2 | **"Corridor 1"** / **"Corridor 2"** (row order) |
| `hex_diagonal_divider` (two three-face halves) | 2 | **"Fork 1"** / **"Fork 2"** (row order) |
| `hex_triple_bridge` (three opposite pairs) | 3 | node 0 **"Corridor"**, node 1 **"Lower bridge"**, node 2 **"Upper bridge"** (row order) |
| `hex_triple_corridor` (one opposite + two adjacent pairs) | 3 | the opposite-pair node (`facesByNode.findIndex(isOpposite)`) is **"Middle corridor"**; the two adjacent-pair nodes are **"Side corridor 1"** / **"Side corridor 2"**, ordered by their lowest owned face index. Returns `null` (not a partial result) if no opposite-pair node is found — a case `detectSplitSpecialShapeKind` already rules out, so this is a defensive guard only. |

i18n keys: `split_node_name_corridor` / `_bridge` / `_corridor_n` / `_fork` / `_fork_n` / `_lower_bridge` /
`_upper_bridge` / `_middle_corridor` / `_side_corridor_n` (each with a `_short` variant; `{n}` where
numbered).

Used in four places (all fall back to "Node N" when `splitNodeSemanticNames*` returns `null`):

- **`ManageSplitNodesDialog` / `PresetSplitNodesDialog`** — `semanticNames` from each node's faces
  (same `facesOf` that feeds `tileNodes`); dialog row title, and in compact `short` form the
  link-bubble coordinate suffix — for this point's own nodes only, a partner endpoint on a different
  point keeps its own label. Post-edit's `facesOf` resolves a face's neighbour via the *active* UI
  slot (it shares the tile-diagram's own model), so on the rare partially-decided point where a
  split neighbour's active slot isn't its real connecting node, the dialog's recognised topology can
  differ from the picker/inspector's (which use the real-partner resolution below). A fully-decided
  special split — the only kind that gets named — resolves identically both ways.
- **`PostEditSplitTargetDialog` / `PresetSplitTargetDialog`** — the "which split node?" picker rows
  (`.full`), computed from the same `faceKindsByNode` the special-shape preview already derives.
- **`buildCellInspection` / `buildPresetCellInspection`** (status-bar cell inspector) — the per-node
  block title (`"[Corridor: …]"` instead of `"[Node 1: …]"`). Needs the tessellation config (post-gen
  path) / config + in-field cells + preset connections (preset path) threaded through
  `resolveCellInspection`; omitting them keeps the plain "Node N" titling.

The preset stage's per-node face-kind computation is shared as `presetSplitNodeFaceKinds`
(`fieldEditUtils.ts`) — one node's kind on every face, resolving the neighbour's real connecting node
per `resolvePresetPartnerAt` — used by `PresetSplitNodesDialog`'s tile diagram, the preset split-target
dialog, and the preset cell inspector alike. The post-generation callers reuse
`splitPointFaceKindsByNode` (`splitNodeGeometry.ts`).

## Testing

`splitNodeNames.test.ts` covers `splitNodeSemanticNames` directly — every named topology (degree-4
bridge/diagonal-divider, and all five hex kinds, including `hex_triple_corridor`'s lowest-face side
ordering), plus `null` for an unrecognized topology, a one-way connection (degree-4 and hex), and an
unsupported tile degree. `cellInspection.test.ts` and `presetCellInspection.test.ts` cover the
inspector titling (bridge → "Corridor"/"Bridge", `null`/absent cfg → "Node N"). The shared preset
face-kind helper `presetSplitNodeFaceKinds` is covered directly in `fieldEditUtils.test.ts`
(passage/wall per face, in-field face with no entry → `"undefined"`, one-way direction →
`one_way_out`/`one_way_in`). `splitBlueprints.test.ts`
covers the pure functions (`blueprintsForDegree`, `rotateBlueprint`,
`fittingRotation`, `blueprintToSplitPattern`, `tileNodesForBlueprint`) directly. `postEditSlice.test.ts`
and `presetConnectionsSlice.test.ts` cover `applySplitBlueprint`/`applyPresetSplitBlueprint`'s
store-level behavior: full replace of stale slots/edges, occupied-element migration, the
out-of-degree face skip, and (preset only) the boundary-face skip and the explicit-wall-on-unused-face
behavior.

## Cairo template (issue #718)

The degree-5 Cairo registry contains the first template, **Параллельный разделитель**. Cairo face index
`0` is canonicalized to the unique edge whose endpoint corners have equal angles; indices `1..4`
then follow the pentagon perimeter. Cor1 owns canonical faces `2-3`, while Cor2 owns `1-4`.

The dedicated divider wall is the polyline corner `1-2` -> tile centre -> corner `3-4`. Marker
anchors use the line from corner `2-3` to the midpoint of canonical edge `0`: Cor1 is at `1/4`
and Cor2 at `3/4`. Concrete Cairo previews and point application use these indices directly: core's `faces_of`
order is the canonical order.

The second degree-5 template is **Смежный разделитель**: Cor1 owns canonical faces `1-2`, Cor2
owns `3-4`. Its walls are the complete canonical side `0` and the straight segment from corner
`2-3` to the midpoint of side `0`. Let the centre of that separating segment be `D`; Cor1's
marker anchor is halfway from `D` to the centre of edge `1`, and Cor2's is halfway from `D` to
the centre of edge `4`.

The third degree-5 template is **Мост 2 на 3**: the bridge node owns canonical faces `1-4`, and
the fork node owns `0-2-3`. The bridge uses the existing tapered bridge silhouette, narrowing from
face `1` to its centre deck and widening to face `4`. With special rendering enabled, the fork's
ordinary passages are suppressed, so only the dedicated bridge geometry is drawn. The bridge marker
is at the midpoint of the line joining the centres of faces `1` and `4`; the fork marker is at `1/3`
of the line from corner `2-3` toward the centre of side `0`.
