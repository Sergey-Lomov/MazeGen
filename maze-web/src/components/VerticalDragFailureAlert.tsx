import { AlertModal } from "./AlertModal";
import { formatTargetLabel } from "../pixi/targetLabel";
import * as m from "~/paraglide/messages";

export interface VerticalDragFailure {
  entityKind: "vertical_passage" | "elevator";
  point: [number, number];
  level: number;
}

interface Props {
  failure: VerticalDragFailure;
  onClose: () => void;
}

/** Shared alert presentation for rejected vertical-passage/elevator drags. */
export function VerticalDragFailureAlert({ failure, onClose }: Props) {
  const coords = formatTargetLabel(failure.point, failure.level, true, undefined);
  return (
    <AlertModal
      title={m["vertical_drag.dialog_title"]()}
      message={failure.entityKind === "elevator"
        ? m["vertical_drag.failed_elevator"]({ coords })
        : m["vertical_drag.failed_passage"]({ coords })}
      onClose={onClose}
    />
  );
}
