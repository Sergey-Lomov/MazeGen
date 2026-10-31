# Toast notifications

Toast channel with three levels: `info` (plain facts), `warning` (rejected actions that need attention)
and `error` (failed operations). `info` and `warning` are timed notice toasts; `error` is a persistent card. Design source:
GitHub epic #766; infrastructure: #767.

## Modules

- `src/notifications/notificationRegistry.ts` — code registry and dedup key.
- `src/notifications/notificationStore.ts` — `notify()`, zone state, timers, close actions.
- `src/notifications/announcer.ts` + `src/components/Announcer.tsx` — shared live regions.
- `src/components/notifications/NotificationHost.tsx` — zone UI. Mounted once in `App` with
  `Announcer`; `canvasLeft` prop = viewport x of the canvas column (App's features-panel width).

## API

```ts
registerNotificationCode("feature.code", {
  severity: "warning",                      // "info" | "warning" | "error"
  message: (p) => m["feature.code"]({ x: p.x as number }),
  dedupParams: ["floor"],                   // info/warning only; default []
});

notify({ source: "feature", code: "feature.code", params: { x: 1, floor: 2 }, details: "…" });
```

- Each integration registers its own codes next to its code and adds en/ru messages.
- Unregistered codes are logged with `console.error` and ignored.
- Text is never stored: it is rebuilt from `code + params` on render, so a locale switch
  re-translates visible toasts in place without re-announcing them.
- Notice dedup key: `source + code` + stable serialization (sorted keys) of the `dedupParams`
  subset of `params`. Error cards aggregate by `source + code` only.

## Integrations (GitHub issue #769)

| Source | Code | Level | Trigger |
|---|---|---|---|
| `generation` | `generation.registry_load_failed` | error | `loadRegistry` failed (details: message) |
| `generation` | `generation.free_field_too_small`, `generation.run_failed` | error | generation cannot start / generation execution failed (details: message for the latter) |
| `post_edit` | `post_edit.refresh_failed` | error | `confirmPostEdit` analytics refresh failed (details: message) |
| `post_edit` | `post_edit.remove_endpoint_node_rejected` | warning | removing a split node assigned as start/finish |
| `preset_connections` | `preset_connections.remove_endpoint_node_rejected` | warning | removing a preset split node assigned as start/finish/gen-source |
| `post_edit` / `preset_connections` | `edit_refusal.split_boundary_face` | info | clicking a split-dialog face at the field boundary |
| `post_edit` / `preset_connections` | `edit_refusal.split_rotation_outside_field` | warning | rotating a split would move a connection outside the field |
| `post_edit` | `edit_refusal.split_face_owner_ambiguous` | info | rotating a connection onto a split face with no unambiguous owner |
| `post_edit` | `edit_refusal.split_connection_reset` | info | resetting a split connection through the edge branch |
| `post_edit` | `edit_refusal.unconfirmed_split_node` | warning | assigning a vertex element to an unconfirmed split node |
| `preset_connections` | `edit_refusal.teleport_outside_field` | warning | placing a teleport endpoint outside the field |
| `post_edit` / `preset_connections` | `vertical_drag.failed_passage`, `vertical_drag.failed_elevator` | warning | a vertical drag cannot resolve the matching point on another floor |
| `project_load` / `quality_preset_load` / `visual_preset_load` | `file_load.read_failed`, `file_load.invalid_json` | error | `readJsonFile` I/O or JSON syntax failure |
| `post_edit` / `preset_connections` | `vertical_passage.no_adjacent_cell` | warning | adding a vertical passage where no neighbouring floor has a cell |
| `topology` | `topology.folds_inactive` | warning | a field edit left more of a floor's glued pairs inactive (#839) |
| `field_setup` | `field_edit.auto_fill_preview_active` | warning | canvas click (not a pan gesture) during the background auto-fill preview (#772) |
| `field_setup` | `field_edit.nothing_selected`, `field_edit.nothing_copied`, `field_edit.clipboard_unavailable` | info | Copy shortcut with no selection / Paste shortcut with an empty clipboard / either shortcut in a tessellation without translation symmetry (#880) |
| `project_load` | `project.load_error`, `project.load_error_quality_preset`, `project.load_error_visual_preset` | error | invalid project file / file of another kind |
| `quality_preset_load` | `quality.preset.load_error`, `quality.preset.load_error_project_file`, `quality.preset.load_error_visual_preset` | error | invalid quality preset / file of another kind |
| `visual_preset_load` | `image_export.visual_preset.load_error`, `image_export.visual_preset.load_error_project_file`, `image_export.visual_preset.load_error_quality_preset` | error | invalid style preset / file of another kind |

Validation errors carry the validator message in `details`.
Vertical-drag notices carry the formatted target as `coords` and use empty `dedupParams`, so a
repeat updates the coordinates in place instead of creating another toast.

## Notice zone

A notice code registers `severity: "info"` or `"warning"`; the toast uses the matching palette. Info is
for plain facts and explanations (empty clipboard, a side with no neighbour), warning for refusals
that need the user's attention.

| Rule | Value |
|---|---|
| Visible / queued | 3 / 5; overflow drops the least recently updated queued notice |
| Queue aging | dropped when not updated for 10 s |
| Display duration | `min(4 s + 50 ms × chars, 8 s)`, started when the notice becomes visible |
| Repeat of visible | params replaced, timer restarted, total active display capped at 12 s |
| Repeat of queued | params and update time replaced |
| After the 12 s cap | repeats of the key ignored for 5 s (not after normal expiry / manual close) |
| Hover | pauses every zone timer (display and queue aging) via an active clock |

## Error zone

- Every `notify` is an occurrence with its own `params`/`details`; a card shows the latest one and `×N`.
- A card that gets a new occurrence moves to the bottom, so the visible cards are the most recently
  updated ones and a repeat never stays hidden in the collapsed group.
- At most 20 occurrences across all cards; the oldest is dropped, emptied cards are removed.
- The 2 bottom (most recently updated) cards are visible; the rest collapse into an "N more errors" row that expands all.
- "Details" is a disclosure toggle (chevron right/down, `aria-expanded`) that expands the card in place
  with occurrences newest first. Each shows its details and, only when it differs from the card's
  headline, its own message, so expanding never repeats the headline. The toggle is hidden when no
  occurrence has anything to add. Each occurrence has an icon-only copy button (lucide `Copy`,
  `aria-label` "Copy") that copies message + details and briefly shows a check mark. Cards never expire.

## UI

- Portal into a `body`-level container kept as the last child of `body` (after modal portals; the
  move is skipped while focus is inside the container, since moving a node drops focus),
  `z-index` = `overlay.zIndex + 1`, fixed width 360 px (shrinks only to fit the viewport), so
  toasts never resize when a longer one appears.
- Anchored to the canvas column's top-left corner (16 px from its top and left edges, i.e. right of
  the features panel); stacks grow downward. The epic's bottom-right placement was changed on
  user request.
- Error zone above notice zone; new items appended at the bottom.
- Every toast/card has a close button; "Close all" per zone, below its items, when the zone has
  2+ items (visible + queued).
- Colors only from `notificationPalette` (as `WarningBubble`): `info` toasts use the `info` palette, `warning` toasts `warning`, errors `critical`;
  dark palette background, palette text color for text and border. Everything inside a toast
  (buttons, counter, details, countdown line) inherits the text color. Box style is
  `embeddedNotificationStyle`. "Close all" and "N more errors" are bubbles in their zone's palette.
- A visible notice shows a countdown line along its bottom edge (CSS animation from the remaining
  fraction to zero; restarts on repeat, pauses with the zone). Its time base is the zone's active
  clock (`noticeActiveNow()`, `NoticeItem.timerStart`/`expiresAt`). Error cards have none.
  Escape does not close toasts.
- Toasts have no live roles. `announce()` feeds `Announcer`: error cards assertive once on
  creation; notices polite once when they become visible. Field hints use the same `announce()`.

The `generation.registry_load_failed` card includes Retry. It retries `loadRegistry`; a successful
retry closes that card, and a failed retry adds another occurrence to it.

# Tooltip and field-anchored hints

Primitives for epic #766 rules 3 and 4 (GitHub issue #768). Both render through a portal into
`body` with `z-index` `FLOATING_Z_INDEX` (above modals) and share positioning from
`src/components/floating/floatingPosition.ts`: `@floating-ui/react-dom` with `offset`, `flip`,
`shift` (8 px viewport padding), `fixed` strategy and `autoUpdate`, so they pick a side, stay in the
viewport and follow scroll containers and modals.

## `Tooltip` (`src/components/Tooltip.tsx`)

- `<Tooltip content={reason | undefined} block?>{control}</Tooltip>` — for disabled controls and
  other non-focusable content; replaces the native `title`.
- The wrapper is focusable (`tabIndex=0`) with `aria-describedby` pointing to a hidden copy of
  `content`; the visible bubble is `aria-hidden`.
- Shown on hover (300 ms delay), focus and touch tap; hidden on leave, blur, tap outside or Escape
  (Escape is stopped from propagating only while the bubble is open, so an enclosing modal does
  not close at the same time).
- Empty `content` keeps the wrapper (no remount when `disabled` toggles) but makes it inert: no tab
  stop, no description, no bubble.
- `ColorRow`'s `disabledHint` uses it; the hint is shown only when the caller disabled the row, not
  when the row is disabled because its field is hidden.

## Field hint (`src/components/FieldHint.tsx`)

```ts
const hint = useFieldHint();
<label ref={hint.labelRef}>…</label>                              // optional position anchor
<input ref={hint.anchorRef} aria-describedby={hint.describedBy} style={{ ...own, ...hint.fieldStyle }} />
{hint.hint}
hint.show({ key: "too_long", message: () => m["feature.too_long"]() }); // rejected / corrected
hint.dismiss();                                                        // next accepted change
```

- One hint per field: a new `key` replaces the current hint; the same `key` restarts the timer
  without re-announcement. Without a mounted field (`anchorRef`) `show()` does nothing.
- Closed by `dismiss()`, its close button, the notice-toast display duration
  (`min(4 s + 50 ms × chars, 8 s)` of the text at show / repeat time) of active display (hover
  pauses), or unmount of the owner. Refocusing the field does not close it.
- Announced politely once through `announce()`; no live role on the hint. `message` is called on
  render, so a locale switch re-translates it in place.
- At least as wide as the span from the label's left edge to the field's right edge when
  `labelRef` is attached (a note of the whole row; virtual reference = bounding union of both,
  `minWidth` via the `size` middleware), else at least the field's width. Longer single-line text
  extends past the span instead of wrapping.
- Lightweight caption 2 px under its anchor: `caption` typography in `ui.text.info`, panel-colored
  backdrop (readability over neighboring rows), thin 1 px info border at 45 % opacity, no shadow;
  single-line layout with a small dimmed close button centered on the line. The field gets a 1 px
  info outline while the hint is shown through `fieldStyle`, merged by the owner into the field's
  own `style` (the hint never writes to the field's DOM node). The notice-toast countdown is drawn as
  a thin underline of the text, restarted by a repeat and paused on hover.

## Input-normalization integrations (GitHub issue #770)

All audited field corrections use `NormalizerResult<T> = { raw, value, reason }` from
`src/components/inputNormalization.ts`. A non-null structured reason maps to a lazy localized
`FieldHintReason`; the hint is therefore shown from the correction event, even when `value` equals
the value already stored.

- `NumberInput` keeps rejected drafts visible like `TextInput` and never commits them. Integer
  decimal separators get an immediate hint; on blur it reports rounding, min/max clamping, or
  restoring the last valid value.
- Range clamping and range reversion hints say that the value was adjusted to the allowed
  `{min}–{max}` range; they do not include the corrected value itself.
- `TextInput` reports truncation or a rejected character immediately and invalid-draft restoration
  on blur.
- Field-size controls and Quality repair limits report their blur-time reversion/clamping.
- Elevator-span and digital PNG margin/size fields use `NumberInput`; PNG margins have minimum 0,
  while fixed width/height have minimum 1.
- RGB, HSL and OKLCH typed channel values retain their responsive clamp-on-input behavior, but a
  range hint appears only on blur. Slider movement and OKLCH gamut conversion do not show hints.

## Blocked-action explanations (GitHub issue #772)

Field-setup notices live in `src/notifications/fieldSetupNotifications.ts`, separate from the
post-edit/preset `editRefusalNotifications.ts`.

- Floors: the disabled "Remove floor" button of the last floor is wrapped in a `Tooltip`
  (`floors.remove_last_floor_hint`). An empty (whitespace-only) floor rename is reverted on commit
  and shows a field hint (`floors.empty_title_hint`) anchored to the floor's title text.
- Field editor: canvas clicks during the auto-fill preview raise the `field_edit.auto_fill_preview_active`
  notice; pan gestures (space / middle button) do not.
- Quality: the "+ Add check" row of a rule with no addable checks is disabled with a `Tooltip`
  (`quality.no_checks_for_kind`); the former `AlertModal` is removed. The row is keyboard-operable (Enter/Space) while enabled.
