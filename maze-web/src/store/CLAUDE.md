# Parameter links (store)

Guidance for code in this folder that implements linkable settings: `parameterLinks.ts`, `parameterLinksRegistry.ts`, `parameterLinksActivity.ts`, `slices/parameterLinksEngine.ts`, `slices/parameterLinksDefaults.ts`.

## New settings must be linkable

Every new render-mode setting (a field of `VectorByWallsSettings` / `VectorByCorridorsSettings`, including teleport and other shared-style fields) must be added **in the same change** to:

- both registries in `parameterLinksRegistry.ts` (`VECTOR_BY_WALLS_PARAM_REGISTRY` and `VECTOR_BY_CORRIDORS_PARAM_REGISTRY`), with a label and a `G.*` group that mirrors the setting's place in the panel;
- the panel row's `linkTarget` (never `null` for a linkable field) in both `VectorByWallsSettingsPanel` and `VectorByCorridorsSettingsPanel`, so the row shows the link status and can be linked;
- `parameterLinksActivity.ts` (`isPathActive`), when the panel shows the row conditionally (maze-derived flag or another setting), so the links dialog treats a hidden path as inactive.

This applies when the setting's type is a `boolean`, a `number`, a color, or an enum that already has a `ParamType` (`cornerStyle`, `markerShape`, `verticalArrowStyle`, `indexLabelStyle`, `labelFontWeight`, `teleportCurveDirection`). A new enum with the same values as an existing `ParamType` reuses that type; a genuinely new enum needs a new `ParamType` with a localized `format`.

## Opting out

If a setting cannot or should not be linkable (a free-form string, an object, a list, a value whose enum has no sensible link semantics), **ask the user explicitly and get confirmation before leaving it out**. Do not decide silently and do not leave `linkTarget={null}` as a default. Note the confirmed exception in a comment at the `linkTarget={null}` site.

## Known gaps

Settings that predate this rule and are not registered yet (`teleportConnectorStyle`, `teleportConnectorWidth`, `teleportArrowMode`, `teleportArrowPeriod`, `teleportArrowSize`) are not exempt: register them when touching their rows, and ask about the enums.
