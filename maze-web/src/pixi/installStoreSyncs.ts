import { useMazeStore } from "../store/mazeStore";
import { installEdgeMarkerSync } from "./edgeMarkerSync";
import { installLabelFontSync } from "./labelFontSync";

/** Installs the store subscriptions that need the pixi layer (the store itself never imports it).
 *  Called once at startup, after the store module has loaded. */
let installed = false;
export function installStoreSyncs(): void {
  if (installed) return;
  installed = true;
  installEdgeMarkerSync(useMazeStore);
  installLabelFontSync(useMazeStore);
}