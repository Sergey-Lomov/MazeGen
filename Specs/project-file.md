# Project file (save / load)

The web client saves and loads the whole editor state as a single project file. Code lives in
`maze-web/src/store/projectExport/` (`types.ts`, `serialize.ts`, `validate*.ts`); the UI entry points
are the Save / Load buttons in the `FeaturesPanel` footer (`maze-web/src/components/FeaturesPanel.tsx`).

## Format and extension

- Content: pretty-printed JSON of `ProjectFile` (`types.ts`), versioned by `CURRENT_VERSION`.
  Version bumps are breaking — no migration of older versions.
- Extension: `PROJECT_FILE_EXTENSION = ".maze"` (`types.ts`). The content is still plain JSON; the
  dedicated extension only separates project files from other JSON the app produces (e.g. the debug
  call config `maze-debug-call-<seed>.json`, which stays `.json`).

## Save

`downloadProjectFile(state)` (`serialize.ts`): `serializeProject(state)` → `downloadJsonFile` (shared
with the visual preset): JSON → `Blob` → `ObjectURL` → temporary `<a download="maze-project.maze">` →
click → revoke. The `imageExport` section is built by `serializeImageExport(state)`, also shared with
the visual preset.

The `Blob` MIME type is `application/octet-stream`, not `application/json`: with a JSON MIME type
some browsers (Safari, mobile) append `.json` to the download name, and the resulting
`maze-project.maze.json` would be hidden by the load dialog's extension filter.

## Load

A hidden `<input type="file">` whose `accept` comes from `projectFileAccept(navigator)` (`types.ts`):
`.maze` everywhere except iOS/iPadOS, where it is omitted. iOS pickers map `accept` to system file
types (UTIs) and `.maze` has none, so a filter could grey out every file; iPadOS is detected via
`platform === "MacIntel"` with touch points, since it reports a desktop Mac user agent. On iOS any
file can therefore be picked; a non-project file fails at `JSON.parse`/validation like any other bad
file.

Legacy project files saved as `.json` are not offered by the filtered picker; renaming such a file to
`.maze` makes it loadable again, since the content format is unchanged.

The selected file is read as text and `JSON.parse`d by `readJsonFile` (`components/jsonFile.ts`,
shared with the style load dialog), validated by `parseAndValidate` (recovering
missing/malformed optional sections to defaults), and applied via `loadProject`. Failures surface
through `setError`: I/O error (`project.load_error_io`), invalid JSON (`project.load_error_json`),
or a validation error (`project.load_error`).

## Visual preset (style file)

GitHub issue #750. A standalone file with only the visual configuration, so a tuned style can be
reused in another project without copying generation settings or maze content. Code:
`maze-web/src/store/projectExport/visualPreset.ts` (save/parse) and the `loadVisualPreset` action
(`imageExportSlice.ts`); UI: "Save style" / "Load style" buttons in the Image Export card
(`ImageExportFeature.tsx`).

- Content: JSON `VisualPresetFile` (`types.ts`) — `kind: "maze-visual-preset"`,
  `version: VISUAL_PRESET_VERSION`, and `imageExport`: the project file's `imageExport` section
  without the per-section expanded/collapsed UI state. It includes both renderers' settings, PNG
  export settings, the active render mode, `showColorWarnings`, `linkIconVisibility`,
  `floorLabelModeChosen` and the parameter links (`vectorByWallsLinks` / `vectorByCorridorsLinks`,
  same "`null` = current defaults" convention), so linked values keep propagating after load.
- Extension: `VISUAL_PRESET_FILE_EXTENSION = ".mazestyle"`, with the same iOS/iPadOS `accept`
  exception as project files (`visualPresetFileAccept`) and the same neutral download MIME type.
- Maze-bound data is not saved: `floorLabel.positionsByFloorId` (keyed by floor id) and
  `teleportGroupOverrides` (keyed by teleport group). Loading keeps the target project's values.
- Load replaces only the visual configuration and its links; generation settings, field, presets,
  post-edit and maze data stay untouched. A preset with no active render mode (saved before one was
  picked) keeps the project's current mode. If the loaded preset's floor-label mode was never chosen,
  one is picked for the current floors (same as the first Image Export open).
- Older/newer-minor presets: every missing or malformed field falls back to its default through the
  same lenient validators as the project file's `imageExport`; unknown fields are ignored. A
  preset whose `version` is newer than supported is rejected.
- File kind mix-up: a project file has no `kind`. `parseAndValidate` rejects a file with the preset
  `kind`, and `parseVisualPreset` rejects a file that looks like a project (no `kind`, has
  `generation` and `tessellation`), both with `FileKindMismatchError`, which the UI maps to a
  dedicated message (`project.load_error_visual_preset` /
  `image_export.visual_preset.load_error_project_file`). Other JSON without the preset `kind`
  fails with a generic error.
