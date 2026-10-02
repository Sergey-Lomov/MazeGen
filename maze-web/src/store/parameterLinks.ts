/** Family of a linkable parameter — constrains which parameters can be linked to one another (only
 *  same-type pairs) and, in the future, which kinds of `Modifier` are valid for a link of this type
 *  (#645/#647). Extend as new parameter shapes appear. `markerShape`/`verticalArrowStyle`/
 *  `indexLabelStyle`/`labelFontWeight` are each a small string enum reused by multiple settings
 *  fields across both render modes (same underlying TS type and value set) — split out from a
 *  generic catch-all so each gets its own localized `format` instead of showing a raw enum string.
 *  `boolean` covers plain on/off toggles. */
export type ParamType = "number" | "color" | "cornerStyle" | "markerShape" | "verticalArrowStyle" | "indexLabelStyle" | "labelFontWeight" | "boolean";

/** Registry entry for one linkable parameter — the single source of truth for its type, value
 *  equality, display label, and settings-panel location, instead of scattered `!==` comparisons /
 *  hardcoded strings across the engine and UI. `equals` defaults to `Object.is`; a parameter with an
 *  object value (a future #647 color-as-object) overrides it here, not in the engine. `label` is a
 *  resolved display string (the caller passes an already-translated message), used by the
 *  parameter-links management dialog (GitHub issue #644) to list a path in human-readable form.
 *  `group` mirrors that same path's location in the settings panel itself (e.g. `["Markers",
 *  "Start"]` for `startMarker.size`, matching that panel's own "Markers" section > "Start" sub-
 *  group) — the dialog nests its own collapsible tree by this path instead of listing every
 *  linkable field flat, so a user finds a field where they'd expect it (same section/subsection
 *  names as the panel). An empty array means "no section" — listed at the dialog's own top level,
 *  outside any group; every current entry has a non-empty `group`, including the four "Shared
 *  style" source fields. `format` renders a raw value the same way the settings panel itself
 *  displays it (e.g. `"round"` → "Скругление"), used by the parameter-links dialog's current-value
 *  line; defaults to `String(v)` for plain numbers. */
export interface ParamDescriptor {
  type: ParamType;
  equals: (a: unknown, b: unknown) => boolean;
  label: string;
  group: string[];
  format: (value: unknown) => string;
}

/** One parameter-to-parameter link. Parameterized by `P` (a per-mode path union) so `source`/
 *  `target` are checked by the compiler against a concrete mode's real paths, not an arbitrary
 *  string. `enabled: false` means `target` currently carries a manually-set value and does NOT
 *  follow `source` — the same state the old "Shared style" mechanism called "override"; a single
 *  flag, since `target` has at most one incoming link (guaranteed by `validateLinkGraph`). Flipping
 *  it back to `true` does not by itself resync the value — the caller (see `setLinkEnabledByTarget`)
 *  does that, by re-applying `source`. */
export interface ParamLink<P extends string = string> {
  id: string;
  source: P;
  target: P;
  enabled: boolean;
}
