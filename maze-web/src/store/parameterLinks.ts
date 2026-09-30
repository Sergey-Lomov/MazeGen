/** Family of a linkable parameter — constrains which parameters can be linked to one another (only
 *  same-type pairs) and, in the future, which kinds of `Modifier` are valid for a link of this type
 *  (#645/#647). Extend as new parameter shapes appear. */
export type ParamType = "number" | "color" | "cornerStyle" | "join";

/** Registry entry for one linkable parameter — the single source of truth for its type and value
 *  equality, instead of scattered `!==` comparisons across the engine. `equals` defaults to
 *  `Object.is`; a parameter with an object value (a future #647 color-as-object) overrides it here,
 *  not in the engine. */
export interface ParamDescriptor {
  type: ParamType;
  equals: (a: unknown, b: unknown) => boolean;
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
