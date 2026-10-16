# Toast notifications

Toast channel for rejected actions (`notice`) and failed operations (`error`). Design source:
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
  category: "notice",                       // or "error"
  message: (p) => m["feature.code"]({ x: p.x as number }),
  dedupParams: ["floor"],                   // notice only; default []
});

notify({ source: "feature", code: "feature.code", params: { x: 1, floor: 2 }, details: "…" });
```

- Each integration registers its own codes next to its code and adds en/ru messages.
- Unregistered codes are logged with `console.error` and ignored.
- Text is never stored: it is rebuilt from `code + params` on render, so a locale switch
  re-translates visible toasts in place without re-announcing them.
- Notice dedup key: `source + code` + stable serialization (sorted keys) of the `dedupParams`
  subset of `params`. Error cards aggregate by `source + code` only.

## Notice zone

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
- "Details" lists occurrences newest first with message, details and "Copy". Cards never expire.

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
- Colors only from `notificationPalette` (as `WarningBubble`): notices `info`, errors `critical`;
  dark palette background, palette text color for text and border. Everything inside a toast
  (buttons, counter, details, countdown line) inherits the text color. Box style is
  `embeddedNotificationStyle`. "Close all" and "N more errors" are bubbles in their zone's palette.
- A visible notice shows a countdown line along its bottom edge (CSS animation from the remaining
  fraction to zero; restarts on repeat, pauses with the zone). Its time base is the zone's active
  clock (`noticeActiveNow()`, `NoticeItem.timerStart`/`expiresAt`). Error cards have none.
  Escape does not close toasts.
- Toasts have no live roles. `announce()` feeds `Announcer`: error cards assertive once on
  creation; notices polite once when they become visible. Field hints use the same `announce()`.

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
