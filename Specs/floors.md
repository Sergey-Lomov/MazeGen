# Floors (feature-map card)

GitHub issue #335, part of epic #333. Web-only floor-set configuration UI — add / remove / reorder / title floors. Implemented as the "Floors" card in `FeaturesPanel`, positioned immediately after the tessellation card.

Still no per-floor field, preset, or generation config today — every floor shares one tessellation/preset setup — but `floors.length` now reaches `maze-core` as `GenerateConfig.level_count` (GitHub issue #337): generation builds a `level_count`-level `MultiLevelField<T>` and can connect them with `VerticalPassage`/`Elevator` edges (see `Specs/generation.md`'s "Vertical Connections"). Everything downstream of generation — QC/repair/routing, post-edit, analytics/snapshot recompute — is still not multi-floor-aware and only ever operates on floor 0 (`MultiLevelField::single_level_id()`, `Specs/space.md`); the web store filters `_generatedNodes`/`_generatedEdges` down to the active floor before feeding them to post-edit or `GenerationRenderer` for exactly this reason — see "Non-goals" below.

## Concepts

**Floor** — `{ id, title }`. `id` is a client-minted UUID (`floor_${crypto.randomUUID()}`), stable across renames/reorders, never reused. `title` is user-editable text, defaulting to `"Floor N"` at creation time.

**Storage order is bottom-to-top** — `floors[0]` is "Floor 1" (the bottom floor), the last array entry is the newest/topmost floor. `addFloor` appends, which is exactly "add on top". The UI renders the reverse of this order (topmost floor first on screen) and maps its visual up/down arrows accordingly — the on-screen "up" arrow moves an entry toward the *end* of the `floors` array, not the start.

**`nextFloorNumber`** — monotonic counter for default `"Floor N"` titles, never reused even after the floor bearing that number is removed. Not derivable from `floors` at load time (a user may rename "Floor 5" and remove "Floor 2..4", after which recomputing from remaining titles would reissue an already-used number) — persisted in the project file.

## Invariant: at least one floor

`floors` always has at least one entry through the UI. `removeFloor` is a no-op when it's the only remaining floor; the UI additionally disables the remove button in that state. A fresh maze starts with exactly one floor, so the card is green (`set`) out of the box — a single-floor maze needs no configuration here at all.

## State fields (mazeStore, `floorsSlice.ts`)

| Field | Description |
|---|---|
| `floors` | `FloorState[]`, bottom-to-top order (see above) |
| `nextFloorNumber` | Next default-title number, monotonic, persisted |

## Actions

**`addFloor()`** — appends a new floor at the end (`floors.length + 1`-th visually, "on top"), title `"Floor {nextFloorNumber}"`, increments `nextFloorNumber`.

**`removeFloor(id)`** — no-op if `id` is the only remaining floor or unknown. No confirmation inside the action itself — `FloorsFeature` gates destructive removal behind `ConfirmModal` before calling this, and additionally calls `reset()` first when the removal would discard a generation/post-edit result (see "Loss detection" below).

**`renameFloor(id, title)`** — no-op on an empty/whitespace-only title (trimmed before storing).

**`moveFloor(id, direction)`** — adjacent swap within `floors` in array-index terms (`"up"` = toward index 0 = toward Floor 1, `"down"` = toward the end = toward the newest floor). No-op at either array end or for an unknown id. The UI's own up/down buttons invert this mapping to match the reversed on-screen order — see "Concepts" above.

## Loss detection and confirmation

Three distinct warnings, per the issue's own contract — removing a floor can lose two independent things, and reordering only ever risks one of them:

- **Field/preset data loss** (`selectFloorRemovalLosesFieldData`, `mazeSelectors.ts`) — always `false` today. Field-shape and preset-connection state is currently maze-wide, not per-floor (see `Specs/space.md`'s "Not yet built on top of this layer" note), so there is nothing per-floor to lose yet. Stubbed with a `floorId` parameter (not a bare constant) so the call site and signature don't need to change once real per-floor data exists — only the body does.
- **Generation/post-edit result loss** (`selectFloorChangeLosesGenerationData`, `mazeSelectors.ts`) — `mazeDirty || postEditDirty`. True whenever a generation result currently exists. Applies to **both** remove and reorder — floor identity shift affects underlying node/graph state, so even a pure reorder (no removal) must warn and reset.

Confirmation message selection (`FloorsFeature.tsx`, on remove):

| Field loss | Generation loss | Message key |
|---|---|---|
| no | no | none — removes immediately |
| yes | no | `floors.confirm_remove_field` |
| no | yes | `floors.confirm_remove_generation` |
| yes | yes | `floors.confirm_remove_both` |

Reorder uses its own `floors.confirm_reorder` message (never the field/preset message) when `selectFloorChangeLosesGenerationData` is true.

**On confirm, when the generation warning was shown, the maze is actually reset** (`useMazeStore.getState().reset()`) before the floor mutation is applied — not merely left stale with a dangling `mazeDirty` flag. A maze left on screen after floor identity changed underneath it would be actively misleading, not just "possibly outdated".

## FeatureCard status

| Condition | Status | Comment |
|---|---|---|
| `floors.length === 0` | `critical` | "No floors configured" — unreachable through the UI (see invariant above); kept per the issue's own status mapping and as a defensive fallback |
| Two or more floors share a title | `warning` | "Two or more floors share the same title" |
| Otherwise | `set` | "Floors configured" |

`computeFloorsCard` (`FeaturesPanel.tsx`) computes this from `floors` alone. The card's subtitle always shows the floor count (`floors.count_active`/`_plural`), independent of status.

## Persistence (project file)

`floors: { floors: { id, title }[], nextFloorNumber }` — optional section on disk (absent in files saved before this feature existed); `validate.ts`'s `validateFloors` defaults to a single floor (`nextFloorNumber: 2`) when the section is missing entirely. A malformed individual floor entry (non-string `id`/`title`) is dropped rather than failing the whole load; an entry sharing an `id` with an earlier one is dropped too (would otherwise collide as a React list key). If every entry is dropped, falls back to the same single-floor default as a missing section. In the post-validation `ProjectFile` type this field is *not* optional — same convention as `dirtyFlags`/`analytics`/`ui` — the optionality is only on the raw JSON on disk.

## Floor switcher (`FloorSwitcher.tsx`, GitHub issue #336)

Shared panel docked top-center over the canvas (`App.tsx`'s `canvasColumn`, absolutely positioned, not full-width) — shows the active floor's title with up/down arrows to move to the adjacent floor. This is the mechanism floor-aware features are expected to use to scope their displayed data to one floor at a time, once such features exist (see "Non-goals" below — none do yet).

Shown for every feature card except `basic_config`, `floors`, and `quality` (`FLOOR_SWITCHER_HIDDEN_CARDS` in `App.tsx`) — tessellation is floor-independent by definition, "Floors" configures the floor set itself, and QC spans the whole maze rather than one floor. Also hidden whenever `floors.length <= 1` — with a single floor there is nothing to switch between.

**State** — `activeFloorId: string` (`FloorsState`, `floorsSlice.ts`), a purely client-side, non-persisted UI cursor into `floors`. Not written to the project file: reset to `floors[0].id` on every `loadProject`, and whenever `removeFloor` removes the currently active floor. Always a valid id into `floors`; `setActiveFloorId` no-ops for an unknown id.

**Adjacent-floor direction mapping** mirrors `FloorsFeature`'s own inversion: `floors` is stored bottom-to-top, so the switcher's up arrow ("go to the floor above") moves `activeFloorId` toward the *end* of the array, and the down arrow moves it toward the start. Arrows disable at either array end.

**Panel width** is fixed to the widest floor title (measured via an offscreen `CanvasRenderingContext2D`, `measureMaxTitleWidth`), capped at 300px total — beyond the cap the title truncates with an ellipsis instead of growing the panel further. Computed once per `floors` change (`useMemo`, keyed on the `floors` array), not per active-floor switch, so the panel never reflows/jumps width as the user steps between floors of different name lengths.

Nothing yet reads `activeFloorId` besides the switcher itself — see "Non-goals".

## Grid visibility while the Floors card is open

`TessellationRenderer` (the sole owner of `GridRenderer` for the tessellation feature — see `maze-web/CLAUDE.md`'s feature-renderer ownership rule) shows its grid while `openCard` is `"basic_config"` **or** `"floors"`. Floors doesn't edit tessellation, so it always draws the confirmed `tessellationConfig`, never `previewTessellationConfig` (that preview-vs-confirmed split is `basic_config`-only, both in `TessellationRenderer` and in `MazeScene.refit`'s own `fieldCfg` selection).

## Non-goals (deferred to later epic #333 issues)

- No per-floor field shape, preset connections, or generation config — every floor shares one tessellation/preset setup, and `level_count` (the only thing sent to core) is just a count.
- Generation now consumes `level_count` (issue #337) and builds/renders across every floor; QC/repair/routing, post-edit, and analytics/snapshot recompute are not wired in yet — they still only ever see floor 0, regardless of `level_count`. `activeFloorId` now scopes `GenerationRenderer`'s displayed nodes/edges (and the web store's post-edit reset logic filters to floor 0 before use), but no other feature reads it.
- No connection between the web `floor.id` (UUID) and core's `LevelId` (`Specs/space.md`) — the web client never sends or receives `LevelId`s, only a `level_count` number and, on `NodeDto`, a 0-based floor *index* (`levels_ordered()` position, not `LevelId`). Synchronizing the two identity spaces (e.g. so per-floor field/preset config could be sent) is deferred to whichever future issue actually needs it.
