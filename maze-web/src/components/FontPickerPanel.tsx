import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SidePanel } from "./SidePanel";
import { Button } from "./Button";
import { InfoIconButton } from "./InfoIconButton";
import { CategoryInfoModal } from "./CategoryInfoModal";
import { CircleCheck, Copyright, Languages } from "lucide-react";
import { Bubble, type BubbleColors } from "./Bubble";
import { FontLicensesModal } from "./FontLicensesModal";
import { findFontNotice, type FontNotice } from "./fontLicenses";
import { LOCALE_FONT_SCRIPT, fontSupportsScript } from "./fontLocaleSupport";
import { useLocale } from "../i18n/useLocale";
import { collectLabelFontFamilies, projectFontSettings } from "../store/labelFontSync";
import { SelectableList, SelectableRow } from "./SelectableList";
import { muted, ui, radius, typography, spacing, font, indent, controlRowHeight } from "../styles/theme";
import { isFontFamilyInstalled, isLocalFontAccessSupported, labelFontCss, loadLocalFontFamilies, rasterFontWeights } from "../pixi/renderers/labelFont";
import { MSDF_FONTS, isMsdfFamily, msdfFontWeights, nearestWeight, type FontScript, type LabelFont } from "../pixi/renderers/fontChoice";
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

/** How a font is drawn: a baked MSDF font (`MSDF_FONTS`; the bundled Roboto is the empty family) or an
 *  installed TTF/OTF font drawn by the browser. */
type FontFormat = "msdf" | "browser";

/** One row of the font list (GitHub issue #984). */
interface FontEntry {
  value: string;
  label: string;
  format: FontFormat;
  /** Named by a font of the project's export settings when the panel opened. */
  used: boolean;
  /** Draws the script of the current locale; always `true` when the locale needs only Latin. */
  supportsLocale: boolean;
}

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

/** Opacity of a filter chip that is off. */
const INACTIVE_CHIP_OPACITY = 0.45;

/** The format bubble of a row and of its filter chip: the same label, hue and hint in both places. */
const FORMAT_BUBBLE: Record<FontFormat, { colors: BubbleColors; label: () => string; hint: () => string }> = {
  msdf: { colors: ui.fontFormat.msdf, label: () => m["font_picker.badge_msdf"](), hint: () => m["font_picker.badge_msdf_hint"]() },
  browser: { colors: ui.fontFormat.vec, label: () => m["font_picker.badge_vec"](), hint: () => m["font_picker.badge_vec_hint"]() },
};

/** Colors of an icon chip, on and off; the format chips dim their own hue instead. */
const ICON_CHIP_ON: BubbleColors = { bg: ui.bg.hover, text: ui.text.primary };
const ICON_CHIP_OFF: BubbleColors = { bg: "transparent", text: ui.text.secondary };

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
 *  previews each highlighted font live through `onPreview`, and commits through `onApply`. One list
 *  holds every font, narrowed by a search field and filters; up / down arrows move the highlight within
 *  the visible fonts. The weight section offers only the weights the highlighted family has. */
