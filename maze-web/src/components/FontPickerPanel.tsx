import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SidePanel } from "./SidePanel";
import { Button } from "./Button";
import { InfoIconButton } from "./InfoIconButton";
import { CategoryInfoModal } from "./CategoryInfoModal";
import { Copyright } from "lucide-react";
import { FontLicensesModal } from "./FontLicensesModal";
import { SelectableList, SelectableRow } from "./SelectableList";
import { ui, radius, typography, spacing, font, indent, controlRowHeight } from "../styles/theme";
import { isFontFamilyInstalled, isLocalFontAccessSupported, labelFontCss, loadLocalFontFamilies, rasterFontWeights } from "../pixi/renderers/labelFont";
import { MSDF_FONTS, isMsdfFamily, msdfFontWeights, nearestWeight, type LabelFont } from "../pixi/renderers/fontChoice";
import { fontWeightName } from "../store/fontLabels";
import { SelectRow } from "./SelectRow";
import { Tooltip } from "./Tooltip";
import { MsdfFontPreview } from "./MsdfFontPreview";
import { UnregisteredColorRow } from "./ColorRow";
import { colorToHex, hexToColor } from "./colorFormat";
import { PickerWarningsSection } from "./PickerWarningsSection";
import { useMazeStore } from "../store/mazeStore";
import { computeActiveModeTextOverflowWarnings } from "../pixi/selectors/activeModeWarnings";
import { TEXT_OVERFLOW_WARNING_ID, type TextFitKind } from "../pixi/selectors/exportWarnings";
import { sharedStyles } from "../styles/shared";
import * as m from "~/paraglide/messages";
import type React from "react";

/** The two font categories the picker switches between. The vector list holds the baked MSDF fonts
 *  (`MSDF_FONTS`; the bundled Roboto is the empty family), the raster list holds browser fonts. */
type FontType = "vector" | "raster";

/** Keyboard moves repeat dozens of times a second while an arrow key is held, and every preview
 *  rewrites a store value and rebuilds the canvas labels. The highlight follows each key press at
 *  once, but the canvas preview waits until the moves pause for this long. */
const KEYBOARD_PREVIEW_DELAY_MS = 100;

/** Fixed preview text size in px, independent of the size setting being edited. */
const PREVIEW_FONT_SIZE = 32;

/** Phrase the preview input starts with, the same in every UI language. */
const DEFAULT_PREVIEW_PHRASE = "Lorem ipsum";

/** Preview colors the panel opens with: the project's own input background and primary text, so the
 *  preview matches the panel style. Local to the panel, never stored. */
const DEFAULT_PREVIEW_TEXT_COLOR = hexToColor(ui.text.primary);
const DEFAULT_PREVIEW_BACKGROUND = hexToColor(ui.bg.input);

/** Fixed height of the single-line preview, so the panel layout does not move with the font size. */
const PREVIEW_HEIGHT = 48;

/** The family list never shrinks below this height in px (about six rows), however much room the
 *  other sections take. */
const FAMILY_LIST_MIN_HEIGHT = 150;

/** The vector list: every baked MSDF font. */
const VECTOR_FONTS: { value: string; label: string }[] = Object.entries(MSDF_FONTS).map(([value, { label }]) => ({ value, label }));

/** The weights a font family offers: the baked weights of an MSDF font, the installed faces of a
 *  browser font. */
function weightsOf(family: string): number[] {
  return isMsdfFamily(family) ? msdfFontWeights(family) : rasterFontWeights(family);
}

/** Candidate families for the raster list when the machine's own list is unavailable (permission
 *  denied, unsupported browser, or an empty answer). Common to most systems but not guaranteed, so the
 *  list only shows the ones this machine actually has (`isFontFamilyInstalled`): a family it lacks
 *  would be stored as the font yet render as the bundled Roboto. */
export const WEB_SAFE_FONT_FAMILIES = [
  "Arial", "Arial Black", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console",
  "Palatino Linotype", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
];

