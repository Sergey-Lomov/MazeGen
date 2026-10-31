import { formatTargetLabel } from "../pixi/targetLabel";
import { registerNotificationCode } from "./notificationRegistry";
import { notify } from "./notificationStore";
import * as m from "~/paraglide/messages";

export const SPLIT_BOUNDARY_FACE = "edit_refusal.split_boundary_face";
export const SPLIT_ROTATION_OUTSIDE_FIELD = "edit_refusal.split_rotation_outside_field";
export const SPLIT_FACE_OWNER_AMBIGUOUS = "edit_refusal.split_face_owner_ambiguous";
export const SPLIT_CONNECTION_RESET = "edit_refusal.split_connection_reset";
export const UNCONFIRMED_SPLIT_NODE = "edit_refusal.unconfirmed_split_node";
export const TELEPORT_OUTSIDE_FIELD = "edit_refusal.teleport_outside_field";
export const VERTICAL_PASSAGE_NO_ADJACENT_CELL = "vertical_passage.no_adjacent_cell";
export const VERTICAL_PASSAGE_DRAG_FAILED = "vertical_drag.failed_passage";
export const ELEVATOR_DRAG_FAILED = "vertical_drag.failed_elevator";

registerNotificationCode(SPLIT_BOUNDARY_FACE, { severity: "info", message: () => m[SPLIT_BOUNDARY_FACE]() });
registerNotificationCode(SPLIT_ROTATION_OUTSIDE_FIELD, { severity: "warning", message: () => m[SPLIT_ROTATION_OUTSIDE_FIELD]() });
registerNotificationCode(SPLIT_FACE_OWNER_AMBIGUOUS, { severity: "info", message: () => m[SPLIT_FACE_OWNER_AMBIGUOUS]() });
registerNotificationCode(SPLIT_CONNECTION_RESET, { severity: "info", message: () => m[SPLIT_CONNECTION_RESET]() });
registerNotificationCode(UNCONFIRMED_SPLIT_NODE, { severity: "warning", message: () => m[UNCONFIRMED_SPLIT_NODE]() });
registerNotificationCode(TELEPORT_OUTSIDE_FIELD, { severity: "warning", message: () => m[TELEPORT_OUTSIDE_FIELD]() });
registerNotificationCode(VERTICAL_PASSAGE_NO_ADJACENT_CELL, { severity: "warning", message: () => m[VERTICAL_PASSAGE_NO_ADJACENT_CELL]() });
registerNotificationCode(VERTICAL_PASSAGE_DRAG_FAILED, {
  severity: "warning",
  message: (params) => m[VERTICAL_PASSAGE_DRAG_FAILED]({ coords: params.coords as string }),
  dedupParams: [],
});
registerNotificationCode(ELEVATOR_DRAG_FAILED, {
  severity: "warning",
  message: (params) => m[ELEVATOR_DRAG_FAILED]({ coords: params.coords as string }),
  dedupParams: [],
});

export type EditRefusalSource = "post_edit" | "preset_connections";

export function notifyEditRefusal(source: EditRefusalSource, code: string): void {
  notify({ source, code });
}

export function notifyVerticalPassageUnavailable(source: EditRefusalSource): void {
  notify({ source, code: VERTICAL_PASSAGE_NO_ADJACENT_CELL });
}

export function notifyVerticalDragFailure(
  source: EditRefusalSource,
  entityKind: "vertical_passage" | "elevator",
  point: [number, number],
  level: number,
): void {
  notify({
    source,
    code: entityKind === "elevator" ? ELEVATOR_DRAG_FAILED : VERTICAL_PASSAGE_DRAG_FAILED,
    params: { coords: formatTargetLabel(point, level, true, undefined) },
  });
}
