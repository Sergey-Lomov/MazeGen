# Dialogs

## Purpose

Reusable modal dialog system for the web client. Provides a base `Modal` component, a `ConfirmModal` shortcut for yes/no prompts, and a design-token layer that keeps all dialog dimensions and spacing consistent.

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
