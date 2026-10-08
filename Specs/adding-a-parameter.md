# Adding a new settings parameter

Checklist for adding one new parameter to an image-export settings panel (`VectorByWallsSettingsPanel`/
`VectorByCorridorsSettingsPanel` or a shared group like `MarkerSettingsGroup`). Follow every step that
applies — skipping one is how #697's parameter-links registry gap and the marker-character label drift
happened.

## 1. Check for a semantic precedent before naming anything

Before inventing a label or a field name, search the existing settings for a parameter that means the
same thing (a color, a font weight, a size fraction, a toggle). Reuse its exact wording. Do not invent a
synonym for a concept that already has a name elsewhere in the panel — that is how a project ends up with
both "Насыщенность шрифта" and "Жирность текста" for the same concept (font weight) in two different
sections. If no precedent exists, pick the plainest term and expect it to become the precedent for the
next parameter like it.

## 2. Derive the label from its section position, not in isolation

A parameter's label must read correctly as "`<subsection title>` → `<label>`", not duplicate the
subsection name inside the label itself. A color field inside an "Arrow" subsection is labeled "Color",
not "Arrow color" — the subsection header already said "Arrow". See `VerticalSettingsFields`'s own
"Marker"/"Arrow" sub-subsection split in `Specs/image-export.md` for the established convention (every
row under "Arrow" dropped its own trailing "arrow" word for exactly this reason). Only fall back to a
longer, qualified label when two sibling fields in the *same* subsection would otherwise collide (e.g.
`MarkerSettingsGroup`'s "Fill color" vs "Border color" — both needed, since "Color" alone wouldn't
disambiguate between them).

## 3. Register it in the parameter-links system when its type supports it

If the new field's value type has a matching `ParamType`, add a registry entry (`parameterLinksRegistry.ts`)
and a `linkTargets` plumbing path from the owning settings panel, the same way every other linkable field
in that panel already works. Do not leave a field that structurally *could* be linked rendering with
`linkTarget={null}` ("unsupported") just because it was new — that renders as a permanent broken-looking
icon for no real reason. The current set of supported `ParamType`s is not reproduced here — read it
directly from `parameterLinksRegistry.ts`, since it changes as new field shapes get modeled.

## 4. Never add backward-compatibility logic for old projects

A new parameter gets a default value and nothing else. Do not write migration logic, legacy-field
fallback chains, or versioned-loading branches for a parameter that is new — an old project file simply
lacks the field, and `validateImageExport.ts`'s existing `opt*`/fallback convention already handles an
absent field by using the provided default. This is different from *removing or renaming* an existing
field, which is a separate, deliberate migration decision — not the default posture for an addition.

## 5. Confirm scope before touching shared code

If the new parameter lives in a type/component shared across multiple callers (e.g. `MarkerSettings`,
consumed by start/finish markers and the three vertical-connection markers via one shared
`MarkerSettingsGroup`), do not assume every caller should get it. Explicitly confirm with whoever filed
the task whether the parameter should appear everywhere the shared code is used, or only at the specific
call site the ticket named — then wire the distinction through an explicit prop (see
`MarkerSettingsGroup`'s `showSymbolSection: boolean`), never an inferred heuristic like
"does this caller's settings object happen to have the field set."

## 6. Extra steps when the new parameter is a color

- **Register it in the project-colors list** (`projectColorsSelector.ts`, the `PC.*` entries) so it shows
  up in the color picker's "Project colors" section like every other named color in the project.
- **Survey the existing colors for semantic neighbors.** Find colors that are conceptually close to the
  new one (e.g. a new badge text color is close to that badge's own fill/border colors, and to any
  sibling badge's text color) and add them to the new color's own `priorityColors` list, so picking the
  new color surfaces its natural neighbors first.
- **Decide, for each of those neighboring colors, whether the new color belongs in *their* priority list
  too** — this is not automatic in either direction. Example: a new text color drawn over a fill should
  likely be added to that fill color's own priority list (the fill is naturally edited alongside its
  label's color). But the reverse is not automatic — a floor/corridor color that a text color merely
  *mimics* (the "knockout cutout" convention several labels already use) should not gain the new text
  color as one of *its* priorities, since the floor color is edited for reasons unrelated to any one
  label drawn over it.
- **Add a contrast-warning check** if the new color is drawn as foreground over another configured
  surface (text over a fill, a border over a background, etc.) — wire it into the existing mechanism in
  `maze-web/src/pixi/selectors/exportWarnings.ts` and `Specs/export-warnings.md`, following that spec's
  "Common rules" (OKLab perceptual distance threshold, the `showColorWarnings` toggle, one warning entry
  per distinct offending color pair) rather than inventing a separate ad hoc check.

## 7. Checklist of files typically touched

Not every parameter touches every item below, but check each one explicitly rather than skipping by
default:

- **Settings type** — `maze-web/src/store/imageExportTypes.ts` (the field itself, plus its own doc
  comment explaining defaults/units/optionality).
- **Defaults** — `maze-web/src/store/slices/imageExportDefaults.ts` (`DEFAULT_VECTOR_BY_WALLS_SETTINGS`/
  `DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS` and any shared `DEFAULT_*` const the field belongs to).
- **Store setter** — `maze-web/src/store/slices/imageExportSlice.ts` (a dedicated setter action, following
  the sibling setters' own naming convention for that settings group).
- **Settings panel UI** — the relevant row in `VectorByWallsSettingsPanel.tsx`/
  `VectorByCorridorsSettingsPanel.tsx` (or a shared group component), wired to the new setter.
- **Parameter-links registry** — see step 3, when applicable.
- **Validation** — `maze-web/src/store/projectExport/validateImageExport.ts` (an `opt*` read with a
  fallback to the default, for loading project files saved before this field existed).
- **i18n messages** — `maze-web/messages/en.json` and `maze-web/messages/ru.json` (English content is
  mandatory repo-wide; Russian is this project's second shipped locale — add both).
- **Tests** — cover the new field in whichever existing test files already cover its settings group
  (defaults, validation, store slice, settings-panel/renderer tests), rather than only relying on
  end-to-end coverage.

## 8. Final gate before reporting the parameter done

Before telling the user the parameter is implemented, go back through the step 7 list one line at a time
and name, for each one, the exact file you touched (or an explicit "not applicable, because ..."). Do this
as a literal pass over the list — not from memory of what "felt done," and not by pattern-matching against
one similar-looking field you already touched (that is exactly how the parameter-links registry entry got
skipped once: the UI row and `linkTargets` plumbing were copied from an existing field, which *felt* like
full coverage, while the separate registry-entry line in the same checklist was never actually opened and
checked). A step is only "done" once you can point at the diff for it; "I did something analogous elsewhere
so this one must be covered too" does not satisfy the gate.
