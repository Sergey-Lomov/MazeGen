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

`downloadProjectFile(state)` (`serialize.ts`): `serializeProject(state)` → JSON → `Blob` →
`ObjectURL` → temporary `<a download="maze-project.maze">` → click → revoke.

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

The selected file is read as text, `JSON.parse`d, validated by `parseAndValidate` (recovering
missing/malformed optional sections to defaults), and applied via `loadProject`. Failures surface
through `setError`: I/O error (`project.load_error_io`), invalid JSON (`project.load_error_json`),
or a validation error (`project.load_error`).
