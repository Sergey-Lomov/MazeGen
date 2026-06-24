import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { NodeLockKind, InitialGenerationConfig, ElementsConfig } from "../../wasm/types";
import type { PresetConnectionEntry } from "../../pixi/presetConnectionsUtils";
import type { PostEditEdge, PostEditMeta, FeatureId } from "../mazeStore";

export interface ProjectFilePostEdit {
  edges: [string, PostEditEdge][];
  meta: PostEditMeta | null;
}

export interface ProjectFileAnalytics {
  showMazeOverlay: boolean;
  showComponentsOverlay: boolean;
  showGraphOverlay: boolean;
  showNavGraphOverlay: boolean;
  showRouteOverlay: boolean;
}

export interface ProjectFileDebug {
  debugMode: boolean;
  showDebugFrontier: boolean;
  debugStep: number;
  debugAutoPlayDelay: number;
}

export interface ProjectFileUi {
  showPresetOrigin: boolean;
  showFieldOrigin: boolean;
  openCard: FeatureId;
  postEditAutoConfirm: boolean;
}

export interface ProjectFileDirtyFlags {
  postEdit: boolean;
  field: boolean;
  presets: boolean;
  maze: boolean;
}

export interface ProjectFile {
  version: number;
  tessellation: { config: TessellationConfig; savedConfigs: TessellationConfig[] };
  generation: {
    seed: number;
    randomSeed: boolean;
    initial: InitialGenerationConfig;
    elements: ElementsConfig;
  };
  quality: {
    selectedChecks: string[];
    rules: { id: string; name: string; kind: string; checks: string[]; strategyId: string | null; disabled: boolean; ruleDisabled: boolean }[];
    checkParams: Record<string, Record<string, string>>;
    strategyParams: Record<string, Record<string, string>>;
  };
  presets: {
    connections: [string, PresetConnectionEntry][];
    lockedNodes: [string, NodeLockKind][];
    defaultEdgeState: "undefined" | "wall" | "passage";
    autoLock: boolean;
    start: [number, number] | null;
    finish: [number, number] | null;
    genSource: [number, number] | null;
  };
  postEdit: ProjectFilePostEdit | null;
  dirtyFlags: ProjectFileDirtyFlags;
  analytics: ProjectFileAnalytics;
  debug: ProjectFileDebug;
  ui: ProjectFileUi;
}

export const CURRENT_VERSION = 1;
