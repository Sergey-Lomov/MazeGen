import { analyticsTransientUi } from "./slices/analyticsOverlaySlice";
import { floorFieldTransientUi } from "./slices/floorFieldSlice";
import { generationTransientUi } from "./slices/generationSlice";
import { imageExportTransientUi } from "./slices/imageExportSlice";
import { postEditTransientUi } from "./slices/postEditSlice";
import { presetConnectionsTransientUi } from "./slices/presetConnectionsSlice";
import { tessellationTransientUi } from "./slices/tessellationSlice";
import { initialTopologyState } from "./slices/topologySlice";
import type { MazeState } from "./storeTypes";

/** Resting value of every UI mode, pending placement, prompt, hover and open panel (GitHub issue #946).
 * Each slice owns its own part (`<slice>TransientUi`, spread into its initial state), so a new
 * mode is declared next to the state it belongs to; this only composes them. `loadProject`
 * applies the whole object before restoring the saved project's UI, so nothing from the previous
 * session survives. `transientUiState.test.ts` fails on a store key that is neither listed here
 * nor classified as not transient. */
export const TRANSIENT_UI_STATE = {
  ...tessellationTransientUi,
  ...floorFieldTransientUi,
  ...generationTransientUi,
  ...analyticsTransientUi,
  ...presetConnectionsTransientUi,
  ...postEditTransientUi,
  ...imageExportTransientUi,
  ...initialTopologyState,
} satisfies Partial<MazeState>;
