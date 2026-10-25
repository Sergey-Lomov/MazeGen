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
missing/malformed optional sections to defaults), and applied via `loadProject`. `tessellation.kind`
is required and must be one of `square`, `hex`, `triangle`, or `cairo`; an unknown or invalid value
rejects the file instead of falling back to `square`. Failures are
`error` toasts (`Specs/notifications.md` in `maze-web`) under source `project_load`: I/O error
(`file_load.read_failed`), invalid JSON (`file_load.invalid_json`), a file of another kind
(`project.load_error_quality_preset` / `project.load_error_visual_preset`) or a validation error
(`project.load_error`, validator message in the toast details). Validation runs before
`loadProject`, so a rejected file changes no state. The style and quality preset loads follow the
same rules under sources `visual_preset_load` / `quality_preset_load`.

## Topology (`floorTopology`)

GitHub issue #836. Optional section `floorTopology?: Record<floorId, WireTopology>` (`types.ts`); a
floor without folds has no entry, and a file saved before this section loads with no topology, so
`CURRENT_VERSION` is unchanged. The wire shape and fingerprint are specified in `Specs/topology.md`,
"Wire form". The store keeps it as `floorTopology` (`FloorsState`), sends it as the `topology` key of
the generate and compute-analytics configs, and clears it when the tessellation kind or params
change (a topology is authored for one config), when a field config change targets its floor, and
when its floor is removed.

On load `validate.ts` computes the fingerprint of the file's `tessellation` and calls
`validateWireTopology` (`store/topologyWire.ts`) for every entry of a floor present in `floors`
(entries of unknown floors are dropped). A fingerprint mismatch rejects the file with
`floorTopology.<floorId>: topology was authored for tessellation `…`, current is `…``; so do
structural violations (face glued to itself or in two folds, a fold in no or several groups, unknown
group or fold references, malformed ends), each naming the fold or group. Cell validity and face
ranges need the tessellation and are checked by core when the topology is installed on a floor.

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
  `kind` (or the quality preset `kind`, see below), and `parseVisualPreset` rejects a file that looks like a project (no `kind`, has
  `generation` and `tessellation`), both with `FileKindMismatchError`, which the UI maps to a
  dedicated message (`project.load_error_visual_preset` /
  `image_export.visual_preset.load_error_project_file`). Other JSON without the preset `kind`
  fails with a generic error.

## Quality preset (rules file)

GitHub issue #751. A standalone file with only the quality control settings, so a tuned rule set
can be reused in another project or shared without copying the whole project. Code:
`maze-web/src/store/projectExport/qualityPreset.ts` (save/parse/unknown-id filter) and the
`loadQualityPreset` action (`generationSlice.ts`); UI: "Save rules" / "Load rules" buttons in the
Quality card (`QualityFeature.tsx`).

- Content: JSON `QualityPresetFile` (`types.ts`) — `kind: "maze-quality-preset"`,
  `version: QUALITY_PRESET_VERSION`, and `quality`: exactly the project file's `quality` section
  (`ProjectFileQuality` — rules, stages, `repairMaxIterations`,
  `repairTimeBudgetSecs`), built by the shared `serializeQuality(state)` and validated by the shared
  `validateQuality` (`validateSections.ts`).
- Extension: `QUALITY_PRESET_FILE_EXTENSION = ".mazequality"`, with the same iOS/iPadOS `accept`
  exception as project files (`qualityPresetFileAccept`) and the same neutral download MIME type.
- Load replaces the whole quality configuration (rules, stages, strategy params, repair limits);
  maze content, generation parameters, visual style and every other setting stay untouched.
  `nextLocalCheckId` is recomputed (`rulesFromFile`, shared with `loadProject`).
- Older presets: keys added after a preset was saved fall back to their defaults, the same way as
  in an old project file's `quality` section; unknown keys are ignored. A preset whose `version` is
  newer than supported is rejected.
- Malformed presets (invalid JSON, wrong shape, inconsistent stages, duplicate rule or stage ids)
  are rejected as a whole; `prepareQualityPresetLoad` fully parses and filters the file before
  `loadQualityPreset` runs, so nothing is applied partially. Duplicate rule/stage ids are rejected
  by the shared `validateQuality`, so project files get the same check.
- Unknown ids (removed or renamed since the preset was saved, or added in a newer build) are
  skipped by `dropUnknownQualityIds` against the loaded registry, and the UI lists the skipped ids
  in a notice (`quality.preset.skipped_ids`):
  - an unknown check is removed from its rule, and a rule left without checks by that removal is
    dropped and scrubbed from its stage (a rule saved with no checks stays);
  - a rule whose issue kind no check or strategy handles is dropped;
  - an unknown top-level strategy becomes "no fix";
  - a nested strategy entry with an unknown strategy, or in a slot its parent strategy doesn't
    declare (listed as `<parent strategy id>.<slot id>`), is removed with its own nested chain;
  - strategy params of an unknown top-level strategy are dropped with that rule assignment.

  Before the registry is loaded no filtering is done.
- File kind mix-up: `parseQualityPreset` rejects a visual preset (by `kind`) and a project file (no
  `kind`, has `generation` and `tessellation`) with `FileKindMismatchError`; `parseAndValidate` and
  `parseVisualPreset` reject a quality preset the same way. Each load dialog maps the error's
  `found` kind to a dedicated message.
