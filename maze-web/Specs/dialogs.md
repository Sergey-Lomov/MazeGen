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
| `size` | `"approve" \| "info" \| "complex"` | `"info"` | Semantic size — see Size tokens below |
| `onClose` | `() => void` | required | Called on overlay click or close button |
| `children` | `ReactNode` | — | Rendered inside the padded scrollable body |
| `rawBody` | `ReactNode` | — | Replaces `children` with a full-bleed container (no padding, overflow hidden). Use when the content manages its own internal layout (e.g. split-pane dialogs). `children` is ignored when `rawBody` is provided. |

**Structure:**

```
overlay (fixed fullscreen, semi-transparent)
  modal (flex column, sized by token)
    header (title + close button)
    body | bodyRaw
```

- Overlay click → `onClose`
- Click inside modal → propagation stopped
- Close button (✕) → `onClose`
- `Escape` key → `onClose` (same path as ✕; when multiple modals are stacked, only the topmost responds)
- `body`: `overflowY: auto`, padded, flex column with gap
- `bodyRaw`: no padding, `overflow: hidden`, flex column — consumer is responsible for internal scroll

### ConfirmModal

`src/components/ConfirmModal.tsx`

Wraps `Modal size="approve"` with a fixed footer containing **Cancel** and **Ok** buttons. Use as a drop-in replacement for `window.confirm`.

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| `message` | `string` | Question text shown in the body |
| `onConfirm` | `() => void` | Called when user clicks Ok |
| `onCancel` | `() => void` | Called when user clicks Cancel or closes overlay |

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
| `subtitle` | `string` | — | Optional header subtitle |
| `onClose` | `() => void` | required | Close-button handler |
| `warnings` | `string[]` | — | Diagnostic strip under the header, dismissible, re-opens whenever the message set changes |
| `overlay` | `boolean` | `false` | Full-cover box model (`position: absolute; inset: 0`, sized to the slot) instead of the normal in-flow, drag-resizable one (own `width` state, drag handle on its left edge). Used by `ColorPickerPanel`. |
| `children` | `ReactNode` | — | Panel body, scrollable |

**Used by:** `DebugPanel`, `VertexBasedSettingsPanel`, `ColorPickerPanel` (`overlay`), the post-edit "Changes" panel and "Manage split nodes" dialog, the preset-stage split-node dialog, the pattern editor, render-mode and PNG-export settings (`ImageExportFeature`), `AnalyticsFeature`.

### Side panel stacking (GitHub issue #629)

Every feature keeps its own open/closed state for its own `SidePanel` (a store boolean, a local `useState`, whatever fits that feature) with **no coordination between features** — a feature never has to close another feature's panel before opening its own. Several `SidePanel`s can legitimately be mounted at once: `DebugPanel` and `VertexBasedSettingsPanel` both live under the generation card, independently toggled; the post-edit "Changes" panel and "Manage split nodes" dialog are independently toggled; a render mode's settings and the PNG format's settings are independently toggled; `ColorPickerPanel` (`overlay`) opens on top of whatever settings panel a color swatch lives in.

Which one is actually visible is decided entirely inside `SidePanel.tsx` itself, via a module-level mount-order stack: every live instance (either box model) pushes its own id on mount and pops it on unmount. Only the topmost (most recently mounted) instance renders visibly (`display` normal); every other mounted instance gets `display: none` — still mounted, so its own internal state (scroll position, an in-progress draft, `useState`) survives underneath, just not shown or laid out. Closing the top panel unmounts that instance (the owning feature drops it from the tree via its own `onClose`), which pops it off the stack — the next-most-recently-mounted instance becomes visible again automatically. No feature-level code participates in this beyond mounting/unmounting its own panel normally; there is no shared "active panel" id in `mazeStore`, and a feature's own open/closed boolean is never clobbered by another feature opening its panel (before GitHub issue #629, several features did exactly that — e.g. `ImageExportFeature` clearing `openRenderModeSettings` when opening PNG format settings, or `postEditSlice`'s `setPostEditChangesOpen`/`setPostEditFocusedPoint` each clearing the other — that coupling is gone; see `image-export.md`'s "Switcher" section and `PNG export` section for the current independent-toggle behavior).
