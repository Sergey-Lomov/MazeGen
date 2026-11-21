import type { StoreApi } from "zustand";
import type { MazeStore } from "../store/storeTypes";
import { VECTOR_FONT_FAMILY, convertsToMsdf, isMsdfFamily, type LabelFont } from "../domain/renderers/fontChoice";
import { loadMsdfFamily } from "./renderers/msdfLoader";
import { loadRasterFont, pruneRasterFonts } from "./renderers/rasterFont/rasterMsdf";
import { describeLocalFaces, isManualFontName, knownRasterWeights, restoreUploadedFonts, subscribeRasterFonts } from "./renderers/rasterFont/rasterFontStore";
import { isFontPickerOpen, subscribeFontPicker } from "./renderers/rasterFont/pickerSession";
import { isLocalFontAccessSupported, loadLabelFont, loadLocalFontFamilies } from "./renderers/labelFont";
import {
  closeFontPermissionRequest, getFontPermissionRequest, hasFontPermissionBeenAnswered, openFontPermissionRequest,
  queryLocalFontPermission, resetFontPermissionAnswer, subscribeFontPermissionRequest, type LocalFontPermission,
} from "./renderers/rasterFont/fontPermissionRequest";
import {
  FONT_CODES, clearFontProblemsWithPrefix, reportFontProblemOnce,
} from "../notifications/fontNotifications";
import { buildProjectActivity } from "./selectors/projectActivity";
import type { ExportSettings } from "./selectors/colorFieldRegistry";
import { isSchemaPathActive, schemaEntriesFor, type LinkMode } from "../store/parameterLinkSchema";
import { getParamValue } from "../store/slices/parameterLinksEngine";

/** Fonts found under each settings node. Settings are updated immutably, so a subtree that did
 *  not change keeps its identity and is answered from here: a settings change that touches one slider
 *  re-walks only the path to it, not the whole tree (manual connector paths can be large). */
const fontsUnder = new WeakMap<object, readonly LabelFont[]>();

/** Every distinct `LabelFont` (`{ family, weight }`) inside `value`, a plain, immutably updated
 *  settings tree, keyed `weight|family`. The default font is the empty family. */
export function collectLabelFonts(value: unknown, into: Map<string, LabelFont> = new Map()): Map<string, LabelFont> {
  if (typeof value !== "object" || value === null) return into;
  let found = fontsUnder.get(value);
  if (!found) {
    const { family, weight, msdf } = value as { family?: unknown; weight?: unknown; msdf?: unknown };
    if (typeof family === "string" && typeof weight === "number") {
      found = [msdf === false ? { family, weight, msdf: false } : { family, weight }];
    } else {
      const children = new Map<string, LabelFont>();
      for (const child of Object.values(value)) collectLabelFonts(child, children);
      found = [...children.values()];
    }
    fontsUnder.set(value, found);
  }
  for (const font of found) addFont(into, font);
  return into;
}

function addFont(into: Map<string, LabelFont>, font: LabelFont): void {
  const key = `${font.weight}|${font.family}`;
  // Two texts may name one font with and without conversion: the converting one wins, since its atlas is needed.
  const known = into.get(key);
  if (!known || !convertsToMsdf(known)) into.set(key, font);
}

/** The label font fields a project can draw: every `labelFont` path of the parameter link schema except the
 *  "Shared style" source, which is only copied into the text styles linked to it and draws nothing itself. */
const DRAWN_FONT_PATHS: Record<LinkMode, string[]> = {
  walls: drawnFontPaths("walls"),
  corridors: drawnFontPaths("corridors"),
};

function drawnFontPaths(mode: LinkMode): string[] {
  return schemaEntriesFor(mode).filter(([path, def]) => def.type === "labelFont" && path !== "labelFont").map(([path]) => path);
}

/** Fonts of the texts the project actually draws (GitHub issue #1012): a font field counts only while its
 *  settings row is active, that is while the maze has the element and the settings keep its text on (waypoint
 *  captions off, no teleports, floor labels hidden, ...). A font that a hidden text still names is not used, so it
 *  is neither marked in the font picker nor loaded, converted or reported as unavailable. */
