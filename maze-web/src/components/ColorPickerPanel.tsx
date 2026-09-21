import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pipette } from "lucide-react";
import { SidePanel } from "./SidePanel";
import { Button } from "./Button";
import { TextFieldRow } from "./TextFieldRow";
import { SectionHeader } from "./SectionHeader";
import { ColorEyedropperOverlay } from "./ColorEyedropperOverlay";
import { ui, radius, typography, spacing, font, controlRowHeight, indent } from "../styles/theme";
import { HEX_COLOR_RE, colorToHex, hexToColor } from "./colorFormat";
import { RgbModelEditor } from "./RgbModelEditor";
import { HslModelEditor } from "./HslModelEditor";
import { OklchModelEditor } from "./OklchModelEditor";
import { ToolsSection } from "./ToolsSection";
import { pushRecentColor, subscribe, getSnapshot, getServerSnapshot } from "./recentColorsStore";
import { useMazeStore } from "../store/mazeStore";
import { overrideActiveProfileColor, selectActiveProfileColors, PC, type ProjectColorEntry } from "../pixi/selectors/projectColorsSelector";
import { computeVectorByCorridorsWarningsAcrossFloors, computeVectorByWallsWarningsAcrossFloors } from "../pixi/selectors/exportWarnings";
import type { ExportWarningColorRole } from "../pixi/selectors/exportWarnings";
import { ExportWarningBubble } from "./features/ExportWarningBubble";
import { resolveExportWarningsSectionTitle } from "./features/exportWarningsI18n";
import type { MazeState } from "../store/storeTypes";
import * as m from "~/paraglide/messages";
import type React from "react";

/** Color models the picker can drive. `rgb` ships in #500, `hsl` in #501, `oklch` in #502; later
 *  sub-issues add more. */
type ColorModel = "rgb" | "hsl" | "oklch";

function colorRoleForField(fieldName: string): ExportWarningColorRole | null {
  const roles: [ExportWarningColorRole, string][] = [
    ["background", PC.bgFill.name()], ["grid", PC.bgGrid.name()], ["corridor", PC.corridorFill.name()],
    ["floor", PC.tilesFloor.name()], ["wall", PC.tilesWall.name()], ["one_way", PC.oneWaysMarker.name()],
    ["marker_fill", PC.startFill.name()], ["marker_fill", PC.finishFill.name()],
    ["marker_border", PC.startBorder.name()], ["marker_border", PC.finishBorder.name()],
    ["teleport_connector", PC.teleportConnector.name()],
    ["teleport_badge_fill", PC.teleportBadgeFill.name()], ["teleport_badge_border", PC.teleportBadgeBorder.name()],
    ["teleport_badge_text", PC.teleportBadgeText.name()], ["vertical_two_way_fill", PC.twoWayFill.name()],
    ["vertical_two_way_border", PC.twoWayBorder.name()], ["vertical_two_way_arrow", PC.twoWayArrow.name()],
    ["vertical_one_way_fill", PC.oneWayFill.name()], ["vertical_one_way_accent", PC.oneWayAccent.name()],
    ["vertical_one_way_arrow", PC.oneWayArrow.name()], ["elevator_fill", PC.elevatorFill.name()],
    ["elevator_border", PC.elevatorBorder.name()], ["elevator_arrow", PC.elevatorArrow.name()],
    ["elevator_badge_fill", PC.elevatorBadgeFill.name()], ["label_text", PC.markerIndexText.name()],
    ["label_background", PC.markerIndexFill.name()],
    ["vertical_two_way_line", PC.decorLineTwoWay.name()], ["vertical_one_way_line", PC.decorLineOneWay.name()],
    ["elevator_line", PC.decorLineElevator.name()], ["vertical_two_way_arrow", PC.decorArrowTwoWay.name()],
    ["vertical_one_way_accent", PC.decorAccentOneWay.name()],
  ];
  const direct = roles.find(([, name]) => name === fieldName);
  if (direct) return direct[0];
  if (fieldName.startsWith(`${m["image_export.vector_by_walls.section_splits"]}:`)) return "split";
  return null;
}

