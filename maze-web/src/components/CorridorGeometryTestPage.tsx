import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { cairoCanonicalFaceOrder } from "../pixi/cairoGeometry";
import { getTileDiagram } from "../pixi/tessellationGeometry";
import {
  buildCorridorContour,
  buildCorridorGeometryDebug,
  contourToSvgPath,
  type CorridorCell,
  type CorridorPoint,
  type CorridorPort,
} from "../pixi/imageExport/vectorByCorridorsContour";
import { buildCorridorContour as buildMainBranchCorridorContour } from "../pixi/imageExport/vectorByCorridorsContourMainReference";
import type { FieldConfig } from "../fieldConfig";

type Family = {
  id: string;
  label: string;
  note: string;
  config: FieldConfig;
  coordinate: [number, number];
};

type PreparedFamily = Family & {
  polygon: CorridorPoint[];
  ports: CorridorPort[];
};

type DebugVisibility = {
  ports: boolean;
  target: boolean;
  centerCurves: boolean;
  rawRibbonSides: boolean;
  ribbonSides: boolean;
  preCornerContour: boolean;
  /** TEMPORARY MAIN RENDERER REFERENCE: remove after the direct comparison is complete. */
  mainRendererReference: boolean;
};

const FAMILIES: Family[] = [
  {
    id: "square",
    label: "Square",
    note: "4 faces · 16 combinations",
    config: { type: "square", width: 40, height: 40 },
    coordinate: [0, 0],
  },
  {
    id: "hex",
    label: "Hexagonal",
    note: "6 faces · 64 combinations",
    config: { type: "hex_hexagon", radius: 8, orientation: "flat_top" },
    coordinate: [0, 0],
  },
  {
    id: "triangle",
    label: "Triangular",
    note: "3 faces · 8 combinations",
    config: { type: "triangle_triangle", side: 12, orientation: "r0" },
    coordinate: [0, 0],
  },
  {
    id: "cairo",
    label: "Cairo",
    note: "5 faces · 32 combinations",
    config: { type: "cairo", cols: 3, rows: 3 },
    coordinate: [2, 1],
  },
];

const COLORS = ["#6fb5ff", "#ffb86b", "#9fe18a", "#e59aff"];

function prepareFamily(family: Family): PreparedFamily | null {
  const diagram = getTileDiagram(family.coordinate[0], family.coordinate[1], family.config);
  if (!diagram) return null;

  const portsByFace = diagram.sides.map((side) => {
    const dx = side.v1.x - side.v0.x;
    const dy = side.v1.y - side.v0.y;
    const midpoint = { x: (side.v0.x + side.v1.x) / 2, y: (side.v0.y + side.v1.y) / 2 };
    const normalLength = Math.hypot(dx, dy) || 1;
    let normal = { x: -dy / normalLength, y: dx / normalLength };
    if (normal.x * midpoint.x + normal.y * midpoint.y < 0) {
      normal = { x: -normal.x, y: -normal.y };
    }
    return {
      cellId: family.id,
      midpoint,
      normal,
      face: [side.v0, side.v1] as const,
      // Production segments carry a real shared-face midpoint, which enables the same cubic-safe
      // mouth handling in the universal contour renderer for irregular cells such as Cairo.
      useCubicMouth: true,
    };
  });
  const faceOrder = family.config.type.startsWith("cairo")
    ? cairoCanonicalFaceOrder(family.coordinate[0], family.coordinate[1])
    : [];
  const ports = faceOrder.length === portsByFace.length
    ? faceOrder.map((faceIndex) => portsByFace[faceIndex])
    : portsByFace;

  return {
    ...family,
    polygon: diagram.vertices,
    ports,
  };
}

