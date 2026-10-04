import { createContext, useContext } from "react";
import type { ParamDescriptor, ParamLink, ParamModifier, ColorModifier } from "../../store/parameterLinks";

/** Per-render-mode link context (GitHub issue #652 follow-up) — `VectorByWallsSettingsPanel`/
 *  `VectorByCorridorsSettingsPanel` each provide one at their root so every field row underneath
 *  (including deeply nested subsections like `TeleportSettingsSection`/`MarkerIndexSection`) can
 *  render its own `LinkStatusIcon` via `Linked*Row` without threading `links`/`registry`/
 *  `onSetLinkEnabled`/`onAddLink` through every intermediate component's props. Generic over `P`
 *  (that mode's own `ParamPath` union); each panel's own concrete context value is cast to
 *  `LinkContextValue<string>` since a single `createContext` must pick one type parameter. */
export interface LinkContextValue<P extends string> {
  links: ParamLink<P>[];
  registry: Record<P, ParamDescriptor>;
  onSetLinkEnabled: (target: P, enabled: boolean) => void;
  onAddLink: (source: P, target: P, modifiers?: ParamModifier[], colorModifiers?: ColorModifier[]) => void;
  /** Paths currently shown in the settings panel (GitHub issue #670) — passed through to
   *  `LinkEditor` so its Target/Source pickers can hide/mark paths the renderer currently hides
   *  (e.g. teleport fields when the maze has no teleports). */
  activePaths: Set<P>;
}

const LinkContext = createContext<LinkContextValue<string> | null>(null);

export const LinkContextProvider = LinkContext.Provider;

/** Reads the nearest `LinkContextProvider` — throws if a `Linked*Row` is used outside one, since
 *  every call site lives inside `VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel`'s own
 *  subtree, both of which always provide it. */
export function useLinkContext<P extends string>(): LinkContextValue<P> {
  const ctx = useContext(LinkContext);
  if (ctx === null) throw new Error("useLinkContext: no LinkContextProvider in the tree");
  return ctx as unknown as LinkContextValue<P>;
}
