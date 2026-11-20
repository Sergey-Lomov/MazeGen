import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { checkUnavailableReason, type UnavailableReason } from "./checkAvailability";
import type { CheckDescriptor } from "../../wasm/types";

/** Availability of checks on the maze's current (applied) tessellation: returns each check's
 *  `UnavailableReason`, `null` when it can be picked. */
export function useCheckAvailability(): (check: Pick<CheckDescriptor, "requires">) => UnavailableReason | null {
  const kind = useMazeStore((s) => s.tessellationKind);
  const params = useMazeStore((s) => s.tessellationParams);
  return useMemo(
    () => (check) => checkUnavailableReason(check, { kind, params }),
    [kind, params],
  );
}