function pointsAttribute(points: readonly CorridorPoint[]): string {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function bounds(polygon: readonly CorridorPoint[]): { minX: number; minY: number; size: number } {
  const minX = Math.min(...polygon.map((point) => point.x));
  const minY = Math.min(...polygon.map((point) => point.y));
  const maxX = Math.max(...polygon.map((point) => point.x));
  const maxY = Math.max(...polygon.map((point) => point.y));
  const size = Math.max(maxX - minX, maxY - minY) + 16;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return { minX: centerX - size / 2, minY: centerY - size / 2, size };
}

/** TEMPORARY MAIN-BRANCH REFERENCE: adapts the lab cell to the exact segment overload from the
 * Git branch `main`, before issue 726. Remove this comparison layer when the comparison is done. */
function temporaryMainRendererReference(
  polygon: readonly CorridorPoint[],
  ports: readonly CorridorPort[],
  thickness: number,
): string | null {
  if (ports.length === 0) return null;

  const segments = ports.map((port) => {
    const face = port.face;
    const faceStart = face ? ("start" in face ? face.start : face[0]) : undefined;
    const faceEnd = face ? ("end" in face ? face.end : face[1]) : undefined;
    const faceLength = faceStart && faceEnd
      ? Math.hypot(faceEnd.x - faceStart.x, faceEnd.y - faceStart.y)
      : undefined;

    return {
      v0: { x: 0, y: 0 },
      v1: port.midpoint,
      faceMidpoint: port.midpoint,
      faceNormal: port.normal,
      ...(faceLength !== undefined ? { faceLength } : {}),
      cellVertices0: [...polygon],
      // A real main-renderer segment ending at a split creates one port on v0. Grouping all
      // synthetic segments at the same v0 reproduces this lab cell as one renderer tile.
      v1TouchesSplit: true,
    };
  });

  // `main` used the shallow three-way contour mode and had no junction-radius setting. Keep this
  // call independent from the current universal renderer and deliberately ignore cornerRadius.
  const paths = buildMainBranchCorridorContour(segments, thickness, true, "shallowThreeWay");
  return paths.length > 0 ? contourToSvgPath(paths) : null;
}

function CombinationArtwork({ family, mask, thickness, cornerRadius, highlightActiveFaces, color, grayRendering, style, debugVisibility }: {
  family: PreparedFamily;
  mask: number;
  thickness: number;
  cornerRadius: number;
  highlightActiveFaces: boolean;
  color: string;
  grayRendering: boolean;
  style: CSSProperties;
  debugVisibility?: DebugVisibility;
}) {
  const selected = family.ports.filter((_, index) => (mask & (1 << index)) !== 0);
  const paths = buildCorridorContour(
    [{ id: family.id, center: { x: 0, y: 0 }, polygon: family.polygon } satisfies CorridorCell],
    selected,
    thickness,
    true,
    cornerRadius,
  );
  const [debug] = buildCorridorGeometryDebug(
    [{ id: family.id, center: { x: 0, y: 0 }, polygon: family.polygon } satisfies CorridorCell],
    selected,
    thickness,
    true,
    cornerRadius,
  );
  const view = bounds(family.polygon);
  const renderColor = grayRendering ? "#858c94" : color;
  // TEMPORARY MAIN RENDERER REFERENCE: comparison layer only.
  const mainRendererReference = debugVisibility?.mainRendererReference
    ? temporaryMainRendererReference(family.polygon, selected, thickness)
    : null;
  const label = mask.toString(2).padStart(family.ports.length, "0");
  const labelOffset = view.size * 0.07;
  const labelFontSize = view.size * 0.1;
  const debugStrokeWidth = (minimum: number, factor: number) => Math.max(minimum, thickness * factor) / 2;
  const debugPointRadius = (minimum: number, factor: number) => Math.max(minimum, thickness * factor) / 2;
  const debugContourStrokeWidth = debugStrokeWidth(0.45, 0.045);
  const handleStrokeWidth = debugStrokeWidth(0.35, 0.035);
  const handlePointRadius = debugPointRadius(0.7, 0.08);
  const handleDash = `${Math.max(2, thickness * 0.22)} ${Math.max(1.5, thickness * 0.16)}`;

  return (
    <svg viewBox={`${view.minX} ${view.minY} ${view.size} ${view.size}`} preserveAspectRatio="xMidYMid meet" style={style} role="img" aria-label={`${family.label} combination ${label}`}>
      <polygon points={pointsAttribute(family.polygon)} fill="#20252b" stroke="#606a75" strokeWidth={1.2} />
      {family.ports.map((port, index) => {
        const active = (mask & (1 << index)) !== 0;
        const highlighted = active && highlightActiveFaces;
        const labelX = port.midpoint.x + port.normal.x * labelOffset;
        const labelY = port.midpoint.y + port.normal.y * labelOffset;
        return (
          <g key={index}>
            <line
              x1={port.face && Array.isArray(port.face) ? port.face[0].x : port.midpoint.x}
              y1={port.face && Array.isArray(port.face) ? port.face[0].y : port.midpoint.y}
              x2={port.face && Array.isArray(port.face) ? port.face[1].x : port.midpoint.x}
              y2={port.face && Array.isArray(port.face) ? port.face[1].y : port.midpoint.y}
              stroke={highlighted ? renderColor : "#87909a"}
              strokeWidth={highlighted ? 2.5 : 1}
            />
            <text x={labelX} y={labelY} textAnchor="middle" dominantBaseline="middle" fontSize={labelFontSize} fontWeight="600" fill="#d8dee5">{index}</text>
          </g>
        );
      })}
      {paths.map((path, index) => (
        <path key={index} d={contourToSvgPath([path])} fill={renderColor} />
      ))}
      {mainRendererReference && (
        <path
          // TEMPORARY MAIN RENDERER REFERENCE: visual comparison overlay only.
          d={mainRendererReference}
          fill="#ffffff"
          stroke="#ffffff"
          fillOpacity={0.42}
          strokeOpacity={0.8}
          strokeWidth={debugStrokeWidth(0.35, 0.04)}
        />
      )}
      {debugVisibility?.preCornerContour && debug?.contourBeforeCornerRadius.map((path, index) => (
        <path key={`pre-contour-${index}`} d={contourToSvgPath([path])} fill="none" stroke="#fff" strokeWidth={debugContourStrokeWidth} strokeDasharray="2 2" />
      ))}
      {debugVisibility?.ribbonSides && debug?.ribbons.map((ribbon) => (
        <g key={`ribbon-${ribbon.portIndex}`} fill="none" stroke="#fff" strokeWidth={debugContourStrokeWidth}>
          <polyline points={pointsAttribute(ribbon.left)} />
          <polyline points={pointsAttribute(ribbon.right)} />
        </g>
      ))}
      {debugVisibility?.rawRibbonSides && debug?.rawRibbons.map((ribbon) => (
        <g key={`raw-ribbon-${ribbon.portIndex}`} fill="none" stroke="#fff" strokeWidth={debugContourStrokeWidth}>
          <polyline points={pointsAttribute(ribbon.left)} />
          <polyline points={pointsAttribute(ribbon.right)} />
        </g>
      ))}
      {debugVisibility?.centerCurves && debug?.centerCurves.map((curve) => {
        const controls = curve.controlPoints;
        const start = curve.path[0]?.kind === "move" ? curve.path[0].to : undefined;
        const end = curve.path.find((command) => command.kind === "bezier");
        if (!start || !end || end.kind !== "bezier" || controls.length < 2) return null;
        return (
          <g key={`centre-${curve.portIndex}`} fill="none" stroke="#fff" strokeWidth={debugContourStrokeWidth}>
            {/* Solid path is the center curve; dashed segments are its control handles. */}
            <path d={contourToSvgPath([{ cmds: curve.path, hole: false }], false)} />
            <line x1={start.x} y1={start.y} x2={controls[0].x} y2={controls[0].y} stroke="#fff" strokeDasharray={handleDash} strokeWidth={handleStrokeWidth} strokeLinecap="round" />
            <line x1={controls[1].x} y1={controls[1].y} x2={end.to.x} y2={end.to.y} stroke="#fff" strokeDasharray={handleDash} strokeWidth={handleStrokeWidth} strokeLinecap="round" />
            {controls.map((control, index) => <circle key={index} cx={control.x} cy={control.y} r={handlePointRadius} fill="#fff" stroke="none" />)}
          </g>
        );
      })}
      {debugVisibility?.ports && selected.map((port, index) => (
        <g key={`port-debug-${index}`}>
          <circle cx={port.midpoint.x} cy={port.midpoint.y} r={debugPointRadius(0.7, 0.08)} fill="#fff" stroke="none" />
          <line x1={port.midpoint.x} y1={port.midpoint.y} x2={port.midpoint.x + port.normal.x * labelOffset * 0.8} y2={port.midpoint.y + port.normal.y * labelOffset * 0.8} stroke="#fff" strokeWidth={handleStrokeWidth} />
        </g>
      ))}
      {debugVisibility?.target && debug && (
        <circle cx={debug.target.x} cy={debug.target.y} r={debugPointRadius(0.9, 0.09)} fill="#fff" stroke="none" />
      )}
    </svg>
  );
}

function CombinationCard({ family, mask, thickness, cornerRadius, highlightActiveFaces, color, grayRendering = false, expanded = false, onOpen, debugVisibility }: {
  family: PreparedFamily;
  mask: number;
  thickness: number;
  cornerRadius: number;
  highlightActiveFaces: boolean;
  color: string;
  grayRendering?: boolean;
  expanded?: boolean;
  onOpen?: () => void;
  debugVisibility?: DebugVisibility;
}) {
  const selected = family.ports.filter((_, index) => (mask & (1 << index)) !== 0);
  const label = mask.toString(2).padStart(family.ports.length, "0");
  const interactive = !expanded && Boolean(onOpen);

  return (
    <div
      style={expanded ? styles.expandedCard : styles.card}
      title={interactive ? `Click to enlarge · ports: ${selected.length}/${family.ports.length}` : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Enlarge ${family.label} combination ${label}` : undefined}
      onClick={interactive ? onOpen : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen?.();
        }
      } : undefined}
    >
      <CombinationArtwork
        family={family}
        mask={mask}
        thickness={thickness}
        cornerRadius={cornerRadius}
        highlightActiveFaces={highlightActiveFaces}
        color={color}
        grayRendering={grayRendering}
        style={expanded ? styles.expandedSvg : styles.svg}
        debugVisibility={debugVisibility}
      />
      {!expanded && <div style={styles.cardLabel}>
        <code>{label}</code>
        <span>{selected.length === 0 ? "empty" : `${selected.length} port${selected.length === 1 ? "" : "s"}`}</span>
      </div>}
    </div>
  );
}

function masksByActivePorts(portCount: number): number[] {
  const masks = Array.from({ length: 1 << portCount }, (_, mask) => mask);
  return masks.sort((left, right) => {
    const leftCount = left.toString(2).split("1").length - 1;
    const rightCount = right.toString(2).split("1").length - 1;
    return leftCount - rightCount || left - right;
  });
}

function FamilySection({ family, thickness, cornerRadius, highlightActiveFaces, color, onOpen }: {
  family: PreparedFamily;
  thickness: number;
  cornerRadius: number;
  highlightActiveFaces: boolean;
  color: string;
  onOpen: (mask: number) => void;
}) {
  return (
    <section style={styles.section}>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.heading}>{family.label}</h2>
          <div style={styles.muted}>{family.note} · port numbers are shown on each face</div>
        </div>
      </div>
      <div style={styles.grid}>
        {masksByActivePorts(family.ports.length).map((mask) => (
          <CombinationCard
            key={mask}
            family={family}
            mask={mask}
            thickness={thickness}
            cornerRadius={cornerRadius}
            highlightActiveFaces={highlightActiveFaces}
            color={color}
            onOpen={() => onOpen(mask)}
          />
        ))}
      </div>
    </section>
  );
}

export function CorridorGeometryTestPage() {
  const [thickness, setThickness] = useState(12);
  const [cornerRadius, setCornerRadius] = useState(4);
  const [highlightActiveFaces, setHighlightActiveFaces] = useState(false);
  const [selectedFamilyId, setSelectedFamilyId] = useState(FAMILIES[0].id);
  const [expandedCard, setExpandedCard] = useState<{ familyId: string; mask: number } | null>(null);
  const [debugVisibility, setDebugVisibility] = useState<DebugVisibility>({
    ports: false,
    target: false,
    centerCurves: false,
    rawRibbonSides: false,
    ribbonSides: false,
    preCornerContour: false,
    mainRendererReference: false,
  });
  const [grayRendering, setGrayRendering] = useState(false);
  const families = useMemo(() => FAMILIES.map(prepareFamily).filter((family): family is PreparedFamily => family !== null), []);
  const visibleFamilies = families.filter((family) => family.id === selectedFamilyId);
  const totalCombinations = visibleFamilies.reduce((sum, family) => sum + (1 << family.ports.length), 0);
  const expandedFamily = expandedCard ? families.find((family) => family.id === expandedCard.familyId) : undefined;
  const expandedColor = expandedFamily ? COLORS[families.indexOf(expandedFamily) % COLORS.length] : COLORS[0];

  useEffect(() => {
    if (!expandedCard) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedCard(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [expandedCard]);

  return (
    <main style={styles.page}>
      <div style={styles.settingsPanel}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Vector corridor geometry lab</h1>
          <p style={styles.subtitle}>Every possible face-port combination for one cell, rendered through the generic geometry engine.</p>
        </div>
        <div style={styles.controls}>
          <label style={styles.control}>
            <span>Corridor thickness: <strong>{thickness}px</strong></span>
            <input className="maze-slider" type="range" min={2} max={40} step={1} value={thickness} onChange={(event) => setThickness(Number(event.target.value))} />
          </label>
          <label style={styles.control}>
            <span>Junction corner radius: <strong>{cornerRadius}px</strong></span>
            <input className="maze-slider" type="range" min={0} max={20} step={0.5} value={cornerRadius} onChange={(event) => setCornerRadius(Number(event.target.value))} />
          </label>
          <div style={styles.switchControl}>
            <span>Highlight active faces</span>
            <button
              type="button"
              role="switch"
              aria-checked={highlightActiveFaces}
              aria-label="Highlight active faces"
              onClick={() => setHighlightActiveFaces((current) => !current)}
              style={{ ...styles.switch, background: highlightActiveFaces ? "#3a6ea8" : "#39424a" }}
            >
              <span style={{ ...styles.switchThumb, transform: highlightActiveFaces ? "translateX(14px)" : "translateX(0)" }} />
            </button>
          </div>
        </div>
      </header>
      <div style={styles.familySelector}>
        <label style={styles.selectorControl}>
          <span style={styles.selectorLabel}>Show tessellation:</span>
          <select value={selectedFamilyId} onChange={(event) => setSelectedFamilyId(event.target.value)} style={styles.select}>
            {families.map((family) => <option key={family.id} value={family.id}>{family.label}</option>)}
          </select>
        </label>
      </div>
      </div>
      <div style={styles.summary}>Total combinations: {families.reduce((sum, family) => sum + (1 << family.ports.length), 0)} · empty state included · blue/orange/green/purple marks the tessellation family</div>
      <div style={styles.dynamicSummary}>Total combinations: {totalCombinations} · {visibleFamilies.length} of {families.length} tessellations shown</div>
      {visibleFamilies.length === 0 && <div style={styles.emptyState}>Select at least one tessellation to show its combinations.</div>}
      {visibleFamilies.map((family) => (
        <FamilySection
          key={family.id}
          family={family}
          thickness={thickness}
          cornerRadius={cornerRadius}
          highlightActiveFaces={highlightActiveFaces}
          color={COLORS[families.indexOf(family) % COLORS.length]}
          onOpen={(mask) => setExpandedCard({ familyId: family.id, mask })}
        />
      ))}
      {expandedCard && expandedFamily && (
        <div style={styles.modalBackdrop} onMouseDown={() => setExpandedCard(null)}>
          <div
            style={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label={`${expandedFamily.label} combination ${expandedCard.mask.toString(2).padStart(expandedFamily.ports.length, "0")}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div style={styles.modalHeader}>
              <div>
                <h2 style={styles.modalTitle}>{expandedFamily.label}</h2>
                <div style={styles.muted}>
                  Combination {expandedCard.mask.toString(2).padStart(expandedFamily.ports.length, "0")}
                </div>
              </div>
              <button type="button" style={styles.modalClose} onClick={() => setExpandedCard(null)} aria-label="Close enlarged sample"><span style={styles.closeGlyph}>×</span></button>
            </div>
            <div style={styles.modalBody}>
              <CombinationCard
                family={expandedFamily}
                mask={expandedCard.mask}
                thickness={thickness}
                cornerRadius={cornerRadius}
                highlightActiveFaces={highlightActiveFaces}
                color={expandedColor}
                grayRendering={grayRendering}
                expanded
                debugVisibility={debugVisibility}
              />
              <div style={styles.debugControls}>
                {([
                  ["ports", "Ports"],
                  ["target", "Target point"],
                  ["centerCurves", "Center curves + controls"],
                  ["rawRibbonSides", "Raw ribbon sides (before constraint)"],
                  ["ribbonSides", "Ribbon side curves"],
                  ["preCornerContour", "Contour before corner radius"],
                  // TEMPORARY MAIN RENDERER REFERENCE: remove after the direct comparison is complete.
                  ["mainRendererReference", "Main renderer reference"],
                ] as const).map(([key, label]) => (
                  <div key={key} style={styles.debugToggleRow}>
                    <span>{label}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-label={label}
                      aria-checked={debugVisibility[key]}
                      onClick={() => setDebugVisibility((current) => ({ ...current, [key]: !current[key] }))}
                      style={{ ...styles.debugSwitch, ...(debugVisibility[key] ? styles.debugSwitchOn : {}) }}
                    >
                      <span style={{ ...styles.debugThumb, transform: debugVisibility[key] ? "translateX(14px)" : "translateX(0)" }} />
                    </button>
                  </div>
                ))}
                <div style={styles.debugToggleRow}>
                  <span>Gray rendering</span>
                  <button
                    type="button"
                    role="switch"
                    aria-label="Gray rendering"
                    aria-checked={grayRendering}
                    onClick={() => setGrayRendering((current) => !current)}
                    style={{ ...styles.debugSwitch, ...(grayRendering ? styles.debugSwitchOn : {}) }}
                  >
                    <span style={{ ...styles.debugThumb, transform: grayRendering ? "translateX(14px)" : "translateX(0)" }} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { minHeight: "100vh", boxSizing: "border-box", padding: "24px 28px 48px", background: "#15181c", color: "#e7ebef" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", maxWidth: 1800, margin: "0 auto 12px" },
  title: { margin: 0, fontSize: 24, fontWeight: 600 },
  subtitle: { margin: "6px 0 0", color: "#9da7b2", fontSize: 14 },
  controls: { display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: 18 },
  control: { display: "grid", gap: 8, width: 240, color: "#c3cbd4", fontSize: 13 },
  switchControl: { display: "flex", alignItems: "center", gap: 8, minHeight: 28, color: "#c3cbd4", fontSize: 13, whiteSpace: "nowrap" },
  switch: { width: 30, height: 16, padding: 2, border: "1px solid #59636e", borderRadius: 10, cursor: "pointer", transition: "background 0.15s" },
  switchThumb: { display: "block", width: 10, height: 10, borderRadius: "50%", background: "#e7ebef", transition: "transform 0.15s" },
  dynamicSummary: { maxWidth: 1800, margin: "0 auto 12px", color: "#7e8995", fontSize: 12 },
  summary: { display: "none", maxWidth: 1800, margin: "0 auto 28px", color: "#7e8995", fontSize: 12 },
  settingsPanel: { position: "sticky", top: 0, zIndex: 10, maxWidth: 1800, margin: "-24px auto 28px", padding: "18px 0 12px", background: "#15181c", boxShadow: "0 8px 14px -14px #000" },
  familySelector: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, maxWidth: 1800, margin: "0 auto 10px", paddingTop: 2, color: "#c3cbd4", fontSize: 13 },
  selectorControl: { display: "inline-flex", alignItems: "center", gap: 8 },
  selectorLabel: { color: "#7e8995" },
  select: { minWidth: 150, padding: "4px 8px", border: "1px solid #4a545e", borderRadius: 4, background: "#20252b", color: "#e7ebef", fontSize: 13 },
  emptyState: { maxWidth: 1800, margin: "0 auto", padding: "32px 0", color: "#9da7b2", textAlign: "center" },
  section: { maxWidth: 1800, margin: "0 auto 34px" },
  sectionHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 },
  heading: { margin: 0, fontSize: 18, fontWeight: 600 },
  muted: { marginTop: 3, color: "#87929e", fontSize: 12 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(142px, 1fr))", gap: 8 },
  card: { minWidth: 0, padding: 7, background: "#1d2228", border: "1px solid #303840", borderRadius: 5, cursor: "zoom-in", outline: "none" },
  svg: { display: "block", width: "100%", height: 122, background: "#171b20", borderRadius: 3 },
  expandedCard: { padding: 12, background: "#1d2228", border: "1px solid #303840", borderRadius: 5 },
  expandedSvg: { display: "block", width: "100%", height: "min(70vh, 560px)", minHeight: 280, background: "#171b20", borderRadius: 3 },
  cardLabel: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, color: "#8f9aa6", fontSize: 11 },
  modalBackdrop: { position: "fixed", inset: 0, zIndex: 30, display: "grid", placeItems: "center", padding: 24, background: "rgba(7, 9, 12, 0.78)" },
  modal: { width: "min(920px, 94vw)", maxHeight: "92vh", overflow: "auto", padding: 16, background: "#151a20", border: "1px solid #4a5560", borderRadius: 8, boxShadow: "0 18px 60px rgba(0, 0, 0, 0.5)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 12 },
  modalBody: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 220px", alignItems: "start", gap: 16 },
  debugControls: { display: "grid", gap: 8, padding: 10, background: "#20262d", borderRadius: 5 },
  debugToggleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, color: "#cbd3dc", fontSize: 12, lineHeight: 1.2 },
  debugSwitch: { display: "inline-flex", alignItems: "center", width: 30, height: 16, padding: 2, border: "1px solid #59636e", borderRadius: 10, background: "#39424a", cursor: "pointer", transition: "background 0.15s" },
  debugSwitchOn: { background: "#3a6ea8" },
  debugThumb: { display: "block", width: 10, height: 10, borderRadius: "50%", background: "#e7ebef", transition: "transform 0.15s" },
  modalTitle: { margin: 0, fontSize: 20, fontWeight: 600 },
  modalClose: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, padding: 0, border: "1px solid #59636e", borderRadius: 4, background: "#20262d", color: "#e7ebef", fontFamily: "inherit", fontSize: 24, lineHeight: 1, cursor: "pointer" },
  closeGlyph: { display: "block", transform: "translateY(-2px)", lineHeight: 1 },
};
