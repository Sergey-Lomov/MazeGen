import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SidePanel } from "./SidePanel";
import { Button } from "./Button";
import { InfoIconButton } from "./InfoIconButton";
import { CategoryInfoModal } from "./CategoryInfoModal";
import { SelectableList, SelectableRow } from "./SelectableList";
import { ui, radius, typography, spacing, font, indent } from "../styles/theme";
import { isFontFamilyInstalled, isLocalFontAccessSupported, labelFontCss, loadLocalFontFamilies } from "../pixi/renderers/labelFont";
import { MsdfFontPreview } from "./MsdfFontPreview";
import { UnregisteredColorRow } from "./ColorRow";
import { colorToHex, hexToColor } from "./colorFormat";
import { sharedStyles } from "../styles/shared";
import * as m from "~/paraglide/messages";
import type React from "react";

/** The two font categories the picker switches between. The vector list holds the baked MSDF fonts
 *  (stored as the empty family, see `textFontFamily`), the raster list holds browser fonts. */
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

/** Family value that stands for the bundled MSDF Roboto in every `textFontFamily` field. */
export const VECTOR_FONT_FAMILY = "";

/** The vector list: the single currently available default font. */
const VECTOR_FONTS: { value: string; label: string }[] = [{ value: VECTOR_FONT_FAMILY, label: "Roboto" }];

/** Candidate families for the raster list when the machine's own list is unavailable (permission
 *  denied, unsupported browser, or an empty answer). Common to most systems but not guaranteed, so the
 *  list only shows the ones this machine actually has (`isFontFamilyInstalled`): a family it lacks
 *  would be stored as the font yet render as the bundled Roboto. */
export const WEB_SAFE_FONT_FAMILIES = [
  "Arial", "Arial Black", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console",
  "Palatino Linotype", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
];

interface Props {
  /** Family the field holds now, used to seed the working font on open. */
  family: string;
  /** Commit handler, called once with the working family on "Apply". */
  onApply: (family: string) => void;
  /** Dismiss handler, called on "Cancel", the header close button, or Escape. */
  onClose: () => void;
  /** Live-preview handler. Called with the highlighted family on every change, and once with the
   *  open-time family on Cancel / header close / Escape, so the canvas shows the font in context. */
  onPreview?: (family: string) => void;
  /** Called once on cancel, after the restoring `onPreview` call and before `onClose`. Lets a
   *  linked call site undo the link override a preview tick caused (same contract as the color
   *  picker's `onCancel`). */
  onCancel?: () => void;
  /** Header text, usually the field's row label. */
  title?: string;
}

/** Side panel for choosing a label font, the font counterpart of `ColorPickerPanel`. Opens as an
 *  overlay `SidePanel`, holds a working family in local state, previews each highlighted font live
 *  through `onPreview`, and commits through `onApply`. A toggle switches between the vector (MSDF)
 *  and raster lists; up / down arrows move the highlight within the active list. */
export function FontPickerPanel({ family, onApply, onClose, onPreview, onCancel, title }: Props) {
  // Set when a WebGL canvas cannot be created: the MSDF preview then falls back to DOM text in Roboto.
  const [msdfUnavailable, setMsdfUnavailable] = useState(false);
  const [phrase, setPhrase] = useState(DEFAULT_PREVIEW_PHRASE);
  const [previewTextColor, setPreviewTextColor] = useState(DEFAULT_PREVIEW_TEXT_COLOR);
  const [previewBackground, setPreviewBackground] = useState(DEFAULT_PREVIEW_BACKGROUND);
  const [working, setWorking] = useState(family);
  const [type, setType] = useState<FontType>(family === VECTOR_FONT_FAMILY ? "vector" : "raster");
  const [infoOpen, setInfoOpen] = useState(false);
  // `undefined` while the local font query is pending, `null` when the browser cannot list fonts.
  // An empty answer is how some browsers report a denied permission, so it counts as unavailable.
  // Set once a "Grant access" attempt still produced no list: the browser has blocked the site, so
  // a second prompt will not appear and the user has to allow it in the site settings.
  const [accessBlocked, setAccessBlocked] = useState(false);
  const [localFamilies, setLocalFamilies] = useState<string[] | null | undefined>(undefined);

  /** The family in effect when the panel opened. Captured once: with live preview the `family`
   *  prop tracks each previewed change, so it cannot be used to restore on Cancel. */
  const originalFamily = useRef(family).current;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  const pendingPreview = useRef<string | null>(null);
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
    const extra = originalFamily !== VECTOR_FONT_FAMILY && !families.includes(originalFamily) ? [originalFamily] : [];
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
  const select = useCallback((next: string, delayed = false) => {
    setWorking(next);
    pendingPreview.current = next;
    if (!delayed) {
      flushPreview();
      return;
    }
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(flushPreview, KEYBOARD_PREVIEW_DELAY_MS);
  }, [flushPreview]);

  function cancel() {
    // Drop a queued preview: the open-time font is restored below regardless.
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    pendingPreview.current = null;
    onPreviewRef.current?.(originalFamily);
    onCancel?.();
    onClose();
  }

  function apply() {
    flushPreview();
    onApply(working);
  }

  const showPermissionNote = type === "raster" && localFamilies !== undefined && !hasLocalFamilies;

  return (
    <SidePanel title={title ?? m["font_picker.title"]()} onClose={cancel} overlay>
      <div
        style={styles.body}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); } }}
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
              {working === VECTOR_FONT_FAMILY && !msdfUnavailable ? (
                // The MSDF font cannot be shown by the DOM, so it is drawn on a pixi canvas the way
                // the maze canvas draws it.
                <MsdfFontPreview
                  text={phrase}
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
                      fontFamily: working === VECTOR_FONT_FAMILY ? "Roboto, sans-serif" : labelFontCss(working),
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
                  selected={options.some((o) => o.value === working) ? working : null}
                  values={optionValues}
                  onSelect={(value, source) => select(value, source === "keyboard")}
                  autoFocus
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
                    <SelectableRow key={o.value} value={o.value} selected={o.value === working}>{o.label}</SelectableRow>
                  ))}
                </SelectableList>
              )}
            </div>
          </div>
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
  },
  section: { display: "flex", flexDirection: "column", gap: spacing.itemGap, flexShrink: 0 },
  sectionBody: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree, minHeight: 0 },
  familySection: { flex: 1, minHeight: 0 },
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
  footer: {
    display: "flex",
    gap: spacing.groupGap,
    padding: spacing.groupGap,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  footerBtn: { flex: 1 },
};
