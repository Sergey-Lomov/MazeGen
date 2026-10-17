/** Shared positioning for portal-rendered floating feedback (`Tooltip`, field hints — GitHub issue
 *  #768): `offset` keeps a gap from the anchor, `flip` moves to the opposite side when the preferred
 *  one does not fit, `shift` slides along the side to stay inside the viewport, and `autoUpdate`
 *  re-positions on scroll / resize of any ancestor scroll container (side panel, modals). */

import { autoUpdate, flip, offset, shift, size, useFloating, type Middleware, type Placement } from "@floating-ui/react-dom";
import { overlay } from "../../styles/theme";

/** Gap between the anchor and the floating element, px. */
export const FLOATING_OFFSET = 6;
/** Minimum distance kept from the viewport edges by `flip` / `shift`, px. */
export const FLOATING_VIEWPORT_PADDING = 8;
/** Above `Modal` (`overlay.zIndex`) — tooltips and hints also anchor to controls inside dialogs. */
export const FLOATING_Z_INDEX = overlay.zIndex + 1;

function floatingMiddleware(gap = FLOATING_OFFSET, matchReferenceWidth = false): Middleware[] {
  return [
    offset(gap),
    flip({ padding: FLOATING_VIEWPORT_PADDING }),
    shift({ padding: FLOATING_VIEWPORT_PADDING }),
    ...(matchReferenceWidth
      ? [size({
        apply({ rects, elements }) {
          // A floor, not a fixed width: single-line text longer than the reference extends past it
          // instead of wrapping.
          elements.floating.style.minWidth = `${rects.reference.width}px`;
        },
      })]
      : []),
  ];
}

/** `useFloating` with the shared middleware, `fixed` strategy (the floating element is portaled
 *  into `body`) and `autoUpdate` while mounted. `gap` overrides the anchor distance;
 *  `matchReferenceWidth` makes the floating element at least as wide as the reference (`size`). */
export function useFeedbackFloating(placement: Placement, gap?: number, matchReferenceWidth = false) {
  return useFloating({
    placement,
    strategy: "fixed",
    middleware: floatingMiddleware(gap, matchReferenceWidth),
    whileElementsMounted: autoUpdate,
  });
}