const MODELS: { key: ColorModel; label: () => string }[] = [
  { key: "rgb", label: () => m["color_picker.model.rgb"]() },
  { key: "hsl", label: () => m["color_picker.model.hsl"]() },
  { key: "oklch", label: () => m["color_picker.model.oklch"]() },
];

interface Props {
  /** Color the swatch currently holds, used to seed the working color on open. */
  color: number;
  /** Commit handler — called once with the working color when the user hits "Apply". */
  onApply: (color: number) => void;
  /** Dismiss handler — called on "Cancel", the header close button, or Escape. */
  onClose: () => void;
  /** Live-preview handler (GitHub issue #513). Called with the working color on every change while
   *  the picker is open, so the canvas can render the color in context as the user drags. On
   *  Cancel / header close / Escape it is called once more with the original `color` to restore the
   *  pre-open state; Apply leaves the last previewed color in place. Optional — a swatch whose
   *  `onChange` is cheap and side-effect-free can let `ColorSwatch` default it to `onChange`, but a
   *  call site whose `onChange` marks the maze dirty or pushes a history entry must pass a lighter
   *  handler here that only updates the render. A handler that is expensive per call should
   *  throttle itself. */
  onPreview?: (color: number) => void;
  /** "Priority" project colors (GitHub issue #503) pinned to the top of the "Project colors"
   *  section, in the given order — sibling colors that matter for the decision the picker was
   *  opened for. May be empty / omitted. */
  priorityColors?: ProjectColorEntry[];
  /** This field's factory default (GitHub issue #503). When set, the picker prepends it as the
   *  first row of the "Project colors" priority group under a generic "Default" label — always
   *  unique, so it is never de-duplicated against the profile rows below. */
  defaultColor?: number;
  /** The edited field's own name (GitHub issue #503) — shown in the panel header and used to drop
   *  the field's own row (exact name, or a `Section: …: <fieldName>` suffix) from the "Project
   *  colors" list. */
  fieldName?: string;
}

/** Shell of the custom color picker (GitHub issue #499, sub-issue of #498). Opens as a `SidePanel`
 *  overlay covering whatever panel is currently docked beside the canvas, seeded with the swatch's
 *  color. Holds a working color in local state: a large live preview plus an editable hex field.
 *  "Apply" commits via `onApply` and closes; "Cancel" closes without touching the swatch. Per-model
 *  editing controls (square, hue strip, channel sliders) come in later sub-issues.
 *
 *  Live canvas preview (GitHub issue #513): while open, every working-color change is pushed through
 *  `onPreview` so the canvas renders the color in context; Cancel / header close / Escape push the
 *  original color back before closing, Apply leaves the last preview in place. */