export function FontPickerPanel({ font, onApply, onClose, onPreview, onCancel, title, warningKinds }: Props) {
  // Set when a WebGL canvas cannot be created: the MSDF preview then falls back to DOM text in Roboto.
  const [msdfUnavailable, setMsdfUnavailable] = useState(false);
  const [phrase, setPhrase] = useState(DEFAULT_PREVIEW_PHRASE);
  const [previewTextColor, setPreviewTextColor] = useState(DEFAULT_PREVIEW_TEXT_COLOR);
  const [previewBackground, setPreviewBackground] = useState(DEFAULT_PREVIEW_BACKGROUND);
  const [working, setWorking] = useState(font);
  const [infoOpen, setInfoOpen] = useState(false);
  const [licenseNotice, setLicenseNotice] = useState<FontNotice | null>(null);
  const [query, setQuery] = useState("");
  // At most one format is filtered: picking one drops the other, and picking it again shows both.
  const [formatFilter, setFormatFilter] = useState<FontFormat | null>(null);
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [onlySupported, setOnlySupported] = useState(false);
  const { locale } = useLocale();
  const localeScript = LOCALE_FONT_SCRIPT[locale];
  // Fonts of the project as the panel opened: the live preview keeps the store on the highlighted
  // font, so reading it later would mark every font that was merely browsed as used.
  const usedFamilies = useRef(collectLabelFontFamilies(projectFontSettings(useMazeStore.getState()))).current;
  const listWrapRef = useRef<HTMLDivElement>(null);
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

  const entries = useMemo<FontEntry[]>(() => {
    // The open-time family stays listed even when the machine does not report it, so a project
    // saved elsewhere still shows its current choice highlighted.
    const families = hasLocalFamilies ? localFamilies : installedWebSafe;
    const extra = !isMsdfFamily(originalFamily) && !families.includes(originalFamily) ? [originalFamily] : [];
    const entry = (value: string, label: string, format: FontFormat): FontEntry => ({
      value,
      label,
      format,
      used: usedFamilies.has(value),
      supportsLocale: localeScript === null || fontSupportsScript(value, localeScript),
    });
    return [
      ...Object.entries(MSDF_FONTS).map(([value, { label }]) => entry(value, label, "msdf")),
      ...[...extra, ...families].map((value) => entry(value, value, "browser")),
    ];
  }, [hasLocalFamilies, localFamilies, installedWebSafe, originalFamily, usedFamilies, localeScript]);

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((e) => (formatFilter === null || e.format === formatFilter)
      && (!onlyUsed || e.used)
      && (!onlySupported || e.supportsLocale)
      && (needle === "" || e.label.toLowerCase().includes(needle)));
  }, [entries, query, formatFilter, onlyUsed, onlySupported]);

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

  // The bundled fonts need no permission, so the note is only about the part of the list it affects.
  const showPermissionNote = localFamilies !== undefined && !hasLocalFamilies && formatFilter !== "msdf";

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
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); return; }
          // "I" on the list opens the notice of the highlighted font: the row's icon is not a tab stop,
          // since focus stays on the list.
          if (e.key.toLowerCase() === "i" && !e.ctrlKey && !e.metaKey && !e.altKey && (e.target as HTMLElement).getAttribute("role") === "listbox") {
            const notice = findFontNotice(workingRef.current.family);
            if (notice) { e.preventDefault(); setLicenseNotice(notice); }
          }
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
            </div>
            <div style={{ ...styles.sectionBody, ...styles.familyBody }}>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Down hands the keyboard to the list, which then walks the fonts the search left.
                  if (e.key !== "ArrowDown") return;
                  e.preventDefault();
                  listWrapRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
                }}
                placeholder={m["font_picker.search_placeholder"]()}
                aria-label={m["font_picker.search_placeholder"]()}
                style={styles.searchInput}
                data-testid="font-picker-search"
              />
              <div style={styles.filters} data-testid="font-picker-filters">
                {(["msdf", "browser"] as const).map((format) => (
                  <FilterChip
                    key={format}
                    active={formatFilter === format}
                    colors={FORMAT_BUBBLE[format].colors}
                    label={FORMAT_BUBBLE[format].hint()}
                    onClick={() => setFormatFilter(formatFilter === format ? null : format)}
                    testId={`font-picker-filter-${format === "msdf" ? "msdf" : "vec"}`}
                  >
                    {FORMAT_BUBBLE[format].label()}
                  </FilterChip>
                ))}
                <FilterChip
                  active={onlyUsed}
                  colors={onlyUsed ? ICON_CHIP_ON : ICON_CHIP_OFF}
                  label={m["font_picker.badge_used"]()}
                  onClick={() => setOnlyUsed(!onlyUsed)}
                  testId="font-picker-filter-used"
                >
                  <CircleCheck size={14} />
                </FilterChip>
                {localeScript !== null && (
                  <FilterChip
                    active={onlySupported}
                    colors={onlySupported ? ICON_CHIP_ON : ICON_CHIP_OFF}
                    label={m["font_picker.filter_locale"]()}
                    onClick={() => setOnlySupported(!onlySupported)}
                    testId="font-picker-filter-locale"
                  >
                    <Languages size={14} />
                  </FilterChip>
                )}
              </div>
              <div ref={listWrapRef} style={styles.listWrap}>
                <SelectableList
                  selected={options.some((o) => o.value === working.family) ? working.family : null}
                  values={optionValues}
                  onSelect={(value, source) => selectFamily(value, source === "keyboard")}
                  autoFocus
                  style={styles.list}
                  testId="font-picker-list"
                  ariaLabel={m["font_picker.section_family"]()}
                  centerFooter={options.length === 0}
                  footer={(localFamilies === undefined || showPermissionNote || options.length === 0) && (
                    // Muted notes in the quiet style of the embedded hotkey hints (`EmbeddedHotkeyHint`): pinned to
                    // the bottom of the list body, or centered in it when no font is left to list.
                    <div style={styles.permissionNote}>
                      {localFamilies === undefined && <span style={styles.permissionText} data-testid="font-picker-loading">{m["font_picker.loading"]()}</span>}
                      {options.length === 0 && <span style={styles.permissionText} data-testid="font-picker-empty">{m["font_picker.no_matches"]()}</span>}
                      {showPermissionNote && (
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
                    </div>
                  )}
                >
                  {options.map((o) => (
                    <FontOption
                      key={o.value}
                      entry={o}
                      selected={o.value === working.family}
                      localeScript={localeScript}
                      onShowLicense={setLicenseNotice}
                    />
                  ))}
                </SelectableList>
              </div>
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
      {licenseNotice && <FontLicensesModal notice={licenseNotice} onClose={() => setLicenseNotice(null)} />}
    </SidePanel>
  );
}

