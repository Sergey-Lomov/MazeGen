# Export composition

GitHub issue #1099 (epic #1098). A composition is a list of elements added to the **main canvas**: the same canvas the maze is shown on, in the same world units, under the same viewport (pan and zoom). It has no canvas, renderer or sheet of its own. It is independent of the target format. This document covers the container: the data model, the element list, drawing on the main canvas and persistence. Concrete element types arrive in later tickets (#1100 to #1103); multiple compositions and their switcher in #1105.

Code: `maze-web/src/composition/` (model, element types, store types), `store/slices/compositionSlice.ts`, `components/features/CompositionPanel.tsx`, `pixi/imageExport/CompositionLayer.ts` and `compositionElementDisplays.ts`.

## Data model

`Composition` (`compositionModel.ts`): `id`, `name` and `elements`, the z-order with the bottom element first (the last one is drawn on top).

`CompositionElement` is a common shell: `id`, `type`, `name`, `visible`, `locked` and an opaque `data`. The list, the main canvas layer and the project file know only the shell. Everything specific to a type lives in `data`, owned by that type: `CompositionElementType` (`elementTypes.ts`: `label`, `defaultName`, `createData`, `validateData`) and its display factory (`COMPOSITION_ELEMENT_DISPLAYS`: `data` to a Pixi object positioned in world units). Adding a type means adding one entry to each of the two maps; the list, the layer and the storage do not change. A test fails when a registered type has no display factory.

The only registered type is `test_text`, one line of text (`x`, `y`, `text`, `fontSize`, `color`), there so that the container can be exercised end to end. The real text element is #1101.

`locked` protects an element from edits in the list: it cannot be removed, renamed or moved. Visibility and lock can always be toggled. Canvas manipulation of locked elements follows the same rule when it arrives.

## Store

`CompositionState` (`compositionTypes.ts`): `compositions` (never empty), `activeCompositionId`, the counters `nextCompositionNumber` and `nextElementNumber` (ids `element_<n>` are never reused, even after removal), and the transient `selectedCompositionElementId` and `compositionPanelOpen` (reset on project load through `compositionTransientUi`).

Actions edit the active composition only: add (on top, selected), remove, move to a z-order index (clamped), rename (trimmed, a blank name is ignored), set visible, set locked, select, open/close the panel. A new project has one empty composition, `composition_1`.

## UI

Image Export card, a "Composition" button opens a side panel (`CompositionPanel`) with the element list and the add buttons (one per registered type). Like the other panel buttons it only opens the panel (an already open one is raised); the panel's close button closes it. The panel has no preview: the elements are seen on the main canvas.

The list is built from the shared `ListCell` and shows the top-most element first. A row has the name and the actions (tooltips): move down, move up, hide or show, lock or unlock, edit (inline rename: Enter commits, Escape cancels) and delete. Delete asks for confirmation (`ConfirmModal`). The selected row is marked with the thin left bar of `ListCell` (`current`).

## Main canvas

`CompositionLayer` is owned by `ImageExportRenderer` (the Image Export feature's renderer). Its container sits above the maze picture and the cut sheet and below the seam arrows, and follows the canvas viewport like the maze. It rebuilds from the active composition on every change: visible elements only, bottom first, each through its type's display factory. A display is kept per element id while its `type` and `data` object are unchanged (so `data` must be replaced, never mutated), which means a rename, a lock or a reorder does not recreate it; a hidden or removed element loses its display. An element of a type without a factory is skipped.

The maze picture belongs to the composition. `ImageExportRenderer` hides it (the mode renderers and the cut sheet) unless the active composition has a visible element of a type with `rendersMaze` (`compositionShowsMaze`). No such type exists yet (the maze area element is a later ticket), so for now the canvas shows only the composition's own elements. While hidden, the picture is not redrawn for viewport changes; it is brought up to date when it is shown again.

Export (GitHub issue #1099 scope): composition elements are drawn on the canvas but are not part of the exported PNG yet, and they are drawn once over the whole frame, not once per `CutPlan` offset. Both are decided when the export integration of the epic is specified, and that ticket must update this section and `Specs/image-export.md`.

## Persistence

The project file has a required `compositions` section (`ProjectFileCompositions`): `compositions`, `activeCompositionId`, `nextCompositionNumber`, `nextElementNumber`. `CURRENT_VERSION` is 7. Older files are not loaded and are not migrated (see `Specs/project-file.md`).

`validateCompositions` rejects, naming the path: a missing section, no compositions, a duplicate composition or element id (element ids are unique across the whole project), an `activeCompositionId` that names nothing, an element of an unknown type, and element `data` that its type's `validateData` refuses. The visual preset and the quality preset do not carry compositions.
