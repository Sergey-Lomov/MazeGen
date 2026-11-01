# Tooltip

`maze-web/src/components/Tooltip.tsx` — accessible replacement for the native `title` (GitHub issue #768). Meant for disabled controls and other non-focusable content.

- The wrapper (`tabIndex=0`, `data-testid="tooltip-anchor"`) points `aria-describedby` at a visually hidden copy of the content. With empty content it stays in place but is inert: no tab stop, no description, no bubble.
- The bubble is portaled into `body`, positioned with the shared `flip`/`shift` middleware.
- **Show:** mouse/pen hover after `TOOLTIP_HOVER_DELAY_MS` (300 ms), focus (immediate), touch press (immediate).
- **Hide:** pointer leave, blur, Escape, a touch outside the anchor and bubble, window blur, content becoming empty.
- **Press dismissal (GitHub issue #915):** a mouse/pen press on the anchor hides the bubble at once, cancels a pending hover timer and suppresses the bubble the resulting focus would show. The anchor may open a color picker, menu or popup that takes the pointer away without a pointer leave, so call sites need no workaround. The suppression is cleared on blur. Hovering again after leaving shows the bubble as usual. A popup opened from the keyboard keeps the focus bubble.
