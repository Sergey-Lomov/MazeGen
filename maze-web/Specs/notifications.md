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
