import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { NodeLockKind, InitialGenerationConfig, ElementsConfig } from "../../wasm/types";
import type { PresetConnectionEntry, PresetTeleportEntry } from "../../pixi/fieldEditUtils";
import type { PostEditEdge, PostEditMeta, PostEditTeleportEntry, FeatureId } from "../mazeStore";

export interface ProjectFilePostEdit {
  edges: [string, PostEditEdge][];
  meta: PostEditMeta | null;
  teleports: PostEditTeleportEntry[];
}

export interface ProjectFileAnalytics {
  showMazeOverlay: boolean;
  showComponentsOverlay: boolean;
  showGraphOverlay: boolean;
  showNavGraphOverlay: boolean;
  showPureCyclesOverlay: boolean;
  showRouteOverlay: boolean;
  showRegionClassesOverlay: boolean;
  sectionsExpanded: Record<string, boolean>;
}

export interface ProjectFileDebug {
  debugMode: boolean;
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

/** One active check, inlined inside its owning rule — see GitHub issue #60. `localId` is unique
 * only within this rule's `checks`, not globally; not stable across save/load cycles (see
 * `CheckInstance`'s doc comment in storeTypes.ts) — only uniqueness-at-load-time matters. */
export interface ProjectFileCheckInstance {
  localId: number;
  typeId: string;
  params: Record<string, string>;
  disabled: boolean;
}

/** Mirrors `NestedStrategyState` — see its doc comment in storeTypes.ts. Recursive. */
export interface ProjectFileNestedStrategy {
  slotId: string;
  strategyId: string;
  params: Record<string, string>;
  nested: ProjectFileNestedStrategy[];
}

export interface ProjectFileQcRule {
  id: string;
  name: string;
  kind: string;
  checks: ProjectFileCheckInstance[];
  strategyId: string | null;
  disabled: boolean;
  ruleDisabled: boolean;
  nestedStrategies: ProjectFileNestedStrategy[];
}

/** A named, ordered group of rule ids — see GitHub issue #65 and `RepairStageState`'s doc
 * comment in storeTypes.ts. Flat sibling of `ProjectFileQcRule[]`, nothing computed on load. */
export interface ProjectFileStage {
  id: string;
  name: string;
  ruleIds: string[];
  disabled: boolean;
}

export interface ProjectFile {
  version: number;
  tessellation: { config: TessellationConfig; savedConfigs: TessellationConfig[] };
  generation: {
    seed: number;
    randomSeed: boolean;
    initial: InitialGenerationConfig;
    elements: ElementsConfig;
    qcExperiment: boolean;
    seedHistory: number[];
    seedHistoryIndex: number;
  };
  quality: {
    rules: ProjectFileQcRule[];
    stages: ProjectFileStage[];
    strategyParams: Record<string, Record<string, string>>;
    repairMaxIterations: number | null;
    repairTimeBudgetSecs: number | null;
  };
  presets: {
    connections: [string, PresetConnectionEntry][];
    lockedNodes: [string, NodeLockKind][];
    defaultEdgeState: "undefined" | "wall" | "passage";
    autoLock: boolean;
    start: [number, number] | null;
    finish: [number, number] | null;
    genSource: [number, number] | null;
    teleports: PresetTeleportEntry[];
  };
  postEdit: ProjectFilePostEdit | null;
  dirtyFlags: ProjectFileDirtyFlags;
  analytics: ProjectFileAnalytics;
  debug: ProjectFileDebug;
  ui: ProjectFileUi;
}

export const CURRENT_VERSION = 2;
