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
- **Degree 6 (hex)** — 6 blueprints: opposite pairs, skip pairs, two "wide pair + far pair"
  variants, three-opposite-pairs, and opposite-pair-plus-two-skip-pairs.

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

1. Every node currently at the point — the original node plus every declared slot — has every
   edge/teleport/connection referencing it dropped first, and any start/finish/gen-source
   assignment on one of them rejects the whole operation (`"...reassign it first."` error),
   mirroring `removeSplitNode`/`removePresetSplitNode`'s own guard.
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
boundary/rotation concept applies here: a pattern isn't tied to any specific field point,
`face_index` stays abstract until the generator applies it during actual generation, so this is a
direct, unrotated conversion. Every declared face becomes a `Passage` requirement; every other face
is simply absent from `faces[i]` (core already treats "no entry" as `Wall`). `weight` is always
`1.0`, matching a freshly added blank pattern's default.

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

## Testing

`splitBlueprints.test.ts` covers the pure functions (`blueprintsForDegree`, `rotateBlueprint`,
`fittingRotation`, `blueprintToSplitPattern`, `tileNodesForBlueprint`) directly. `postEditSlice.test.ts`
and `presetConnectionsSlice.test.ts` cover `applySplitBlueprint`/`applyPresetSplitBlueprint`'s
store-level behavior: full replace of stale slots/edges, the start/finish/gen-source guard, the
out-of-degree face skip, and (preset only) the boundary-face skip and the explicit-wall-on-unused-face
behavior.