interface Props {
  /** Font the field holds now, used to seed the working font on open. */
  font: LabelFont;
  /** Commit handler, called once with the working font on "Apply". */
  onApply: (font: LabelFont) => void;
  /** Dismiss handler, called on "Cancel", the header close button, or Escape. */
  onClose: () => void;
  /** Live-preview handler. Called with the highlighted font on every change, and once with the
   *  open-time font on Cancel / header close / Escape, so the canvas shows the font in context. */
  onPreview?: (font: LabelFont) => void;
  /** Called once on cancel, after the restoring `onPreview` call and before `onClose`. Lets a
   *  linked call site undo the link override a preview tick caused (same contract as the color
   *  picker's `onCancel`). */
  onCancel?: () => void;
  /** Header text, usually the field's row label. */
  title?: string;
  /** The kinds of canvas text the edited font drives (GitHub issue #971). Their text overflow
   *  warnings are shown for the highlighted font in a "Warnings" section; omit for no section. */
  warningKinds?: TextFitKind[];
}

/** Side panel for choosing a label font, the font counterpart of `ColorPickerPanel`. Opens as an
 *  overlay `SidePanel`, holds a working font (family and weight, GitHub issue #973) in local state,
 *  previews each highlighted font live through `onPreview`, and commits through `onApply`. A toggle
 *  switches between the vector (MSDF) and raster lists; up / down arrows move the highlight within
 *  the active list. The weight section offers only the weights the highlighted family has. */