export function collectDrawnLabelFonts(state: MazeStore): Map<string, LabelFont> {
  const fonts = new Map<string, LabelFont>();
  const maze = { nodes: state.nodes ?? [], edges: state.edges ?? [], floors: state.floors ?? [] };
  const modes: [LinkMode, ExportSettings | undefined][] = [["walls", state.vectorByWallsSettings], ["corridors", state.vectorByCorridorsSettings]];
  for (const [mode, settings] of modes) {
    if (!settings) continue;
    const activity = buildProjectActivity(maze, settings.replaceTwoFloorElevatorsWithStairs === true);
    for (const path of DRAWN_FONT_PATHS[mode]) {
      if (!isSchemaPathActive(path, mode, activity, settings)) continue;
      for (const font of collectLabelFonts(getParamValue(settings, path)).values()) addFont(fonts, font);
    }
  }
  return fonts;
}

/** Families of `collectDrawnLabelFonts`. The default font is the empty family. */
export function collectDrawnLabelFontFamilies(state: MazeStore): Set<string> {
  return new Set([...collectDrawnLabelFonts(state).values()].map((font) => font.family));
}

/** Starts the work for the fonts the export settings reference and frees the ones they no longer do. Settings arrive from a
 *  project file, a visual preset, a shared-style link or a picker, and none of those is guaranteed to render a
 *  font row, so the work is tied to the settings themselves: whatever puts a font name into them starts its
 *  download (GitHub issue #982) or its MSDF conversion (GitHub issue #966), and labels switch from the default
 *  font once it lands. A baked family is requested once from here; a failed download falls back to the default
 *  font and is retried by a later pick. A raster font may only be readable once the local font list or the
 *  uploaded fonts arrive, so it is requested again when they change. While a font picker is open the settings
 *  hold previews, which are drawn by canvas text and never converted: the conversion of the font that stays
 *  starts when the picker closes. Dynamic atlases no project text uses are freed (`pruneRasterFonts`). */
