import type { TessellationConfig } from "../../fieldConfig";
import { getTessellationTraits, type TessellationTraits } from "../../wasm/mazeService";
import type { CheckDescriptor, TessellationRequirement } from "../../wasm/types";

/** Why a check cannot be picked on the current tessellation (GitHub issue #1008) — one reason per
 *  `TessellationRequirement` kind. The UI shows the check disabled with `resolveUnavailableReason`'s
 *  tooltip. */
export type UnavailableReason =
  | { type: "irregular_tessellation" }
  | { type: "cell_sides_exceed"; max: number };

/** The first requirement `traits` fails, as a reason; `null` when the check is available (also when
 *  it declares no requirements). The single interpreter of `TessellationRequirement`: a new
 *  requirement is a new arm here and in the wasm enum, not a bespoke check at a call site. */
export function unavailableReason(
  requires: readonly TessellationRequirement[] | undefined,
  traits: TessellationTraits,
): UnavailableReason | null {
  for (const requirement of requires ?? []) {
    switch (requirement.type) {
      case "regular_cells":
        if (traits.irregular) return { type: "irregular_tessellation" };
        break;
      case "max_cell_sides":
        if (traits.maxCellSides > requirement.max) return { type: "cell_sides_exceed", max: requirement.max };
        break;
    }
  }
  return null;
}

const traitsCache = new Map<string, TessellationTraits>();

/** Traits of `tessellation`, asked from core once per config (a config fully identifies the built
 *  instance, same key `shapeKeysOf` uses). */
export function tessellationTraitsOf(tessellation: TessellationConfig): TessellationTraits {
  const key = JSON.stringify(tessellation);
  let traits = traitsCache.get(key);
  if (traits === undefined) {
    traits = getTessellationTraits(tessellation);
    traitsCache.set(key, traits);
  }
  return traits;
}

/** The reason `check` is out of reach on `tessellation`, `null` when it is available. Runs inside
 *  selectors and store updates, so a config core rejects (a half-edited preview) is logged and read
 *  as "available" instead of throwing; generation reports such a config itself. */
export function checkUnavailableReason(
  check: Pick<CheckDescriptor, "requires">,
  tessellation: TessellationConfig,
): UnavailableReason | null {
  if (!check.requires?.length) return null;
  try {
    return unavailableReason(check.requires, tessellationTraitsOf(tessellation));
  } catch (error) {
    console.error("Tessellation traits unavailable", error);
    return null;
  }
}