/** A compact toggle of the filter row: a `Bubble`, so it matches the indicators of the rows it filters by. An
 *  inactive chip is dimmed. */
function FilterChip({ active, colors, label, onClick, testId, children }: {
  active: boolean;
  colors: BubbleColors;
  label: string;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label} focusable={false}>
      <button type="button" aria-pressed={active} aria-label={label} onClick={onClick} style={styles.chipButton} data-testid={testId}>
        <Bubble interactive colors={colors} style={{ ...styles.chip, ...styles.filterChip, opacity: active ? 1 : INACTIVE_CHIP_OPACITY }}>{children}</Bubble>
      </button>
    </Tooltip>
  );
}

/** One font row: the name, then the indicators (in project, locale support, the copyright icon of a bundled
 *  font) and the format bubble last. Memoized (the row inside is too), so moving the highlight re-renders only
 *  the two rows whose selection changed. */
const FontOption = memo(function FontOption({ entry, selected, localeScript, onShowLicense }: {
  entry: FontEntry;
  selected: boolean;
  localeScript: FontScript | null;
  onShowLicense: (notice: FontNotice) => void;
}) {
  const notice = entry.format === "msdf" ? findFontNotice(entry.value) : undefined;
  const format = FORMAT_BUBBLE[entry.format];
  return (
    <SelectableRow
      value={entry.value}
      selected={selected}
      trailing={(
        <span style={styles.badges}>
          {entry.used && (
            <Tooltip content={m["font_picker.badge_used"]()} focusable={false}>
              <span style={styles.statusIcon} role="img" aria-label={m["font_picker.badge_used"]()} data-testid="font-badge-used">
                <CircleCheck size={14} />
              </span>
            </Tooltip>
          )}
          {localeScript !== null && entry.supportsLocale && (
            <Tooltip content={m["font_picker.filter_locale"]()} focusable={false}>
              <span style={styles.statusIcon} role="img" aria-label={m["font_picker.filter_locale"]()} data-testid="font-badge-locale">
                <Languages size={14} />
              </span>
            </Tooltip>
          )}
          {notice && (
            <Tooltip content={m["font_licenses.tooltip"]()} focusable={false}>
              <InfoIconButton
                inList
                hoverable={false}
                symbol={<Copyright size={14} />}
                label={m["font_licenses.button"]({ font: entry.label })}
                onClick={() => onShowLicense(notice)}
              />
            </Tooltip>
          )}
          <Tooltip content={format.hint()} focusable={false}>
            <Bubble colors={format.colors} style={styles.chip} data-testid="font-badge-format">{format.label()}</Bubble>
          </Tooltip>
        </span>
      )}
    >
      {entry.label}
    </SelectableRow>
  );
});

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
  // The section may shrink to its minimum only: the header row, the search field, the filters (about two rows), their gaps and the
  // list's minimum height. `minHeight: auto` cannot express it, it would grow the section to the full list.
  familySection: { flex: 1, minHeight: 4 * controlRowHeight + 4 * spacing.itemGap + FAMILY_LIST_MIN_HEIGHT },
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
  searchInput: { ...sharedStyles.input, width: "100%", boxSizing: "border-box", flexShrink: 0 },
  // The chips share the row evenly, whatever their number: one column each, as wide as the list below.
  filters: { display: "grid", gridAutoFlow: "column", gridAutoColumns: "1fr", gap: spacing.itemGap, flexShrink: 0 },
  chipButton: { background: "none", border: "none", padding: 0, margin: 0, font: "inherit", cursor: "pointer", display: "inline-flex", flex: 1, minWidth: 0 },
  filterChip: { flex: 1 },
  // One size for every chip and row bubble, so the format bubbles line up and the icon chips match them.
  chip: { minWidth: 40, height: 20, boxSizing: "border-box", justifyContent: "center" },
  listWrap: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  badges: { display: "flex", alignItems: "center", gap: spacing.itemGap, flexShrink: 0, marginLeft: spacing.itemGap },
  statusIcon: { ...muted(typography.icon), display: "inline-flex", alignItems: "center", flexShrink: 0, lineHeight: 1 },
  permissionNote: { display: "flex", flexDirection: "column", alignItems: "center", gap: spacing.itemGap },
  permissionText: { ...typography.caption, color: ui.text.disabled, textAlign: "center" },
  permissionButton: { fontSize: font.sm, padding: "2px 8px" },
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
