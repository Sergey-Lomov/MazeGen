# Dialogs

## Purpose

Reusable modal dialog system for the web client. Provides a base `Modal` component, a `ConfirmModal` shortcut for yes/no prompts, and a design-token layer that keeps all dialog dimensions and spacing consistent.

See also [SidePanel](#sidepanel) below — the canvas-docked counterpart to these overlay `Modal`s, used for split-node management, debug, generation/export settings, and the color picker.

## Components

### Modal

`src/components/Modal.tsx`

Base component for all overlay dialogs. Renders via `createPortal` into `document.body`.

**Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `title` | `string` | required | Header text |
| `size` | `keyof typeof dialogSize` | `"info"` | Semantic size — see Size tokens below |
| `onClose` | `() => void` | required | Called on overlay click, close button, or Escape |
| `onConfirm` | `() => void` | — | Enter/Space confirmation shortcut (GitHub issue #638). Omit for dialogs with no confirmation action (informational dialogs, or ones where picking a row confirms and closes immediately) |
| `children` | `ReactNode` | — | Rendered inside the padded scrollable body |
| `rawBody` | `ReactNode` | — | Replaces `children` with a full-bleed container (no padding, overflow hidden). Use when the content manages its own internal layout (e.g. split-pane dialogs). `children` is ignored when `rawBody` is provided. |

**Structure:**

```
overlay (fixed fullscreen, semi-transparent)
  modal (flex column, sized by token, tabIndex=-1, focused on mount)
    header (title + close button)
    body | bodyRaw
```

- Overlay click → `onClose`
- Click inside modal → propagation stopped
- Close button (✕) → `onClose`
- `Escape` key → `onClose` (same path as ✕; when multiple modals are stacked, only the topmost responds)
- `Enter`/`Space` → `onConfirm`, when provided (same topmost-only rule as Escape). The modal box grabs DOM focus on mount so the shortcut works immediately, without first needing a click inside the dialog. The keydown listener runs in the capture phase on `window`, ahead of any focused element's own native activation (a button re-clicking itself, a slider nudging its value) — so the shortcut always reaches `onConfirm` instead of re-triggering whatever inside the dialog happens to hold keyboard focus. Two exceptions where the key keeps its native meaning instead: `Space` in a text-entry control (`<input>` of a text-like type, `<textarea>`, or contentEditable) types a literal space; `Enter` in a `<textarea>` inserts a newline. Enter in a single-line text `<input>` still confirms (standard form behavior).
- `body`: `overflowY: auto`, padded, flex column with gap
- `bodyRaw`: no padding, `overflow: hidden`, flex column — consumer is responsible for internal scroll

### ConfirmModal

`src/components/ConfirmModal.tsx`

Wraps `Modal size="approve"` with a fixed footer containing **Cancel** and **Ok** buttons. Use as a drop-in replacement for `window.confirm`.

Every dialog footer that pairs a cancel action with a confirmation action marks both buttons as
`dialogAction`; `Button` then applies the shared 80 px minimum width. This keeps short labels such
as "Save" aligned with their cancel action without forcing longer localized labels to truncate.

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| `message` | `string` | Question text shown in the body |
| `onConfirm` | `() => void` | Called when user clicks Ok, or presses Enter/Space |
| `onCancel` | `() => void` | Called when user clicks Cancel, closes overlay, or presses Escape |

**Usage pattern** — keep dialog state local to the feature component:

```tsx
const [showConfirm, setShowConfirm] = useState(false);

<button onClick={() => setShowConfirm(true)}>Destructive action</button>

{showConfirm && (
  <ConfirmModal
    message="Are you sure?"
    onConfirm={() => { doAction(); setShowConfirm(false); }}
    onCancel={() => setShowConfirm(false)}
  />
)}
```

## Design tokens

All dialog tokens live in `src/styles/theme.ts`.

### `dialogSize` — semantic widths

| Key | `minWidth` | `maxWidth` | `width` | Intended use |
|-----|-----------|-----------|---------|--------------|
| `approve` | 260 | 360 | — (flexible) | Yes/No confirm prompts |
| `info` | 280 | 520 | 520 (fixed) | Single-pane info / param editing |
| `complex` | 460 | 720 | 720 (fixed) | Split-pane content (e.g. list + detail) |

`approve` has no fixed `width` — it adapts to message length between min/max.  
`info` and `complex` are fixed-width to prevent layout shift as content changes.

### `dialogSpacing` — internal spacing

| Token | Value | Used for |
|-------|-------|----------|
| `paddingX` | 14px | Horizontal padding in header and body |
| `paddingY` | 10px | Vertical padding in header and footer |
| `bodyPadding` | 12px | Top/bottom padding in scrollable body |
| `gap` | 10px | Gap between items in body flex column |
| `maxHeight` | 80vh | `maxHeight` on the modal box |

### `overlay` — backdrop

| Token | Value |
|-------|-------|
| `bg` | `rgba(0,0,0,0.6)` |
| `zIndex` | 1000 |

### `shadow`

| Token | Value |
|-------|-------|
| `modal` | `0 4px 24px rgba(0,0,0,0.5)` |

## Current dialog inventory

| Component | Modal size | Notes |
|-----------|-----------|-------|
| `ConfirmModal` | `approve` | Generic yes/no |
| `StrategyParamsModal` | `info` | Strategy param editing |
| `CheckDetailsDialog` (edit mode) | `info` | Check details + param editing |
| `CheckDetailsDialog` (add mode) | `complex` | Check list + detail split pane, uses `rawBody` |

### Preset and post-edit shared presentation (GitHub issue #658)

Preset and post-edit keep their endpoint models, selectors, previews, and store actions separate.
Their genuinely common presentation is shared through `EntityChoiceDialog`, `ElevatorFloorPicker`,
`SplitTargetPicker`, `VerticalDirectionPicker`, and `ToolIconRow`.
`PresetSplitNodesDialog` and `ManageSplitNodesDialog` use the shared split-node orchestration helper
for slot ordering, row/tile construction, node colors, semantic labels, and blueprint preparation;
their endpoint resolution, link/entity assembly, mutations, and hover behavior remain adapters.

### Enter/Space confirmation coverage (GitHub issue #638)

`onConfirm` is wired — matching the visible confirm button's own handler and `disabled`/enabled guard — on: `ConfirmModal`, `AlertModal` (OK), `ScreenDpiCalibrationModal`, `FieldPrintSizingDialog`, `PostEditElevatorFloorDialog`, `PresetElevatorFloorDialog`, `CopyFloorDialog`, and `ItemSelectDialog`'s consumers that have a confirm action of their own (`StrategySelectDialog`, `NewRuleStrategyDialog`, `NestedStrategySelectDialog`, `CheckSelectDialog`, `AddCheckToRuleDialog`, `IssueSelectDialog`, `AlgorithmSelectDialog`).

Deliberately left without `onConfirm` — no confirmation action of their own, per this issue's "informational dialogs" exclusion: `SeedHistoryDialog`, `PostEditSplitTargetDialog`, `PresetSplitTargetDialog` (row click picks and applies immediately, no separate confirm step), `PostEditResetDialog`, `PostEditEntityDeleteDialog`, `PresetEntityDeleteDialog` (their primary action is a destructive "Reset/Delete all", not a generic confirm), `PresetVerticalDirectionDialog`, `PostEditVerticalDirectionDialog` (each option applies immediately on click), every purely informational dialog with no confirm button (`AnalyticsModals.tsx`'s legend/stats/report modals, `IssuesBlock`'s issue-info bubble, `DebugRefBubble`, `PostEditModals`'s info modals, `ExportWarningBubble`, `CategoryInfoModal`, `PngOverflowWarningBubble`, `FieldSetupFeature`'s smoothing-info modal), and the live-editing dialogs whose changes commit immediately via `onChange` rather than a confirm step (`ParamFields`'s inline editors, `SplitSettingsDialog`).

## Confirm dialogs by feature

| Feature | Trigger | Message |
|---------|---------|---------|
| `BasicConfigFeature` | Confirm tessellation when kind changes and custom field or presets exist | Lists what will be reset (custom field, preset connections) |
| `FieldSetupFeature` | Switch Default↔Custom when custom field has cells | "Switch to standard shapes? Your custom field will be replaced." |
| `FieldSetupFeature` | Clear button in custom mode | "Clear all field cells?" |
| `PresetConnectionsFeature` | Reset all button | "Reset all preset connections?" |

## SidePanel

`src/components/SidePanel.tsx`

Canvas-docked counterpart to `Modal` (GitHub issue #237): a resizable panel anchored to the canvas's right edge instead of a fullscreen overlay, so editing reads as directly manipulating the canvas rather than a dialog floating over it. Renders via `createPortal` into `#side-panel-slot` (`SIDE_PANEL_SLOT_ID`, a `position: relative` div `App.tsx` places beside the canvas column) — every `SidePanel` portals there regardless of where in the component tree it's triggered from, so it always docks next to the canvas rather than wherever its owning feature lives in the left features panel.

**Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `title` | `string` | required | Header text |
| `stackKey` | `string` | — | Stable identifier that lets the owning control bring a mounted panel to the front without remounting it. |
| `subtitle` | `string` | — | Optional header subtitle |
| `onClose` | `() => void` | required | Close-button handler |
| `warnings` | `string[]` | — | Diagnostic strip under the header, dismissible, re-opens whenever the message set changes |
| `overlay` | `boolean` | `false` | Full-cover box model (`position: absolute; inset: 0`, sized to the slot) instead of the normal in-flow, drag-resizable one (own `width` state, drag handle on its left edge). Used by `ColorPickerPanel`. |
| `onTopChange` | `(isTop: boolean) => void` | — | Called whenever this instance's topmost status on the shared stack changes, including the initial mount (GitHub issue #629 follow-up) — see "Reacting to coverage" below. |
| `children` | `ReactNode` | — | Panel body, scrollable |

**Used by:** `DebugPanel`, `VertexBasedSettingsPanel`, `ColorPickerPanel` (`overlay`), the post-edit "Changes" panel and "Manage split nodes" dialog, the preset-stage split-node dialog, the pattern editor, render-mode and PNG-export settings (`ImageExportFeature`), `AnalyticsFeature`.

### Side panel stacking (GitHub issue #629)

Every feature keeps its own open/closed state for its own `SidePanel` (a store boolean, a local `useState`, whatever fits that feature) with **no coordination between features** — a feature never has to close another feature's panel before opening its own. Several `SidePanel`s can legitimately be mounted at once: `DebugPanel` and `VertexBasedSettingsPanel` both live under the generation card; the post-edit "Changes" panel and "Manage split nodes" dialog are independent; a render mode's settings and the PNG format's settings are independent; `ColorPickerPanel` (`overlay`) opens on top of whatever settings panel a color swatch lives in.

Which one is actually visible is decided entirely inside `SidePanel.tsx` itself, via a module-level mount-order stack: every live instance (either box model) pushes its own `{ id, stackKey, overlay }` entry on mount (in a `useLayoutEffect`, so a `StrictMode` mount-unmount-remount cycle nets out to a single push rather than desyncing — see the component's own doc comment) and pops it on unmount. Only the topmost instance renders visibly; every other mounted instance stays mounted (its own internal state — scroll position, an in-progress draft, `useState` — survives underneath) but hidden. Closing the top panel unmounts that instance (the owning feature drops it from the tree via its own `onClose`), which pops it off the stack — the next-most-recently-mounted instance becomes visible again automatically. A panel control calls `bringSidePanelToFront(stackKey)` before setting its own open state: this no-ops when the panel is not mounted (its mount puts it on top) and moves an existing hidden instance to the top otherwise. Consequently, repeatedly pressing a control never closes its panel. There is no shared "active panel" id in `mazeStore`, and a feature's own open/closed boolean is never clobbered by another feature opening its panel (before GitHub issue #629, several features did exactly that — e.g. `ImageExportFeature` clearing `openRenderModeSettings` when opening PNG format settings, or `postEditSlice`'s `setPostEditChangesOpen`/`setPostEditFocusedPoint` each clearing the other — that coupling is gone; see `image-export.md`'s "Switcher" section and `PNG export` section for the current independent-toggle behavior).

How a hidden instance is actually hidden depends on what's stacked above it (GitHub issue #629 follow-up): an `overlay` instance (`position: absolute`, contributes no width of its own) that isn't topmost gets `display: none`. A non-overlay (in-flow) instance gets `display: none` only when something *else in-flow* sits above it on the stack (it should no longer size the slot); when only `overlay` entries sit above it, it stays in normal flow — sized via its own `width` state — but painted with `visibility: hidden` instead, so the slot keeps the width the overlay above it needs (`inset: 0` on an overlay resolves against the slot's own box, which would otherwise collapse to zero width if the in-flow panel underneath it had also left the flow via `display: none`). This distinction is computed per-instance from the stack (`useKeepsFlowWidth`), not hardcoded to any one panel.

### Reacting to coverage (`onTopChange`, GitHub issue #629 follow-up)

A panel can react to losing (or regaining) topmost status on the shared stack via the `onTopChange` prop, without needing to know what covered it. Called from a `useEffect` (after paint, not the `useLayoutEffect` the stack itself updates on), including once on initial mount. Two current consumers:

- `ManageSplitNodesDialog` sets `postEditFocusedPointCovered` (`postEditSlice`) from it. `PostEditRenderer`'s on-canvas cell outline for the point being edited only draws while `postEditFocusedPoint` is set **and** not covered — otherwise the outline kept highlighting a cell for a dialog the user could no longer see or act on (e.g. while a `ColorPickerPanel` opened on top of it).
- `ImageExportFeature`'s PNG format settings panel sets `exportFormatSettingsCovered` (`imageExportSlice`) from it. `ExportFrameOverlay`'s `isExportPanelOpen` check (driving both the print and digital on-canvas frame/dimming) requires `!exportFormatSettingsCovered` alongside `openExportFormatSettings === "png"`, for the same reason.

Both covered flags are reset to `false` whenever their panel is (re)opened (`setPostEditFocusedPoint`, `setOpenExportFormatSettings`) — a freshly opened panel is never covered on open, regardless of the previous panel's leftover state.