export function installLabelFontSync(store: StoreApi<MazeStore>): () => void {
  const requested = new Set<string>();
  let disposed = false;
  /** The uploaded fonts are restored and the installed ones read (or known to be unreadable): only from then on
   *  a font without a source is truly missing and not just not loaded yet. */
  let sourcesSettled = false;
  let permission: LocalFontPermission = "prompt";
  /** Families of project fonts that are not bundled and have no font file at all. A font without MSDF conversion is
   *  drawn by the browser, so it is missing too unless the user named it by hand as an installed one. */
  const missingFamilies = (fonts: Map<string, LabelFont>): string[] => [...new Set(
    [...fonts.values()]
      .filter((font) => font.family !== VECTOR_FONT_FAMILY && !isMsdfFamily(font.family) && knownRasterWeights(font.family).length === 0
        && (convertsToMsdf(font) || !isManualFontName(font.family)))
      .map((font) => font.family.trim()),
  )].sort();
  /** Tells the user about project fonts that cannot be restored: asks for the installed fonts permission when
   *  the browser can still show its prompt, else raises one error for all of them (GitHub issue #974). */
  const reviewAvailability = (fonts: Map<string, LabelFont>, forExport: boolean) => {
    const missing = missingFamilies(fonts);
    if (missing.length === 0) {
      closeFontPermissionRequest(false);
      resetFontPermissionAnswer();
      clearFontProblemsWithPrefix(UNAVAILABLE_PREFIX);
      return;
    }
    if (permission === "prompt" && !hasFontPermissionBeenAnswered(missing) && !forExport) {
      clearFontProblemsWithPrefix(UNAVAILABLE_PREFIX);
      openFontPermissionRequest(missing);
      return;
    }
    closeFontPermissionRequest(false);
    // A dialog dismissed without granting leaves the state at `prompt`: access is still missing, not the fonts.
    const denied = permission === "denied" || permission === "prompt";
    const key = `${UNAVAILABLE_PREFIX}${denied ? "denied" : "missing"}|${missing.join("\n")}`;
    // An error for an earlier set of missing fonts no longer holds.
    clearFontProblemsWithPrefix(UNAVAILABLE_PREFIX, key);
    reportFontProblemOnce(
      key,
      denied ? FONT_CODES.permissionDenied : FONT_CODES.unavailable,
      { fonts: missing.join(", ") },
      missing.map(describeLocalFaces).join("\n"),
    );
  };
  const request = (state: MazeStore, forExport = false) => {
    const previewing = isFontPickerOpen();
    const fonts = collectDrawnLabelFonts(state);
    for (const font of fonts.values()) {
      if (font.family === VECTOR_FONT_FAMILY) continue;
      if (isMsdfFamily(font.family)) {
        if (requested.has(font.family)) continue;
        requested.add(font.family);
        void loadMsdfFamily(font.family);
      } else if (!previewing) {
        // A font without conversion is drawn by canvas text once its browser face has loaded; nothing else loads it
        // for a project that just opened. A face that arrives later (an upload) re-runs this through
        // `subscribeRasterFonts`, and the load announces itself with `LABEL_FONT_LOADED_EVENT` so the labels redraw.
        if (convertsToMsdf(font)) void loadRasterFont(font);
        else void loadLabelFont(font);
      }
    }
    if (!previewing) pruneRasterFonts(new Set([...fonts].filter(([, font]) => convertsToMsdf(font)).map(([key]) => key)));
    if (sourcesSettled && !previewing) reviewAvailability(fonts, forExport);
  };
  recheckProjectFonts = (state) => request(state, true);
  const unsubscribeStore = store.subscribe((state, prev) => {
    // Whether a text is drawn depends on the maze too (teleports, elevators, floors), not only on the settings.
    if (
      state.vectorByWallsSettings === prev.vectorByWallsSettings
      && state.vectorByCorridorsSettings === prev.vectorByCorridorsSettings
      && state.nodes === prev.nodes
      && state.edges === prev.edges
      && state.floors === prev.floors
    ) return;
    request(state);
  });
  // A project font may be an uploaded one from an earlier session, or an installed one the machine reports
  // only once the user grants the permission: request again when the sources change.
  let running = false;
  const refresh = () => {
    if (running || disposed) return;
    running = true;
    try { request(store.getState()); } finally { running = false; }
  };
  const unsubscribes = [
    subscribeRasterFonts(refresh),
    subscribeFontPicker(refresh),
    // The dialog was answered: read the permission again (the browser prompt may have granted it) and review.
    subscribeFontPermissionRequest(() => {
      if (disposed || getFontPermissionRequest().open) return;
      void queryLocalFontPermission(isLocalFontAccessSupported()).then((state) => { permission = state === "unknown" ? "prompt" : state; refresh(); });
    }),
  ];
  void (async () => {
    await restoreUploadedFonts();
    permission = await queryLocalFontPermission(isLocalFontAccessSupported());
    if (permission === "granted" || permission === "unknown") {
      // A browser that cannot report the state may still have given access, so a list that loads proves it. A query
      // refused for a passing reason (a background tab) is tried once more when the page is visible, before the
      // dialog asks for a permission that is already given. (An undecided `prompt` is never queried here: without a
      // click the browser refuses, and a query inside a fresh click would show its own prompt past the dialog.)
      let families = await loadLocalFontFamilies();
      if (families === null && permission === "granted") {
        await untilPageVisible();
        families = await loadLocalFontFamilies(true);
      }
      // A granted permission whose query still fails (the browser wants a user gesture) is not a settled source:
      // the dialog asks again, and its button supplies the gesture.
      permission = families === null ? "prompt" : "granted";
    }
    sourcesSettled = true;
    refresh();
  })();
  request(store.getState());
  return () => {
    disposed = true;
    recheckProjectFonts = null;
    unsubscribeStore();
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** Resolves once the page is visible: a background tab may refuse the font list query that a visible one answers. */
function untilPageVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

const UNAVAILABLE_PREFIX = "unavailable|";

let recheckProjectFonts: ((state: MazeStore) => void) | null = null;

/** Raises the toasts for project fonts that cannot be drawn from their own atlas again, without asking for a
 *  permission (an export is not the place for a dialog). The export calls it so a font still unavailable is
 *  never exported as Roboto silently. */
export function reportProjectFontProblems(state: MazeStore): void {
  clearFontProblemsWithPrefix(UNAVAILABLE_PREFIX);
  recheckProjectFonts?.(state);
}