export function ColorPickerPanel({ color, onApply, onClose, onPreview, priorityColors, defaultColor, fieldName }: Props) {
  const [working, setWorking] = useState(color);
  const [hexInput, setHexInput] = useState(() => colorToHex(color));
  const [model, setModel] = useState<ColorModel>("rgb");
  const [projectColorsExpanded, setProjectColorsExpanded] = useState(false);
  const [showAllProjectColors, setShowAllProjectColors] = useState(false);
  const [colorWarningsExpanded, setColorWarningsExpanded] = useState(false);
  // Canvas eyedropper (GitHub issue #507) — sampling mode is purely local UI state; the actual
  // pixel read goes through `colorSampleBridge.ts` (the panel has no scene access of its own).
  const [sampling, setSampling] = useState(false);

  // Every color field of the export profile whose settings panel is open beside the canvas
  // (GitHub issue #503). Selected as its raw inputs and rebuilt via `useMemo` — `selectActiveProfileColors`
  // allocates a fresh array (and fresh entry objects) each call, so subscribing to it directly
  // would loop `useSyncExternalStore`.
  const openMode = useMazeStore((s: MazeState) => s.openRenderModeSettings);
  const wallsSettings = useMazeStore((s: MazeState) => s.vectorByWallsSettings);
  const corridorsSettings = useMazeStore((s: MazeState) => s.vectorByCorridorsSettings);
  const nodes = useMazeStore((s: MazeState) => s.nodes);
  const edges = useMazeStore((s: MazeState) => s.edges);
  const floors = useMazeStore((s: MazeState) => s.floors);
  const showColorWarnings = useMazeStore((s: MazeState) => s.showColorWarnings);
  const cfg = useMazeStore((s: MazeState) => s.activeTessellationConfig);
  const start = useMazeStore((s: MazeState) => s.start);
  const finish = useMazeStore((s: MazeState) => s.finish);
  const projectColorGroups = useMemo(() => {
    const all = selectActiveProfileColors({
      openRenderModeSettings: openMode,
      vectorByWallsSettings: wallsSettings,
      vectorByCorridorsSettings: corridorsSettings,
      nodes,
      edges,
      floors,
    } as MazeState);
    // Drop the edited field's own row — matched by exact name or a `…: <fieldName>` suffix, since
    // list names are composite (`Section: Field`) while a bare `fieldName` is just the row label.
    // Call sites whose row label is generic ("Fill color", shared by every marker group) pass an
    // already-composite `fieldName` so the suffix rule still isolates the one row.
    const isSelf = (name: string) =>
      fieldName !== undefined && (name === fieldName || name.endsWith(`: ${fieldName}`));
    // A priority color naming a field whose settings section is currently hidden (e.g. one-way
    // passage colors when the maze has no one-way passages) must not appear in the picker either
    // (GitHub issue #503 follow-up) — `all` is the active-field set, so drop any priority entry
    // whose name isn't in it.
    const activeNames = new Set(all.map((e) => e.name));
    const priority = (priorityColors ?? []).filter((e) => !isSelf(e.name) && activeNames.has(e.name));
    const withDefault = defaultColor !== undefined
      ? [{ name: m["color_picker.project_colors_default"](), color: defaultColor }, ...priority]
      : priority;
    return buildProjectColorGroups(withDefault, all.filter((e) => !isSelf(e.name)));
  }, [openMode, wallsSettings, corridorsSettings, nodes, edges, floors, priorityColors, defaultColor, fieldName]);

  const colorWarnings = useMemo(() => {
    if (!showColorWarnings || !fieldName || !openMode) return [];
    const snapshot = { openRenderModeSettings: openMode, vectorByWallsSettings: wallsSettings, vectorByCorridorsSettings: corridorsSettings, nodes, edges, floors, activeTessellationConfig: cfg, start, finish } as MazeState;
    const overridden = overrideActiveProfileColor(snapshot, fieldName, working);
    if (!overridden || !cfg) return [];
    const warnings = openMode === "vector_by_walls"
      ? computeVectorByWallsWarningsAcrossFloors(nodes, edges, floors, cfg, overridden as MazeState["vectorByWallsSettings"], start, finish)
      : computeVectorByCorridorsWarningsAcrossFloors(nodes, edges, floors, cfg, overridden as MazeState["vectorByCorridorsSettings"], start, finish);
    const role = colorRoleForField(fieldName);
    return warnings.filter((warning) => {
      if (!role || !warning.colorRoles || !warning.colorValues) return false;
      return warning.colorRoles.some((candidate, index) => candidate === role && warning.colorValues?.[index] === working);
    });
  }, [showColorWarnings, fieldName, openMode, wallsSettings, corridorsSettings, nodes, edges, floors, cfg, start, finish, working]);

  /** The color in effect when the picker opened. Captured once — with live preview (#513) the
   *  `color` prop tracks each previewed change (the call site's `onChange` also writes the store),
   *  so it can't be used to restore on Cancel. */
  const originalColor = useRef(color).current;

  // "Recently used" colors (GitHub issue #506) — reactive so a color applied earlier in the same
  // session shows up immediately without reopening the picker.
  const recentColors = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const hexValid = HEX_COLOR_RE.test(hexInput);

  // The live preview (#513) can fire once per pointer-move tick while a model slider / 2D area is
  // dragged — far more often than once a frame, and a call site's `onPreview` may re-render a full
  // preview canvas per call. Throttle to one `onPreview` call per animation frame, always with the
  // latest color; `flushPreview` delivers a pending frame synchronously so Cancel / Apply never
  // leave a stale color pending after the picker unmounts. Same pattern as `StepSlider`.
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const pendingPreview = useRef<number | null>(null);
  const previewScheduled = useRef(false);
  const previewRafId = useRef<number | null>(null);

  useEffect(() => () => {
    if (previewRafId.current !== null) cancelAnimationFrame(previewRafId.current);
  }, []);

  function flushPreview() {
    previewScheduled.current = false;
    if (previewRafId.current !== null) {
      cancelAnimationFrame(previewRafId.current);
      previewRafId.current = null;
    }
    if (pendingPreview.current !== null) {
      onPreviewRef.current?.(pendingPreview.current);
      pendingPreview.current = null;
    }
  }

  /** Queue a live-canvas preview of the working color, coalesced to one call per animation frame. */
  function preview(next: number) {
    if (!onPreviewRef.current) return;
    pendingPreview.current = next;
    if (previewScheduled.current) return;
    previewScheduled.current = true;
    previewRafId.current = requestAnimationFrame(flushPreview);
  }

  /** Close the picker, first restoring the canvas to the color that was in effect on open. Used by
   *  Cancel, the header close button, and Escape. Restores unconditionally (even with no pending
   *  frame) — an earlier previewed color may already be on the canvas. */
  function cancel() {
    if (onPreviewRef.current) {
      pendingPreview.current = originalColor;
      flushPreview();
    }
    onClose();
  }

  /** Commit on Apply: deliver any still-queued preview frame synchronously (unmount would drop it),
   *  then hand the final color to the call site. No queued frame → nothing to flush. Records the
   *  committed color into the "Recently used" list (GitHub issue #506). */
  function apply() {
    flushPreview();
    pushRecentColor(working);
    onApply(working);
  }

  /** Update the working color from a model editor and re-sync the shared hex field. */
  function setWorkingColor(next: number) {
    setWorking(next);
    setHexInput(colorToHex(next));
    preview(next);
  }

  /** Click on a "Project colors" row (GitHub issue #503) — set the working color, same path as the
   *  hex field (updates working + hex + live preview; does not commit — Apply still commits). */
  function pickProjectColor(next: number) {
    setWorking(next);
    setHexInput(colorToHex(next));
    preview(next);
  }

  /** A pixel picked via the canvas eyedropper (GitHub issue #507) — same path as a project-color
   *  row or Tools swatch: sets the working color, does not commit. */
  function pickSampledColor(next: number) {
    setSampling(false);
    setWorking(next);
    setHexInput(colorToHex(next));
    preview(next);
  }

  function handleHexChange(next: string) {
    setHexInput(next);
    if (HEX_COLOR_RE.test(next)) {
      const packed = hexToColor(next);
      setWorking(packed);
      preview(packed);
    }
  }

  return (
    <SidePanel title={fieldName ?? m["color_picker.title"]()} onClose={cancel} overlay>
      {/* `tabIndex` so the container itself can hold focus and receive Escape even when the click
       *  that opened the picker landed on a non-focusable element. */}
      <div
        style={styles.body}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}
      >
        <div style={styles.content}>
          <div style={{ ...styles.preview, background: colorToHex(working) }} data-testid="color-picker-preview" />
          <TextFieldRow
            label={m["color_picker.hex_label"]()}
            value={hexInput}
            invalid={!hexValid}
            onChange={handleHexChange}
            resetButton={
              <button
                type="button"
                className="hoverable"
                title={m["color_picker.eyedropper"]()}
                aria-label={m["color_picker.eyedropper"]()}
                aria-pressed={sampling}
                style={{ ...styles.eyedropperBtn, ...(sampling ? styles.eyedropperBtnActive : {}) }}
                onClick={() => setSampling((v) => !v)}
                data-testid="color-picker-eyedropper"
              >
                <Pipette size={14} />
              </button>
            }
          />
          {!hexValid && <span style={styles.hexError}>{m["color_picker.hex_invalid"]()}</span>}
          <div style={styles.modelSwitcher}>
            {MODELS.map(({ key, label }) => (
              <Button
                key={key}
                variant={model === key ? "toggle-selected" : "toggle"}
                onClick={() => setModel(key)}
              >
                {label()}
              </Button>
            ))}
          </div>
          {model === "rgb" && <RgbModelEditor color={working} onChange={setWorkingColor} />}
          {model === "hsl" && <HslModelEditor color={working} onChange={setWorkingColor} />}
          {model === "oklch" && <OklchModelEditor color={working} onChange={setWorkingColor} />}
          {recentColors.length > 0 && (
            <>
              <div style={styles.projectColorsDivider} />
              <div style={styles.recentColors}>
                <span style={styles.recentColorsLabel}>{m["color_picker.recent_colors"]()}</span>
                <div style={styles.swatchRow} data-testid="color-picker-recent-colors">
                  {recentColors.map((color, i) => (
                    <button
                      key={i}
                      type="button"
                      className="hoverable"
                      title={colorToHex(color)}
                      style={{ ...styles.recentSwatch, background: colorToHex(color) }}
                      onClick={() => pickProjectColor(color)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
          <div style={styles.projectColorsDivider} />
          {showColorWarnings && <div data-testid="color-picker-export-warnings">
            <SectionHeader
              label={<span className={colorWarnings.length > 0 ? "problem-section-attention" : undefined}>
                {resolveExportWarningsSectionTitle(colorWarnings.length)}
              </span>}
              expanded={colorWarningsExpanded}
              onToggle={() => setColorWarningsExpanded((expanded) => !expanded)}
            />
            {colorWarningsExpanded && <div style={styles.colorWarningsBlock}>
              {colorWarnings.length === 0
                ? <span style={styles.colorWarningsEmpty}>{m["color_picker.no_export_warnings"]()}</span>
                : colorWarnings.map((warning) => <ExportWarningBubble key={warning.key} warning={warning} interactive={false} />)}
            </div>}
          </div>}
          <ToolsSection seedColor={originalColor} workingColor={working} onPick={pickProjectColor} />
          {projectColorGroups.total > 0 && (
            <div style={styles.projectColors}>
              <SectionHeader
                label={m["color_picker.project_colors"]({ count: String(projectColorGroups.total) })}
                expanded={projectColorsExpanded}
                onToggle={() => setProjectColorsExpanded((v) => !v)}
              />
              {projectColorsExpanded && (
                <div style={styles.projectColorsBody}>
                  {projectColorGroups.top.map((entry, i) => (
                    <ProjectColorRow key={`top-${i}`} entry={entry} onPick={pickProjectColor} />
                  ))}
                  {projectColorGroups.bottom.length > 0 && (
                    showAllProjectColors ? (
                      <>
                        {projectColorGroups.top.length > 0 && <div style={styles.projectColorsDivider} />}
                        {projectColorGroups.bottom.map((entry, i) => (
                          <ProjectColorRow key={`bottom-${i}`} entry={entry} onPick={pickProjectColor} />
                        ))}
                        <Button variant="secondary" layoutStyle={styles.showAllButton} onClick={() => setShowAllProjectColors(false)}>
                          {m["color_picker.project_colors_hide_unrelated"]()}
                        </Button>
                      </>
                    ) : (
                      <Button variant="secondary" layoutStyle={styles.showAllButton} onClick={() => setShowAllProjectColors(true)}>
                        {m["color_picker.project_colors_show_all"]()}
                      </Button>
                    )
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={styles.footer}>
          <Button variant="secondary" layoutStyle={styles.footerBtn} onClick={cancel}>
            {m["common.cancel"]()}
          </Button>
          <Button variant="primary" layoutStyle={styles.footerBtn} disabled={!hexValid} onClick={apply}>
            {m["common.apply"]()}
          </Button>
        </div>
      </div>
      {sampling && <ColorEyedropperOverlay onPick={pickSampledColor} onCancel={() => setSampling(false)} />}
    </SidePanel>
  );
}

/** De-duplicate the "Project colors" bottom group against the top group (GitHub issue #503):
 *  drop a bottom row whose exact `name` + `color` pair already appears in the top group. Rows are
 *  never de-duplicated by color value alone — several fields sharing a hex all stay. */
function buildProjectColorGroups(priority: ProjectColorEntry[], all: ProjectColorEntry[]) {
  const topKeys = new Set(priority.map((e) => `${e.name} ${e.color}`));
  const bottom = all.filter((e) => !topKeys.has(`${e.name} ${e.color}`));
  return { top: priority, bottom, total: priority.length + bottom.length };
}

/** One clickable row in the "Project colors" section — a swatch + its name. Clicking sets the
 *  picker's working color (does not commit). */
function ProjectColorRow({ entry, onPick }: { entry: ProjectColorEntry; onPick: (color: number) => void }) {
  return (
    <div
      className="project-color-row"
      role="button"
      tabIndex={0}
      style={styles.projectColorRow}
      onClick={() => onPick(entry.color)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(entry.color); } }}
    >
      <span style={{ ...styles.projectColorSwatch, background: colorToHex(entry.color) }} />
      <span style={styles.projectColorName}>{entry.name}</span>
    </div>
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
    overflowY: "auto",
  },
  preview: {
    width: "100%",
    height: 120,
    flexShrink: 0,
    border: `2px solid ${ui.border.strong}`,
    borderRadius: radius.md,
    boxSizing: "border-box",
  },
  hexError: { ...typography.caption, color: ui.text.error },
  eyedropperBtn: {
    ...typography.icon,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: controlRowHeight,
    height: controlRowHeight,
    flexShrink: 0,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
    color: ui.text.tertiary,
    cursor: "default",
    boxSizing: "border-box",
  },
  eyedropperBtnActive: {
    background: ui.state.selected,
    color: ui.text.primary,
    border: `1px solid ${ui.state.selected}`,
  },
  modelSwitcher: { display: "flex", gap: spacing.itemGap },
  colorWarningsBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree, marginTop: spacing.itemGap },
  colorWarningsEmpty: { ...typography.body, color: ui.text.secondary },
  recentColors: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  recentColorsLabel: { fontSize: font.lg, color: ui.text.primary },
  swatchRow: { display: "flex", gap: spacing.itemGap, flexWrap: "wrap" },
  recentSwatch: {
    width: 32, height: 28, flexShrink: 0, borderRadius: 3, padding: 0,
    border: `2px solid ${ui.border.strong}`, boxSizing: "border-box",
  },
  projectColors: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  projectColorsBody: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  projectColorsDivider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  showAllButton: { width: "100%", boxSizing: "border-box" as const, marginTop: spacing.itemGap },
  projectColorRow: {
    display: "flex", alignItems: "center", gap: spacing.groupGap,
    borderRadius: 3, outline: "none", padding: "2px 4px", margin: "0 -4px",
  },
  projectColorSwatch: {
    width: 24, height: 20, flexShrink: 0, borderRadius: 3,
    border: `2px solid ${ui.border.strong}`, boxSizing: "border-box",
  },
  projectColorName: { ...typography.body, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  footer: {
    display: "flex",
    gap: spacing.groupGap,
    padding: spacing.groupGap,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  footerBtn: { flex: 1 },
};
