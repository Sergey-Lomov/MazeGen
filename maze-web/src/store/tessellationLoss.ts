import type { MazeState } from "./mazeStore";
import { splitPatternsFor } from "../domain/shapeTemplates";
import { qcForTessellation } from "./slices/qcTessellationFilter";
import { sameTessellationSettings } from "./storeHelpers";

// Data-loss confirmation predicate (see maze-web/CLAUDE.md, Data-loss confirmation dialogs).

/** True when confirming tessellation would destroy data the user has entered. A settings change
 * (kind, params, orientation) resets every floor's own field config (Specs/field-editor.md), so
 * any floor being dirty counts. */
export function selectTessellationWouldLoseData(s: Pick<MazeState,
  "previewKind" | "previewParams" | "tessellationKind" | "tessellationParams" | "floorFields"
  | "previewHexOrientation" | "previewTriOrientation" | "hexOrientation" | "triOrientation" | "presetsDirty" | "mazeDirty" | "postEditDirty"
  | "previewFieldConfig" | "splitPatterns" | "rules" | "availableChecks" | "availableStrategies" | "availableRuleParams"
>): boolean {
  // Any settings change (kind, params, orientation) resets the fields and presets.
  if (!sameTessellationSettings(
    { tessellation: { kind: s.previewKind, params: s.previewParams }, hexOrientation: s.previewHexOrientation, triOrientation: s.previewTriOrientation },
    { tessellation: { kind: s.tessellationKind, params: s.tessellationParams }, hexOrientation: s.hexOrientation, triOrientation: s.triOrientation },
  )) {
    const anyFieldDirty = Object.values(s.floorFields).some((f) => f.fieldDirty);
    if (anyFieldDirty || s.presetsDirty || s.mazeDirty || s.postEditDirty) return true;
  }
  // Split patterns survive only when the new tessellation config provides their shape template
  // (GitHub issue #758) — checked on any config change, not just a kind change.
  const tessellation = s.previewFieldConfig.tessellation;
  if (splitPatternsFor(s.splitPatterns, tessellation).length !== s.splitPatterns.length) return true;
  const qc = qcForTessellation(s, tessellation);
  return qc.rules !== s.rules;
}
