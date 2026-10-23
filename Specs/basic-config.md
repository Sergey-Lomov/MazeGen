# Basic Configuration

Selects the tessellation kind (square / hex / triangle / Cairo) and its orientation before any field editing or generation. Implemented as the "Basic configuration" card in `FeaturesPanel`.

## Concepts

**Preview state** — transient selection driven by dropdowns inside the card. Drives `GridOverlay` via `previewFieldConfig` so the canvas updates live. Does not affect confirmed tessellation or field setup.

**Confirmed state** — committed on "Confirm tessellation". Authoritative source for all downstream features (field setup, generation). Stored in `tessellationKind`, `hexOrientation`, `triOrientation`.

## Card lifecycle

- Card is always available (status `default` or `set`).
- Opening the card calls `syncPreviewToConfirmed()` — preview is reset to confirmed values so the user sees the current confirmed state, not stale values from a previous session.
- User edits dropdowns → preview fields update, canvas grid redraws.
- "Confirm tessellation" button calls `confirmTessellation()` — preview is written to confirmed, card remains open. While this card is open, `Enter` or `Space` invokes the same action unless focus is in a text-entry control; the handler runs before native activation of a focused non-text control and clears the previous feature-card focus.
- Closing the card without confirming leaves preview dirty; next open resets it via `syncPreviewToConfirmed()`.

## Tessellation kinds and orientations

| Kind | Orientation type | Values |
|---|---|---|
| Square | — | no orientation |
| Hex | `HexOrientation` | `flat_top`, `pointy_top` |
| Triangle | `TriOrientation` | `r0` (base bottom), `r90` (base left), `r180` (base top), `r270` (base right) |
| Cairo | — | no orientation |

Orientation dropdowns appear only when the relevant kind is selected in preview.

## State fields (mazeStore)

| Field | Description |
|---|---|
| `tessellationKind` | Confirmed kind |
| `hexOrientation` | Confirmed hex orientation |
| `triOrientation` | Confirmed triangle orientation |
| `tessellationConfirmed` | True after first successful confirm |
| `previewKind` | Preview kind — tracks dropdown, not confirmed |
| `previewHexOrientation` | Preview hex orientation |
| `previewTriOrientation` | Preview triangle orientation |
| `previewFieldConfig` | Derived config for `GridOverlay` (always predefined shape, 10×10 / radius 5) |

## Actions

**`setPreviewKind(kind)`** — updates `previewKind` and rebuilds `previewFieldConfig`. Does **not** reset orientation fields; preserves user's previous orientation choices.

**`setPreviewHexOrientation(ori)`** / **`setPreviewTriOrientation(ori)`** — update the respective preview orientation and rebuild `previewFieldConfig`.

**`syncPreviewToConfirmed()`** — atomically copies `tessellationKind → previewKind`, `hexOrientation → previewHexOrientation`, `triOrientation → previewTriOrientation`, rebuilds `previewFieldConfig`. Single `set()` call, no intermediate renders.

**`confirmTessellation()`** — copies preview → confirmed, sets `tessellationConfirmed = true`, syncs preview fields to confirmed (via `buildPreviewState`), resets shape to `rect`/`parallelogram`/`rect`. If kind changed, clears maze (nodes, edges, start, finish, navNodes, navEdges, components, warnings, stats, error), all tessellation-dependent presets (including teleports, vertical passages, and elevators), and resets `freeFieldPoints` for the new kind.

## FeatureCard status

| Condition | Status | Comment |
|---|---|---|
| `tessellationConfirmed = false` | `default` | "Not confirmed yet" |
| `tessellationConfirmed = true` | `set` | "Tessellation confirmed" |

Subtitle shown when confirmed: `"{Kind}"` for square; `"{Kind} · {orientation label}"` for hex and triangle.

## Grid overlay interaction

`GridOverlay` uses `previewFieldConfig` when `fieldSetupOpen = false`. Changing any preview dropdown causes immediate canvas grid redraw at the preview shape (always 10 cols×rows or radius 5 — not configurable in this card).
