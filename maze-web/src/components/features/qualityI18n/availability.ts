import * as m from "~/paraglide/messages";
import type { UnavailableReason } from "../checkAvailability";

/** Tooltip text of a check that is out of reach on the current tessellation (GitHub issue #1008). */
export function resolveUnavailableReason(reason: UnavailableReason): string {
  switch (reason.type) {
    case "irregular_tessellation":
      return m["quality.unavailable_irregular_tessellation"]();
    case "cell_sides_exceed":
      return m["quality.unavailable_cell_sides_exceed"]({ max: reason.max });
  }
}
