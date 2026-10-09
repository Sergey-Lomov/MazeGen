import { createContext, useContext, type ReactNode } from "react";
import type { ColorVisibilityContext as ColorVisibility } from "../pixi/selectors/projectColorsSelector";
import { isLayoutGateOpen, type LayoutGateKey } from "../pixi/selectors/colorFieldRegistry";

/** The export panel's {@link ColorVisibility} (GitHub issue #717), provided once at each panel's root.
 *  `ColorRow` reads it so a color row's enabled state comes from the field registry's visibility
 *  predicate — a call site cannot decide on its own whether a color is currently in play. `null`
 *  outside an export panel (every row then stays enabled). */
const Ctx = createContext<ColorVisibility | null>(null);

export const ColorVisibilityProvider = Ctx.Provider;

export function useColorVisibility(): ColorVisibility | null {
  return useContext(Ctx);
}

/** Renders `children` only while the registry's layout gate is open (see `LAYOUT_GATES`). The one
 *  way a panel hides a block of color rows by layout state — no hand-written `settings.*`
 *  condition. Outside an export panel there is no context and the block stays shown. */
export function LayoutGate({ gate, children }: { gate: LayoutGateKey; children: ReactNode }) {
  const ctx = useColorVisibility();
  return ctx === null || isLayoutGateOpen(gate, ctx) ? <>{children}</> : null;
}