export function FontPickerPanel({ font, onApply, onClose, onPreview, onCancel, title, warningKinds }: Props) {
  // Set when a WebGL canvas cannot be created: the MSDF preview then falls back to DOM text in Roboto.
  const [msdfUnavailable, setMsdfUnavailable] = useState(false);
  const [phrase, setPhrase] = useState(DEFAULT_PREVIEW_PHRASE);
  const [previewTextColor, setPreviewTextColor] = useState(DEFAULT_PREVIEW_TEXT_COLOR);
  const [previewBackground, setPreviewBackground] = useState(DEFAULT_PREVIEW_BACKGROUND);
  const [working, setWorking] = useState(font);
  const [type, setType] = useState<FontType>(isMsdfFamily(font.family) ? "vector" : "raster");
  const [infoOpen, setInfoOpen] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);
  // `undefined` while the local font query is pending, `null` when the browser cannot list fonts.
  // An empty answer is how some browsers report a denied permission, so it counts as unavailable.
  // Set once a "Grant access" attempt still produced no list: the browser has blocked the site, so
  // a second prompt will not appear and the user has to allow it in the site settings.
  const [accessBlocked, setAccessBlocked] = useState(false);
  const [localFamilies, setLocalFamilies] = useState<string[] | null | undefined>(undefined);

  /** The font in effect when the panel opened. Captured once: with live preview the `font`
   *  prop tracks each previewed change, so it cannot be used to restore on Cancel. */
  const originalFont = useRef(font).current;
  const originalFamily = originalFont.family;
  const workingRef = useRef(working);
  workingRef.current = working;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  const pendingPreview = useRef<LabelFont | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
  }, []);

  /** Deliver a queued keyboard preview right away. Apply needs it, since the last previewed font is
   *  what the call site commits when the live stream is the commit. */
  const flushPreview = useCallback(() => {
    if (previewTimer.current !== null) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    if (pendingPreview.current !== null) {
      const next = pendingPreview.current;
      pendingPreview.current = null;
      onPreviewRef.current?.(next);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void loadLocalFontFamilies().then((families) => { if (alive) setLocalFamilies(families); });
    return () => { alive = false; };
  }, []);

  const hasLocalFamilies = !!localFamilies && localFamilies.length > 0;

  const installedWebSafe = useMemo(() => WEB_SAFE_FONT_FAMILIES.filter(isFontFamilyInstalled), []);

  const options = useMemo(() => {
    if (type === "vector") return VECTOR_FONTS;
    // The open-time family stays listed even when the machine does not report it, so a project
    // saved elsewhere still shows its current choice highlighted.
    const families = hasLocalFamilies ? localFamilies : installedWebSafe;
    const extra = !isMsdfFamily(originalFamily) && !families.includes(originalFamily) ? [originalFamily] : [];
    return [...extra, ...families].map((value) => ({ value, label: value }));
  }, [type, hasLocalFamilies, localFamilies, installedWebSafe, originalFamily]);

  const optionValues = useMemo(() => options.map((o) => o.value), [options]);

  function requestAccess() {
    void loadLocalFontFamilies(true).then((families) => {
      setLocalFamilies(families);
      setAccessBlocked(!families || families.length === 0);
    });
  }

  /** Highlight a font and preview it. A click previews at once; a keyboard move is coalesced so a
   *  held arrow key does not rebuild the canvas on every repeat. */
  const select = useCallback((next: LabelFont, delayed = false) => {
    setWorking(next);
    pendingPreview.current = next;
    if (!delayed) {
      flushPreview();
      return;
    }
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(flushPreview, KEYBOARD_PREVIEW_DELAY_MS);
  }, [flushPreview]);

  /** Pick a family. The weight stays when the family has it and snaps to the nearest one it has otherwise. */
  const selectFamily = useCallback((family: string, delayed = false) => {
    const current = workingRef.current;
    select({ family, weight: nearestWeight(current.weight, weightsOf(family)) }, delayed);
  }, [select]);

  function cancel() {
    // Drop a queued preview: the open-time font is restored below regardless.
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    pendingPreview.current = null;
    onPreviewRef.current?.(originalFont);
    onCancel?.();
    onClose();
  }

  function apply() {
    flushPreview();
    onApply(working);
  }

  // Weights of the highlighted family. The local font query (`localFamilies`) is what reveals a browser
  // font's installed faces, so a result arriving later refreshes the list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const weights = useMemo(() => weightsOf(working.family), [working.family, localFamilies]);

  // The select always shows the working weight, even one the family lacks (a project saved elsewhere).
  const weightOptions = useMemo(() => {
    const offered = weights.includes(working.weight) ? weights : [...weights, working.weight].sort((a, b) => a - b);
    return offered.map((weight) => ({ value: String(weight), label: fontWeightName(weight) }));
  }, [weights, working.weight]);

  const weightLocked = weightOptions.length <= 1;

  const showPermissionNote = type === "raster" && localFamilies !== undefined && !hasLocalFamilies;

  // Text overflow warnings of the texts this font drives. The live preview keeps the store on the
  // highlighted font, links included (a Shared style font reaches every linked text), so the export
  // warning pass over the store settings already describes the highlighted font.
  const openMode = useMazeStore((s) => s.openRenderModeSettings);
  const wallsSettings = useMazeStore((s) => s.vectorByWallsSettings);
  const corridorsSettings = useMazeStore((s) => s.vectorByCorridorsSettings);
  const nodes = useMazeStore((s) => s.nodes);
  const edges = useMazeStore((s) => s.edges);
  const floors = useMazeStore((s) => s.floors);
  const floorTopology = useMazeStore((s) => s.floorTopology);
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  const start = useMazeStore((s) => s.start);
  const finish = useMazeStore((s) => s.finish);
  // The call site builds `warningKinds` anew on every render, so the memo keys on its content.
  const warningKindsKey = warningKinds?.join(",");
  const fontWarnings = useMemo(() => {
    if (!warningKindsKey || !openMode || !cfg) return [];
    const ids = new Set(warningKindsKey.split(",").map((kind) => TEXT_OVERFLOW_WARNING_ID[kind as TextFitKind]));
    const settings = openMode === "vector_by_walls" ? wallsSettings : corridorsSettings;
    return computeActiveModeTextOverflowWarnings(openMode, settings, { nodes, edges, floors, floorTopology, cfg, start, finish })
      .filter((warning) => ids.has(warning.id));
  }, [warningKindsKey, openMode, wallsSettings, corridorsSettings, nodes, edges, floors, floorTopology, cfg, start, finish]);

  return (
    <SidePanel title={title ?? m["font_picker.title"]()} onClose={cancel} overlay>
      <div
        style={styles.body}
        tabIndex={-1}
        onKeyDown={(e) => {
          // A dialog opened from here is portaled out of this subtree, but React still bubbles its key
          // events through the component tree: its Escape closes only the dialog, not the panel.
          if (!e.currentTarget.contains(e.target as Node)) return;
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
        }}
      >
        <div style={styles.content}>
          <div style={styles.section}>
            <div style={typography.body}>{m["font_picker.section_preview"]()}</div>
            <div style={styles.sectionBody}>
              <input
                type="text"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder={m["font_picker.preview_input_placeholder"]()}
                style={styles.previewInput}
                data-testid="font-picker-preview-input"
              />
              {isMsdfFamily(working.family) && !msdfUnavailable ? (
                // The MSDF font cannot be shown by the DOM, so it is drawn on a pixi canvas the way
                // the maze canvas draws it.
                <MsdfFontPreview
                  text={phrase}
                  font={working}
                  textColor={previewTextColor}
                  background={previewBackground}
                  fontSize={PREVIEW_FONT_SIZE}
                  style={styles.previewCanvasBox}
                  onUnavailable={() => setMsdfUnavailable(true)}
                  testId="font-picker-preview-msdf"
                />
              ) : (
                <div
                  style={{
                    ...styles.previewText,
                    background: colorToHex(previewBackground),
                    color: colorToHex(previewTextColor),
                  }}
                  data-testid="font-picker-preview-text"
                >
                  {/* The font is set on the text element itself: the global `* { font-family }` rule
                      would override a family inherited from the box. */}
                  <span
                    style={{
                      ...styles.previewLine,
                      fontFamily: isMsdfFamily(working.family) ? "Roboto, sans-serif" : labelFontCss(working.family),
                      fontWeight: working.weight,
                      fontSize: PREVIEW_FONT_SIZE,
                    }}
                    data-testid="font-picker-preview-line"
                  >
                    {phrase}
                  </span>
                </div>
              )}
              <UnregisteredColorRow label={m["font_picker.preview_text_color"]()} color={previewTextColor} onChange={setPreviewTextColor} />
              <UnregisteredColorRow label={m["font_picker.preview_background_color"]()} color={previewBackground} onChange={setPreviewBackground} />
            </div>
          </div>
          <div style={{ ...styles.section, ...styles.familySection }}>
            <div style={styles.familyHeader}>
              <div style={typography.body}>{m["font_picker.section_family"]()}</div>
              <InfoIconButton onClick={() => setInfoOpen(true)} />
              {type === "vector" && (
                // The baked fonts ship under their own licenses (GitHub issue #982); browser fonts are not ours to credit.
                <InfoIconButton onClick={() => setLicensesOpen(true)} symbol={<Copyright size={14} />} label={m["font_licenses.button"]()} />
              )}
            </div>
            <div style={{ ...styles.sectionBody, ...styles.familyBody }}>
              <div style={styles.typeSwitcher}>
                {(["vector", "raster"] as const).map((key) => (
                  <Button key={key} variant={type === key ? "toggle-selected" : "toggle"} onClick={() => setType(key)}>
                    {key === "vector" ? m["font_picker.type_vector"]() : m["font_picker.type_raster"]()}
                  </Button>
                ))}
              </div>
              {localFamilies === undefined && type === "raster" ? (
                <span style={styles.loading}>{m["font_picker.loading"]()}</span>
              ) : (
                <SelectableList
                  // Remount per type so the new list takes keyboard focus (arrow keys keep working
                  // after the toggle button was clicked).
                  key={type}
                  selected={options.some((o) => o.value === working.family) ? working.family : null}
                  values={optionValues}
                  onSelect={(value, source) => selectFamily(value, source === "keyboard")}
                  autoFocus
                  style={styles.list}
                  testId={`font-picker-list-${type}`}
                  footer={showPermissionNote && (
                    // Muted caption note pinned to the bottom of the list body, in the same quiet style
                    // as the embedded hotkey hints (`EmbeddedHotkeyHint`).
                    <div style={styles.permissionNote} data-testid="font-picker-permission-note">
                      <span style={styles.permissionText}>
                        {!isLocalFontAccessSupported()
                          ? m["font_picker.local_fonts_unsupported"]()
                          : accessBlocked ? m["font_picker.local_fonts_blocked"]() : m["font_picker.local_fonts_permission"]()}
                      </span>
                      {isLocalFontAccessSupported() && !accessBlocked && (
                        <Button variant="secondary" layoutStyle={styles.permissionButton} onClick={requestAccess} data-testid="font-picker-grant-access">
                          {m["font_picker.grant_access"]()}
                        </Button>
                      )}
                    </div>
                  )}
                >
                  {options.map((o) => (
                    <SelectableRow key={o.value} value={o.value} selected={o.value === working.family}>{o.label}</SelectableRow>
                  ))}
                </SelectableList>
              )}
            </div>
          </div>
          <div style={styles.section}>
            {/* A disabled select gets no hover events, so the hint wraps the whole row. */}
            <Tooltip content={weightLocked ? m["font_picker.weight_single_hint"]() : undefined} block>
              <SelectRow
                label={m["font_picker.section_weight"]()}
                value={String(working.weight)}
                options={weightOptions}
                onChange={(value) => select({ family: working.family, weight: Number(value) })}
                disabled={weightLocked}
                testId="font-picker-weight"
              />
            </Tooltip>
          </div>
          {warningKinds && openMode && (
            <div style={styles.section}>
              <PickerWarningsSection warnings={fontWarnings} testId="font-picker-export-warnings" />
            </div>
          )}
        </div>
        <div style={styles.footer}>
          <Button variant="secondary" layoutStyle={styles.footerBtn} onClick={cancel}>
            {m["common.cancel"]()}
          </Button>
          <Button variant="primary" layoutStyle={styles.footerBtn} onClick={apply}>
            {m["common.apply"]()}
          </Button>
        </div>
      </div>
      {infoOpen && (
        <CategoryInfoModal
          title={m["font_picker.info_title"]()}
          params={[
            { label: m["font_picker.type_vector"](), description: m["font_picker.info_vector"]() },
            { label: m["font_picker.type_raster"](), description: m["font_picker.info_raster"]() },
          ]}
          onClose={() => setInfoOpen(false)}
        />
      )}
      {licensesOpen && <FontLicensesModal onClose={() => setLicensesOpen(false)} />}
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, outline: "none" },
  content: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
    padding: spacing.sectionGap,
    minHeight: 0,
    // The family list keeps a minimum height (`FAMILY_LIST_MIN_HEIGHT`), so when the other sections
    // (an opened warnings list, a tall preview) leave less room the panel scrolls instead.
    overflowY: "auto",
  },
  section: { display: "flex", flexDirection: "column", gap: spacing.itemGap, flexShrink: 0 },
  sectionBody: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree, minHeight: 0 },
  // The section may shrink to its minimum only: the header row, the type switcher, their gaps and the
  // list's minimum height. `minHeight: auto` cannot express it, it would grow the section to the full list.
  familySection: { flex: 1, minHeight: 2 * controlRowHeight + 2 * spacing.itemGap + FAMILY_LIST_MIN_HEIGHT },
  familyBody: { flex: 1 },
  familyHeader: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  // A flex item needs `minWidth: 0` and its own overflow to be cut with an ellipsis; the text is
  // not selectable, it is only a sample.
  previewLine: { display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.2, userSelect: "none", WebkitUserSelect: "none" },
  previewInput: { ...sharedStyles.input, width: "100%", boxSizing: "border-box" },
  previewCanvasBox: {
    height: PREVIEW_HEIGHT,
    flexShrink: 0,
    boxSizing: "border-box",
    overflow: "hidden",
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
  },
  previewText: {
    height: PREVIEW_HEIGHT,
    flexShrink: 0,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    padding: `0 ${spacing.groupGap}px`,
    overflow: "hidden",
    whiteSpace: "nowrap",
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
  },
  typeSwitcher: { display: "flex", gap: spacing.itemGap, flexShrink: 0 },
  permissionNote: { display: "flex", flexDirection: "column", alignItems: "center", gap: spacing.itemGap },
  permissionText: { ...typography.caption, textAlign: "center" },
  permissionButton: { fontSize: font.sm, padding: "2px 8px" },
  loading: { ...typography.body, color: ui.text.secondary, textAlign: "center" },
  list: { minHeight: FAMILY_LIST_MIN_HEIGHT },
  footer: {
    display: "flex",
    gap: spacing.groupGap,
    padding: spacing.groupGap,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  footerBtn: { flex: 1 },
};
