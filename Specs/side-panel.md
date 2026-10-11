# Side panel and modal dialogs

Two generic UI shells used throughout `maze-web`: `SidePanel` (docked, resizable, non-blocking) and
`Modal` (centered, blocking dialog). Both live in `maze-web/src/components/`.

## `SidePanel`

Generic resizable panel docked to the canvas's right edge (`SidePanel.tsx`). Portals into
`#side-panel-slot` (`SIDE_PANEL_SLOT_ID`), a DOM node inside `App.tsx` beside the canvas column, so
every panel docks next to the canvas regardless of where in the component tree it's triggered from
(issue #237).

Props: `title`, `subtitle?`, `onClose`, `warnings?` (dismissible strip, re-opens whenever the
message set changes), `overlay?`, `onTopChange?`, `children`.

### Mount-order stack (issue #629)

Several independent features may each keep their own `SidePanel` mounted at once with no
coordination (e.g. `DebugPanel` and `VertexBasedSettingsPanel` both live under the generation card;
the post-edit "Changes" panel and "Manage split nodes" panel). A module-level stack
(`panelStack`, keyed by a stable per-instance `Symbol`, not React context — panels mount across
unrelated, non-nested trees) tracks mount order. Only the most recently mounted instance is shown;
the rest stay mounted (internal state like scroll position or drafts survives) but are hidden.
Closing the top one unmounts it and pops it off the stack, revealing the next one down.

Push/pop happen in `useLayoutEffect` (not split across render + cleanup) so the stack stays
balanced under `StrictMode`'s mount-cleanup-mount effect cycle, and so two panels mounted in the
same commit both resolve their visibility before first paint (no one-frame flash where neither is
shown).

### Overlay mode

`overlay` renders the panel as `position: absolute; inset: 0` inside the slot instead of docking
in-flow beside it — used by `ColorPickerPanel` (issue #499) to sit on top of whatever `SidePanel`
content is already open, sized to the slot rather than its own `width` state. A non-overlay panel
below the current top one still needs `display: none` to drop out of layout when another *in-flow*
panel is stacked above it, but stays in flow (`visibility: hidden` only) when only overlays sit
above it — otherwise the slot has nothing to size itself by and collapses to zero width, taking the
overlay's `inset: 0` down with it (issue #629 follow-up).

### Escape to close (issue #631)

Pressing Escape closes the panel — but only when:
- this instance is the topmost entry on the mount-order stack (`isTop`), and
- no `Modal` dialog is currently open (`hasOpenModal()`, exported by `Modal.tsx`) — a dialog
  stacked on top of the panel must take precedence, leaving the panel open and closing only the
  dialog, and
- the keydown event wasn't already handled by content nested inside the panel
  (`e.defaultPrevented`) — needed because a nested overlay `SidePanel` (`ColorPickerPanel`) or a
  sibling capture-layer (`ColorEyedropperOverlay`) has its own, narrower Escape behavior and must
  claim the key first instead of also triggering this panel's `onClose`. React's `stopPropagation`
  on a synthetic event doesn't reach this native `window` listener, so nested handlers must call
  `preventDefault()` (bubble-phase Escape listeners) or register in the capture phase (sibling
  `window`-level listeners, to run deterministically before this one regardless of mount order).

### `onTopChange`

Notified (from a `useEffect`, post-paint) whenever this instance's topmost status changes,
including on initial mount. Lets a panel react to being covered by another `SidePanel` without
either panel knowing about the other — e.g. `ManageSplitNodesDialog` clears its on-canvas cell
outline while covered, `PngExportSettingsPanel` hides its print-frame canvas overlay.

### Consumers

`ColorPickerPanel` (overlay), `DebugPanel`, `AnalyticsFeature`, `ImageExportFeature` (render-mode
settings, overlay for nested config), `PostEditChangesPanel`, `SplitNodesDialogView`,
`VertexBasedSettingsPanel`.

### Top-edge hit testing (issue #679)

`SectionHeader` (used at every nesting level, optionally `disabled`) keeps its small negative vertical margin so its spacing
inside ordinary sections does not change. It must also remain `position: relative`: without that
positioning, Chromium-based browsers (notably Opera) can drop pointer events for the first
negative-margin flex item near the top edge of the panel's `overflow-y: auto` body. Do not fix this
by adding global top padding to `SidePanel`, since that shifts unrelated panel content.

For a browser-specific reproduction, enable diagnostics before opening the panel:

```js
localStorage.setItem("maze.debug.sidePanelHitTesting", "1");
location.reload();
```

The browser console then receives `[SidePanel #679 ...]` records for panel geometry, computed
styles, `elementFromPoint()` samples around the header/body boundary, and document-capture pointer
events. Remove the key to disable the logs. The equivalent temporary URL switch is
`?debugSidePanel=1`.

As a browser-compatibility fallback, the active panel replays a left-button click when it receives
`mouseup` without any preceding page-level `pointerdown` or `mousedown`. A genuine press or drag
keeps the normal event path. Because the replay happens after `mouseup`, it also briefly applies
`data-side-panel-recovered-press` so the affected control keeps visible pressed feedback instead
of changing selection without the usual `:active` styling.

## `Modal`

Centered, blocking dialog (`Modal.tsx`), portaled to `document.body`, with a dimmed full-viewport
overlay that closes it on click (stopped by clicking inside the dialog itself).

Props: `title`, `size?` (a `dialogSize` key), `rawBody?` (raw full-bleed container for content that
manages its own layout, e.g. split-pane dialogs — replaces the default padded body), `onClose`,
`children?`.

### Stack and Escape

`openModalStack` (an array of `useId()`-generated ids, not exported directly) tracks currently
mounted `Modal` instances, topmost last. Escape closes only the topmost modal when several are
stacked (e.g. a confirm dialog opened from within another dialog).

`hasOpenModal()` is exported for other Escape-handling UI to defer to — currently used by
`SidePanel` (issue #631) so a dialog open over a panel takes precedence over the panel's own
Escape-close.

### Consumers

Generic dialogs: `AlertModal`, `ConfirmModal`, `CategoryInfoModal`. Feature dialogs: post-edit and
preset entity/elevator/vertical-direction/reset/split-target dialogs, `SeedHistoryDialog`,
`SplitSettingsDialog`, `AbstractPatternEditorDialog`, `CopyFloorDialog`, `FieldPrintSizingDialog`,
`ItemSelectDialog`, analytics info modals, `PostEditModals` (auto-confirm/auto-compact info),
`ScreenDpiCalibrationModal`, warning-bubble popups (`ExportWarningBubble`,
`PngOverflowWarningBubble`), `ParamFields`' pattern/split-config list editors, `DebugRefBubble`,
`IssuesBlock`.
