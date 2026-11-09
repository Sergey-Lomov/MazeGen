import type { FieldOpError } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

// Kept apart from `fieldOps.ts` so the print sizing worker, which imports `fieldOps.ts`, does not
// bundle the Paraglide messages (GitHub issue #951).

/// User-facing text of a failed field operation.
export function fieldOpErrorMessage(error: FieldOpError): string {
  switch (error.kind) {
    case "unavailable": return m["field.op_error.unavailable"]();
    case "not_a_symmetry": return m["field.op_error.not_a_symmetry"]();
    case "outside_tessellation": return m["field.op_error.outside_tessellation"]();
    case "invalid_preset": return m["field.op_error.invalid_preset"]({ message: error.message });
    case "invalid_request": return m["field.op_error.invalid_request"]({ message: error.message });
  }
}
