# Parameter links (store)

Guidance for code in this folder that implements linkable settings: `parameterLinks.ts`, `parameterLinkSchema.ts`, `parameterLinkRules.ts`, `parameterLinksRegistry.ts`, `parameterLinksActivity.ts`, `slices/parameterLinksEngine.ts`, `slices/parameterLinksDefaults.ts`.

## New settings must be linkable

Every new render-mode setting (a field of `VectorByWallsSettings` / `VectorByCorridorsSettings`, including teleport and other shared-style fields) must be declared **in the same change** in `LINK_SCHEMA` (`parameterLinkSchema.ts`) — the single source of truth (GitHub issue #927) from which both registries, `isPathActive` and the `patch*` path lists of `imageExportSlice.ts` are derived. A schema entry carries:

- the dot-path key, the value type, the label and a `G.*` group that mirrors the setting's place in the panel; `modes` says which render modes have it (`BOTH`/`WALLS`/`CORRIDORS` in the `section(...)` call);
- `active` (a rule from `R`) when the panel shows the row conditionally (maze-derived flag or another setting), so the links dialog treats a hidden path as inactive;
- `update`: `"param"` (default, single-field setter via `writeLinkedParam`), `"source"` (a "Shared style" source), or the `PatchGroup` of the `patch*` action that writes it.

The panel row's `linkTarget` takes a `LinkPath` (never `null` for a linkable field) in both `VectorByWallsSettingsPanel` and `VectorByCorridorsSettingsPanel`, so the row shows the link status and can be linked. `parameterLinkSchema.test.tsx` fails when a UI target is undeclared, a declared field lacks a link-aware update, or a scalar in the default settings is neither declared nor listed (with a reason) in its `NOT_LINKABLE` map; `parameterLinkPanels.test.tsx` renders both panels whole over generated scenarios and fails when a declared field is missing from a panel, a panel shows a field the schema does not mark active, or an `active` rule disagrees with the panel's own condition. A `Linked*Row` with a `LinkPath` target renders only while the schema reports that path active (`activePaths` in the link context), so a panel never repeats a linked field's own visibility condition — a section or an unlinked row asks the same schema condition by name (`gate("oneWays")` in the panels, `useGate("elevatorBadgesOn")` in subsections — the names are the keys of `R` in `parameterLinkRules.ts`), never a copy of it. A settings component may not read maze state of its own: `parameterLinkPanelStateReads.test.ts` fails on a store read that is not listed with a reason. Nor may it decide on its own what to show: `parameterLinkPanelConditions.test.ts` fails on a conditional render (`cond && <X/>`, `cond ? <X/> : <Y/>`) whose condition is not a `gate(...)`/`useGate(...)`, an expansion/dialog state or an entry of its allowlist (with a reason) — a visibility condition on a setting is a new rule in `R`. A rule that differs per render mode is written with `byMode(...)`. The panels get their maze-derived inputs from the `ParamActivityContext` flags of `useExportPanelModel` only — a new maze-derived gate is a new flag there, and the compiler then asks for its `MAZE_FOR_FLAG` entry in that test.

This applies when the setting's type is a `boolean`, a `number`, a color, or an enum that already has a `ParamType` (`cornerStyle`, `markerShape`, `verticalArrowStyle`, `indexLabelStyle`, `labelFont`, `teleportCurveDirection`). A new enum with the same values as an existing `ParamType` reuses that type; a genuinely new enum needs a new `ParamType` with a localized `format` in `parameterLinksRegistry.ts`.

## Opting out

If a setting cannot or should not be linkable (a free-form string, an object, a list, a value whose enum has no sensible link semantics), **ask the user explicitly and get confirmation before leaving it out**. Do not decide silently and do not leave `linkTarget={null}` as a default. Note the confirmed exception in a comment at the `linkTarget={null}` site.

## Known gaps

Settings that predate this rule and are not registered yet (`teleportConnectorStyle`, `teleportConnectorWidth`, `teleportArrowMode`, `teleportArrowPeriod`, `teleportArrowSize`) are not exempt: register them when touching their rows, and ask about the enums.
