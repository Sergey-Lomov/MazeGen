# Split Patterns — Generation & Editor

Split patterns (GitHub issue #222) are an alternative to `CustomVertexBased`'s plain
`max_split_nodes` random-node-count splitting: an abstract, tessellation-relative template
describing exactly how many nodes a split tile gets and which of its faces connect where. When
`splitPatternMode` is on, every split roll picks one declared pattern (weighted) instead of minting
a random node count with unconstrained face assignment.

## Wire types (`maze-core/src/generation/split_pattern.rs`, mirrored by `wasm/types.ts`)

> **Current model.** Face indexing, per-tessellation ownership and symmetry handling below are
> superseded by "Target model: patterns on shape templates" at the end of this file (GitHub epic
> #752, implemented in #758/#764).

- **`SplitFaceRequirement`** — `Passage | OneWay(direction) | Wall | Unspecified`. `Wall` is the
  only requirement satisfiable off-field (a face pointing past the tessellation's boundary).
  `Unspecified` leaves the face open to the ordinary corridor/junction logic like any other free
  neighbor (see "The `Unspecified` trap" below) — client-side wire name is `"unspecified"`.
- **`OneWayDirection`** — `Forward | Backward`, relative to the pattern-local node that owns the
  face: `Forward` means the edge points away from this node, `Backward` means into it. Mirrors
  `PresetConnectionState`'s naming.
- **`SplitPatternFace`** — `{ face_index, requirement, sibling_target }`. `face_index` is a
  position into `Tessellation::faces()`, always interpreted against the tessellation the pattern
  is currently authored/applied for. `sibling_target: Some(i)` means this face must connect to
  pattern-local node `i` (an inter-split edge — the two split nodes share the same point, never
  geometrically resolved against an outside neighbor); `None` means an ordinary outside neighbor.
- **`SplitPattern`** — `{ node_count, faces: Vec<Vec<SplitPatternFace>>, weight }`. `faces[i]` is
  pattern-local node `i`'s face list; node `0` always corresponds to the tile's pre-existing `src`
  node, every other index is newly minted when the pattern is applied. `weight` is the relative
  selection weight among patterns competing for the same split event — clamped to `.max(0.0)` at
  the DTO boundary (NaN also maps to `0.0`); a non-positive weight is simply never selected, not a
  config error.
- **`SplitGenerationConfig`** — `{ pattern_mode, max_split_nodes, patterns }`. Consulted only by
  `CustomVertexBased`; every other generation algorithm ignores it. `max_split_nodes` only applies
  in non-pattern mode (the **total** node count on a split tile including `src` itself — an exact
  count, not a ceiling; `0` is invalid, clamped to `1`).

**Patterns are per-tessellation, not portable** — a pattern's `face_index` values are only
meaningful against the tessellation they were authored for. The active tessellation owns its own
pattern list (`splitPatterns` in the store); switching tessellation discards it, the same as other
tessellation-specific project settings.

## Validation (`validate_split_patterns`)

Shared by `maze-runner` and `maze-wasm`'s own generation entry points. Two independent failure
modes:
- `face_index` outside `[0, degree)` — meaningless against the active tessellation. Most likely a
  hand-edited/stale project file; the UI itself can't produce one (patterns are edited per
  tessellation via `TileFaceEditor`, which only ever emits in-range indices).
- `node_count` not matching `faces.len()` — the UI always keeps them in sync
  (`resizePatternNodes`/`removePatternNode` both resize `faces` alongside `node_count`), but a
  hand-edited/stale project file could have `node_count` larger than `faces.len()`;
  `apply_pattern_adaptation` still mints exactly `node_count - 1` new nodes regardless, so any node
  index past `faces.len()` would get no face applied at all.

A node with no `Passage`/`OneWay` face at all (only `Wall`/`Unspecified`, or none declared) is
**not** rejected here (GitHub issue #238) — it mints a permanently disconnected split node, same as
any other unreachable-node case, left for QC to catch (or not) like other reachability issues
instead of aborting the whole generation. The pattern editor's own diagnostics strip (see below)
surfaces this case client-side before generation ever runs.

## Adaptation candidates (`split_adaptation_candidates`)

`enumerate_adaptations` (`split_pattern_logic.rs`) is private; `split_adaptation_candidates`
exposes the same candidate set publicly as `Vec<Vec<ResolvedFace>>` — each candidate's resolved
faces (`node_index`, `requirement`, `sibling_target`, `neighbor`) without the `rotation`/`mirror`
indices that produced it. Same inputs and semantics; pure and RNG-free. Consumed by
`maze-runner`'s canonical baselines (see `baselines.md`), which compare candidate sets
order-independently.

## Applying a pattern (`apply_pattern_adaptation`, `split_logic.rs`)

Mints `node_count - 1` new nodes (node 0 reuses `src`), immediately marks **every** minted node
`visited` (before any face is applied), then per face:

- **`sibling_target: Some(i)`** resolves `dst` to pattern-local node `i` (never geometrically
  resolved against an outside neighbor).
- **A face resolving to `parent`** (matches the existing `src<->parent` edge's direction/kind,
  already checked by `enumerate_adaptations` before this adaptation was chosen) relocates the real
  edge instead of adding a new one — `(src, parent)` becomes `(node, parent)` and/or `(parent, src)`
  becomes `(parent, node)`, whichever direction actually existed.
- **`Passage`** adds a bidirectional edge unconditionally — bypasses `one_way_chance` entirely.
- **`OneWay(dir)`** adds a single directed edge, `Forward` = `node -> dst`, `Backward` = `dst ->
  node`.
- **`Wall`** adds nothing.
- **`Unspecified`** adds nothing directly — see below.

Node 0 (`src`) never runs through the ordinary `run_ordinary_step_body_for_node` path afterward —
every one of its connections is already fully decided by the chosen adaptation's faces.

### The `Unspecified` trap (GitHub issue #239 — known limitation, not yet fixed)

`Unspecified` was designed to read as "maybe a passage, decided later by the ordinary
corridor/junction logic" — the same way an ordinary frontier node's undecided neighbor gets queued
into `reserve` and connected on a later step. In practice it behaves as "wall" far more often than
not, for two compounding reasons:

1. **Every node this pattern mints is marked `visited` immediately**, before any face is applied
   (see "Applying a pattern" above) — this prevents a `sibling_target` face from misreading an
   unvisited sibling as a genuine outside neighbor. But it also means an `Unspecified` face's
   neighbor, if already visited by the time this pattern applies, can **never** connect back — only
   an unvisited neighbor gets queued into `reserve`.
2. **No cyclic-style retry exists for `Unspecified` faces.** `cyclic_fired` (the mechanism that lets
   the *cyclicity* generation parameter carve a passage through an already-decided wall between two
   visited nodes) only ever applies to `Passage`/`OneWay` faces during ordinary step generation —
   never to a pattern's `Unspecified` face. So even the one case where "maybe connect later" could
   still happen (cyclic retry cutting through) doesn't apply here.

Net effect: an `Unspecified` face only ever becomes a real passage when its neighbor happens to be
unvisited at the moment this exact pattern event runs — a narrow, order-dependent window, not the
general "optional connection" the design intended. **The pattern editor's UI (`TileFaceEditor`
switcher) deliberately excludes `Unspecified` from its kind list** (`AVAILABLE_KINDS` in
`AbstractPatternEditorDialog.tsx` — only `passage`/`one_way`/`wall`) pending a fix that makes it
actually probabilistic (e.g. a genuine reserve-style retry independent of visited state). The wire
type/core logic still fully support `Unspecified` (a hand-edited or pre-#239 project file's
patterns keep working exactly as before) — only the editor's own switcher hides it from new
authoring.

## Pattern Editor UI (`AbstractPatternEditorDialog.tsx`)

Opened from `SplitSettingsDialog` (the split-mode settings modal) via each pattern card's edit
button. **Stays a `Modal`** (GitHub issue #237 follow-up — briefly tried as a `SidePanel` like the
post-edit/preset split-node panels, reverted): it's opened from inside `SplitSettingsDialog`,
itself a `Modal`, and a `SidePanel` doesn't portal above another modal's overlay — the tile/card
controls ended up visually present but unclickable behind it. Uses the `wide` dialog size (narrower
than before #237 — `{ minWidth: 420, maxWidth: 560, width: 480, height: "70vh" }` — since its
tile+card layout stacks vertically, not side-by-side, once the post-edit/preset panels moved to a
`SidePanel` and left this the dialog system's only `wide` caller).

Layout borrows `SplitNodesDialogView.tsx`'s `dialogPanelStyles` (`tileArea`/`nodeListWrap`/
`nodeList`/`nodeListFooter`) for visual consistency with the post-edit/preset panels, without
reusing that whole component — a pattern has no `NodeId`/point+slot concept, no real field point,
no start/finish, and no "undefined" connections carried over from a previous confirm, so the shared
component's row/link model doesn't fit. Tile diagram on top (`TileFaceEditor`, `ANCHOR_POINT =
[0, 0]` — a pattern has no real field point; `getTileDiagram` only uses its `(x,y)` argument to
center the result, so any fixed point works identically), kind switcher above it
(`AVAILABLE_KINDS = ["passage", "one_way", "wall"]` — no `Unspecified`, see above; no rotate
controls, `showRotateControls={false}` — a pattern has no fixed orientation until applied during
generation), node-card list below with a fixed footer (Add/Remove, no Start/Finish/rotate — those
are post-edit/preset-only concepts).

**One-way toggle:** re-clicking an already-`one_way` face flips its direction (`forward` ↔
`backward`) instead of re-pinning it to `forward` every time — mirrors post-edit's
`applyPostEditEdgeTool`'s "one_way" toggle (`requirementFor` in `AbstractPatternEditorDialog.tsx`).

**`sibling_target`:** the field still exists on the wire type and in `maze-core`, but the editor no
longer exposes any UI for setting it (GitHub issue #237 — the per-face sibling dropdown read as
confusing, and siblings aren't meant to link to each other directly via UI authoring); a follow-up
issue tracks removing the field itself from both sides.

### Diagnostics (warnings strip)

Shown inline above the tile+card layout (not a dismissible `SidePanel` strip, since this dialog
stays a plain `Modal`) whenever any of the following fire, deduplicated per node
(`pixi/splitNodeDiagnostics.ts`):

- **`patternEmptyNodeDiagnostics`** — a node with no `SplitPatternFace` entries at all (the sparse
  pattern-editor-only case; post-edit/preset panels never have a genuinely empty `TileFaceNode.faces`,
  see `splitNodeDiagnostics`'s own doc comment).
- **`splitNodeDiagnostics`** (shared with post-edit/preset, see `Specs/post-edit.md`) — dead node
  (every non-boundary face is `wall`) or unreachable node (no connection at all). Called with
  `skipIndices` = the set of nodes already flagged empty by `patternEmptyNodeDiagnostics`, so an
  empty node (which reads as "every face is wall" once defaulted) doesn't also fire the dead-node
  message for the same node.
- **`patternSiblingDiagnostics`** — a face's `sibling_target` pointing at a node index that no
  longer exists (can happen after `resizePatternNodes` shrinks `node_count` without rewriting other
  nodes' `sibling_target`s — unlike `removePatternNode`, which does fix them up on a single,
  reference-safe removal).

Purely informational — never blocks saving/closing the editor.

### Discarding empty patterns on close (`SplitSettingsDialog.handleCloseEditor`)

Closing the pattern editor on a pattern left with no faces defined on any node (every
`node.faces.length === 0`) silently drops it from `splitPatterns` instead of keeping a dead entry —
core would otherwise treat it as an all-wall split (every face defaults to `Wall` when absent, see
`tileFaceKindOf`), a pattern that can never be intentional (it can never mint a reachable node) and
was never touched by the user.

## `SplitSettingsDialog` (settings modal)

Top-level modal for the split-mode settings: `splitPatternMode` toggle, `splitMaxNodes` (shown only
when pattern mode is off), and — when pattern mode is on — the pattern list. Each pattern card shows
a compact read-only tile preview (`PatternPreviewTile`, reusing `TileFaceEditor` itself with
no-op click handlers so the preview can never visually drift from the actual editor), its weight
(editable, with a computed `%` share among all patterns), node count, and edit/remove buttons. An
empty pattern list shows `"No patterns defined"` instead of a bare dash.

### Generation card warning (`FeaturesPanel.tsx`'s `computeGenerationCard`)

The Generation feature card shows a `"warning"` status when pattern mode is on, `split_chance > 0`,
and the pattern list is empty — a dead-weight config (splitting is enabled but has nothing to draw
from, so it silently never fires). Gated on `initialConfig.method === "custom_vertex_based"` (the
only method pattern mode applies to, per `GenerationFeature.tsx`'s `isVertexBased`).

## Target model: patterns on shape templates (GitHub epic #752)

Target contract written by GitHub issue #754. Shape templates, the allowed transform group and the
face chain are defined in `space.md` ("Target model: extensible tessellation" → "Shape
templates").

### Pattern data

- `SplitPattern` gains `shape`, the key of a `ShapeDescriptor` (`regular:4`, `cairo_pentagon`,
  `<kind>:<name>`, …), carried by the core type, the wasm/runner DTOs and the project format.
- `SplitPatternFace.face_index` is a **canonical** index into the descriptor's circular face
  order (`0..face_count`), never a position in a particular cell's `faces_of`.
- Patterns belong to a descriptor, not to a tessellation. On a tessellation change, the web keeps
  every pattern whose descriptor is in the new tessellation's `shape_descriptors()` and drops the
  rest.

### Validation (`validate_split_patterns`)

Against the active tessellation instance. Rejected:
- a `shape` the tessellation does not provide;
- a `face_index >= face_count` of the pattern's descriptor;
- a `node_count != faces.len()`, unchanged.

A node without `Passage`/`OneWay` faces stays allowed (GitHub issue #238).

### Two-level applicability

1. **Variants (descriptor level).** A pattern is a candidate for cell `c` only if
   `shape_of(c)` is `Some` and its descriptor key equals `pattern.shape`. Its variants are
   exactly the elements of `c`'s allowed transform group. Each variant maps every pattern face
   through the face chain `canonical → transformed → local`. Variants that produce an identical
   local face assignment are deduplicated. No other source of variants exists: the old
   rotation/mirror tables and `transform_face_index` are removed.
2. **Topology (application level).** Each variant is checked face by face on application:
   - `neighbor(c, local_face)` plus field membership resolves the outside neighbor (`Wall` is the
     only requirement satisfiable without one);
   - then the existing adaptation checks run: parent-edge direction/kind match, visited state and
     sibling targets.

Consequences:
- A cell with no template, or with no pattern for its descriptor, is never split in pattern mode
  (the split roll does not fire for it).
- Weighted selection competes only among the patterns whose descriptor matches the cell.
- Triangle candidate sets become a strict superset of the old ones (reflections are now in the
  group).

### Consumers

`split_pattern_logic` (adaptation search), `split_adaptation_candidates`, `split_topology`,
`split_pattern_match` (a built tile matches a pattern when some allowed variant reproduces its
face assignment), repair `split_core`, and per-face QC checks all use the same two-level rule and
the same face chain. None of them reads a tessellation-wide face list or symmetry table.

### Pattern UI

`TileFaceEditor`, face rotation and bridge/diagonal detection are driven by the descriptor:
- template geometry from core;
- canonical face order;
- the descriptor's full group while authoring (a pattern has no cell);
- the cell's allowed group for post-edit/preset tiles.

`SPLIT_FACE_INDEX_WEB_TO_CORE` is removed: web and core share canonical indices.
