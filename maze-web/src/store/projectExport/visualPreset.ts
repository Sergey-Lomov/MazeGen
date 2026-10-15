import type { MazeState } from "../mazeStore";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../storeTypes";
import { serializeImageExport, downloadJsonFile } from "./serialize";
import {
  VISUAL_PRESET_KIND,
  VISUAL_PRESET_VERSION,
  VISUAL_PRESET_FILE_EXTENSION,
  QUALITY_PRESET_KIND,
  FileKindMismatchError,
  looksLikeProjectFile,
  type ProjectFileImageExport,
  type VisualPresetFile,
  type VisualPresetImageExport,
} from "./types";
import { assertObject, assertNumber } from "./validatePrimitives";
import { validateImageExport } from "./validateImageExport";

/** Drops the editor-only UI state the preset doesn't carry (see `VisualPresetImageExport`). */
function toPresetImageExport(ie: ProjectFileImageExport): VisualPresetImageExport {
  const {
    openRenderModeSettings: _open,
    vectorByWallsSectionsExpanded: _wallsExpanded,
    vectorByCorridorsSectionsExpanded: _corridorsExpanded,
    ...rest
  } = ie;
  return rest;
}

/** Drops the maze-bound parts of a renderer's settings — floor-label placement keyed by floor id
 *  and per-teleport-group overrides — so a preset carries only the style itself. */
function stripMazeBound<S extends VectorByWallsSettings | VectorByCorridorsSettings>(settings: S): S {
  const { teleportGroupOverrides: _overrides, floorLabel, ...rest } = settings;
  const { positionsByFloorId: _positions, ...floorLabelRest } = floorLabel;
  return { ...rest, floorLabel: floorLabelRest } as S;
}

export function serializeVisualPreset(state: MazeState): VisualPresetFile {
  const ie = toPresetImageExport(serializeImageExport(state));
  return {
    kind: VISUAL_PRESET_KIND,
    version: VISUAL_PRESET_VERSION,
    imageExport: {
      ...ie,
      vectorByWallsSettings: stripMazeBound(ie.vectorByWallsSettings),
      vectorByCorridorsSettings: stripMazeBound(ie.vectorByCorridorsSettings),
    },
  };
}

/** Validates a visual preset file. Missing or unknown fields fall back to defaults through the
 *  same lenient validators the project file's `imageExport` section uses; a project file passed
 *  by mistake raises `FileKindMismatchError`. */
export function parseVisualPreset(raw: unknown): VisualPresetFile {
  const obj = assertObject(raw, "root");
  if (obj.kind !== VISUAL_PRESET_KIND) {
    if (obj.kind === QUALITY_PRESET_KIND) throw new FileKindMismatchError("visual_preset", "quality_preset");
    if (looksLikeProjectFile(obj)) throw new FileKindMismatchError("visual_preset", "project");
    throw new Error("Not a visual preset file");
  }
  const version = assertNumber(obj.version, "version");
  if (version > VISUAL_PRESET_VERSION)
    throw new Error(`Visual preset version ${version} is newer than supported (${VISUAL_PRESET_VERSION})`);
  return {
    kind: VISUAL_PRESET_KIND,
    version: VISUAL_PRESET_VERSION,
    imageExport: toPresetImageExport(validateImageExport(obj.imageExport, "imageExport")),
  };
}

export function downloadVisualPresetFile(state: MazeState): void {
  downloadJsonFile(serializeVisualPreset(state), `maze-visual-preset${VISUAL_PRESET_FILE_EXTENSION}`);
}
