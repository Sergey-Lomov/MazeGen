# Background activity indicators

GitHub issue #1004. Some actions start background work that shows nothing meanwhile. Running processes are shown as
small cards in the top-right corner of the canvas, so the user sees what is running and why a result is late.

## Registry (`maze-web/src/activity/backgroundActivity.ts`)

- A process **kind** (`ActivityKind`: `fonts`, `analytics`) is active while at least one job of it runs.
  `beginActivity(kind, label?)` / `endActivity(kind, label?)` count jobs per kind and per label;
  `trackActivity(kind, promise, label?)` keeps a kind active while a promise is pending, however it settles.
- `runningActivities()` is a stable snapshot (kinds in start order, each with its sorted distinct labels) for
  `useSyncExternalStore`; `subscribeActivity`, `isActivityRunning`.
- The registry holds no timing. Appearance rules live in the UI.

## Sources

- `fonts` — an MSDF atlas conversion (`beginRasterWork` / `endRasterWork` in `rasterFontStore`, label = font name).
- `analytics` — every `computeAnalyticsAsync` call (`workerClients.ts`): the refresh after a change of QC settings
  and the post-edit confirmation (`confirmPostEdit`) are the same worker call, so one indicator covers both.
- Not indicated: generation (full-screen `GenerationProgressOverlay`) and print sizing (progress inside its
  dialog) already show their own progress.
- A new worker consumer adds a kind to `ActivityKind`, a text entry in `BackgroundActivityStack`, and wraps its job in
  `trackActivity`.

## Cards (`BackgroundActivityStack`)

- One card per running kind, all of one fixed width (240 px, long names wrap): the process name (fonts name the
  fonts being converted), an info button (`InfoIconButton`) at the right end of the title row opening a modal
  with a detailed description, and an indeterminate activity strip (`loading-progress-indeterminate`) along the
  bottom edge. The card carries the `activity-card` class, which gives its icon buttons the shared second hover
  level (`global.css`, same as a SidePanel header), because the card's surface is light.
- The description dialog is independent of the cards: it keeps its text and stays open after its process ends
  and its card goes; the user closes it.
- A card appears only after its kind has run `INDICATOR_DELAY_MS` (250 ms) and, once shown, stays at least
  `INDICATOR_MIN_VISIBLE_MS` (1000 ms) after the last job ends, so a quick process never flashes.
- **Folding.** With two or more cards a chevron under the stack folds them into one small card that shows only the
  number of running processes (strip included); clicking it unfolds. With a single card there is nothing to fold,
  so it shows normally even while folded is set. The choice is not remembered between sessions, and a folded
  stack stays folded when another process starts.
- The delay and the hold are the shared `useDelayedKeys` (`useDelayedIndicator.ts`; `useDelayedIndicator` is its
  single-flag form), one timer set per kind. Timers are cleared together with their entries on unmount, so a StrictMode
  remount reschedules them. A card whose hold already ran out hides at once when its process ends.
- Tests: `backgroundActivity.test.ts` (registry), `BackgroundActivityStack.test.tsx` (timing, folding, dialog,
  StrictMode), `useDelayedIndicator.test.ts` (the shared delay rule).
