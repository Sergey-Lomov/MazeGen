export * from "./postEditTypes";
export * from "./tessellationTypes";
export * from "./imageExportTypes";
export * from "./qcRuleTypes";
export * from "./presetConnectionsTypes";
export * from "./debugArenaTypes";
export * from "./generationTypes";
export * from "./postEditFullTypes";
export * from "./floorsTypes";

import type { TessellationState, FloorFieldsState, TessellationActions, FloorFieldsActions } from "./tessellationTypes";
import type { PresetConnectionsState, PresetConnectionsActions } from "./presetConnectionsTypes";
import type { GenerationState, GenerationActions } from "./generationTypes";
import type { AnalyticsOverlayState, PostEditState, AnalyticsOverlayActions, PostEditActions } from "./postEditFullTypes";
import type { ImageExportState, ImageExportActions } from "./imageExportTypes";
import type { FloorsState, RootActions, FloorsActions } from "./floorsTypes";

export type MazeState = TessellationState & FloorFieldsState & PresetConnectionsState & GenerationState & AnalyticsOverlayState & PostEditState & ImageExportState & FloorsState;
export type MazeActions = RootActions & TessellationActions & FloorFieldsActions & PresetConnectionsActions & GenerationActions & AnalyticsOverlayActions & PostEditActions & ImageExportActions & FloorsActions;
export type MazeStore = MazeState & MazeActions;
