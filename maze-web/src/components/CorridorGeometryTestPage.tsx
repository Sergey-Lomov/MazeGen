import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { cairoCanonicalFaceOrder } from "../pixi/cairoGeometry";
import { getTileDiagram } from "../pixi/tessellationGeometry";
import {
  buildCorridorGeometryDebug,
  contourToSvgPath,
  corridorSegmentsToGeometryInput,
  type CorridorGeometryDebug,
  type CorridorPoint,
  type CorridorPort,
  type CorridorSegmentInput,
} from "../pixi/imageExport/vectorByCorridorsContour";
import type { FieldConfig } from "../fieldConfig";

export type Family = {
  id: string;
  label: string;
  note: string;
  config: FieldConfig;
  coordinate: [number, number];
};

/** One lab cell centred at the origin, with one port per polygon face. */
export type LabCell = {
  id: string;
  label: string;
  polygon: CorridorPoint[];
  ports: CorridorPort[];
};

type PreparedFamily = LabCell & { note: string };

type ExpandedCard = {
  /** A tessellation family's id or a problem example's cell id. */
  cellId: string;
  mask: number;
};

/** One reproduction of a known overflow problem: a cell, its port combination, and the corridor
 *  thickness at which the problem shows. */
type ProblemExample = {
  cell: LabCell;
  mask: number;
  thickness: number;
};

type ProblemType = {
  id: string;
  title: string;
  description: string;
  examples: ProblemExample[];
};

type DebugVisibility = {
  ports: boolean;
  target: boolean;
  centerCurves: boolean;
  rawRibbonSides: boolean;
  ribbonSides: boolean;
  preCornerContour: boolean;
  /** Redraws the cell border over the corridor so any part outside the cell stands out. */
  cellOutline: boolean;
};

export const FAMILIES: Family[] = [
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

/** Port in the middle of face `v0`-`v1` of a cell centred at the origin, normal pointing outward. */
function facePort(cellId: string, v0: CorridorPoint, v1: CorridorPoint): CorridorPort {
  const dx = v1.x - v0.x;
  const dy = v1.y - v0.y;
  const midpoint = { x: (v0.x + v1.x) / 2, y: (v0.y + v1.y) / 2 };
  const normalLength = Math.hypot(dx, dy) || 1;
  let normal = { x: -dy / normalLength, y: dx / normalLength };
  if (normal.x * midpoint.x + normal.y * midpoint.y < 0) {
    normal = { x: -normal.x, y: -normal.y };
  }
  return { cellId, midpoint, normal, face: [v0, v1] };
}

/** Length of a port's face; `Infinity` for a port without one. */
export function faceLength(port: CorridorPort): number {
  return port.face ? Math.hypot(port.face[1].x - port.face[0].x, port.face[1].y - port.face[0].y) : Infinity;
}

/** Longest face of a cell, the lab's "cell size". */
export function cellSize(cell: LabCell): number {
  return Math.max(...cell.ports.map(faceLength).filter(Number.isFinite));
}

/** Scales a cell about its centre. */
export function scaleCell<T extends LabCell>(cell: T, factor: number): T {
  const scale = (point: CorridorPoint): CorridorPoint => ({ x: point.x * factor, y: point.y * factor });
  return {
    ...cell,
    polygon: cell.polygon.map(scale),
    ports: cell.ports.map((port) => ({
      ...port,
      midpoint: scale(port.midpoint),
      face: port.face ? [scale(port.face[0]), scale(port.face[1])] as const : undefined,
    })),
  };
}

/** Lab cell from a polygon whose own centre is `centre`, moved so the centre is the origin. */
function problemCell(id: string, label: string, polygon: CorridorPoint[], centre: CorridorPoint): LabCell {
  const local = polygon.map((point) => ({ x: point.x - centre.x, y: point.y - centre.y }));
  return {
    id,
    label,
    polygon: local,
    ports: local.map((vertex, index) => facePort(id, vertex, local[(index + 1) % local.length])),
  };
}

const PROBLEMS_VIEW_ID = "problems";

/** Ways a corridor contour used to leave its cell, kept to check their fixes visually. Examples were
 *  found by a sweep over random convex cells (thickness within the shortest face, as in a whole maze;
 *  cell centre at the vertex average, at least 15% of the cell size from every face). */
export const PROBLEM_TYPES: ProblemType[] = [
  {
    id: "junction-closure-arc",
    title: "Junction closure arc near a face",
    description: "Where two neighbouring corridor sides of a junction never cross (the outer edge of a wide gap between corridors), they are joined by an arc centred on the junction target, plus a straight piece to the farther side end. When the target sits close to a face, that arc used to cross it; now it is replaced by the deepest arc straight between the two side ends that fits, with a kink at each end. Each example uses its own corridor thickness (shown in its enlarged view).",
    examples: [
      { polygon: [{ x: 29.7, y: 24.9 }, { x: -26.6, y: 27 }, { x: -34.1, y: -21.1 }], centre: { x: -10.33, y: 10.27 }, mask: 0b111, thickness: 38.94 },
      { polygon: [{ x: 16.3, y: 35.2 }, { x: -21.3, y: -27.4 }, { x: 26.9, y: -7 }], centre: { x: 7.3, y: 0.27 }, mask: 0b111, thickness: 34.8 },
      { polygon: [{ x: 22, y: 25.6 }, { x: -16.6, y: 29.7 }, { x: 29.4, y: -15.6 }], centre: { x: 11.6, y: 13.23 }, mask: 0b111, thickness: 23.29 },
      { polygon: [{ x: 11, y: 36 }, { x: -3.4, y: 37.5 }, { x: -24.3, y: 28.5 }, { x: -32.3, y: -18.5 }, { x: -21.3, y: -30.9 }], centre: { x: -14.06, y: 10.52 }, mask: 0b11001, thickness: 11.58 },
      { polygon: [{ x: 21.6, y: 16.8 }, { x: -1.1, y: 20.6 }, { x: -24.2, y: 15.7 }, { x: 29.9, y: -12.4 }], centre: { x: 6.55, y: 10.18 }, mask: 0b1110, thickness: 22.78 },
    ].map((example, index) => ({
      cell: problemCell(`junction-closure-arc-${index + 1}`, `Junction closure arc #${index + 1}`, example.polygon, example.centre),
      mask: example.mask,
      thickness: example.thickness,
    })),
  },
];

const PROBLEM_EXAMPLES = PROBLEM_TYPES.flatMap((problem) => problem.examples);

export function prepareFamily(family: Family): PreparedFamily | null {
  const diagram = getTileDiagram(family.coordinate[0], family.coordinate[1], family.config);
  if (!diagram) return null;

  const portsByFace = diagram.sides.map((side) => facePort(family.id, side.v0, side.v1));
  const faceOrder = family.config.type.startsWith("cairo")
    ? cairoCanonicalFaceOrder(family.coordinate[0], family.coordinate[1])
    : [];
  const ports = faceOrder.length === portsByFace.length
    ? faceOrder.map((faceIndex) => portsByFace[faceIndex])
    : portsByFace;

  return {
    id: family.id,
    label: family.label,
    note: family.note,
    polygon: diagram.vertices,
    ports,
  };
}

const ORIGIN: CorridorPoint = { x: 0, y: 0 };

/** Builds one lab cell through the same segment adapter production uses: each selected port
 *  becomes a centre-to-centre segment record like `buildCorridorSegments` emits, and only the lab
 *  cell's own tile is built. In a whole maze every face kind carries some passage, and the engine
 *  clamps the corridor to the shortest face it sees, so the lab applies that clamp up front. */
export function labCellGeometry(cell: LabCell, mask: number, thickness: number, junctionRadius: number): {
  geometry: CorridorGeometryDebug | undefined;
  thickness: number;
} {
  const faceLengths = cell.ports.map(faceLength);
  const clampedThickness = Math.min(thickness, ...faceLengths);
  const segments: CorridorSegmentInput[] = cell.ports.flatMap((port, index) => (mask & (1 << index)) === 0 ? [] : [{
    v0: ORIGIN,
    // The neighbour's centre only names the neighbour's own tile, which the lab does not build.
    v1: { x: port.midpoint.x * 2, y: port.midpoint.y * 2 },
    faceMidpoint: port.midpoint,
    faceNormal: port.normal,
    faceLength: faceLengths[index],
    cellVertices0: cell.polygon,
  }]);
  const { cells, ports } = corridorSegmentsToGeometryInput(segments, clampedThickness);
  const ownCells = cells.filter((candidate) => candidate.center.x === ORIGIN.x && candidate.center.y === ORIGIN.y);
  const [geometry] = buildCorridorGeometryDebug(ownCells, ports, clampedThickness, junctionRadius);
  return { geometry, thickness: clampedThickness };
}

function maskLabel(mask: number, portCount: number): string {
  return mask.toString(2).padStart(portCount, "0");
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

function CombinationArtwork({ family, mask, thickness, cornerRadius, color, grayRendering, style, debugVisibility }: {
  family: LabCell;
  mask: number;
  thickness: number;
  cornerRadius: number;
  color: string;
  grayRendering: boolean;
  style: CSSProperties;
  debugVisibility?: DebugVisibility;
}) {
  const selected = family.ports.filter((_, index) => (mask & (1 << index)) !== 0);
  const { geometry: debug, thickness: clampedThickness } = labCellGeometry(family, mask, thickness, cornerRadius);
  const paths = debug?.contour ?? [];
  // Framed by the cell alone so the card does not move with the corridor thickness; a contour that
  // leaves the cell still draws past the frame (`overflow: visible` on the svg).
  const view = bounds(family.polygon);
  const renderColor = grayRendering ? "#858c94" : color;
  const label = maskLabel(mask, family.ports.length);
  const labelOffset = view.size * 0.07;
  const labelFontSize = view.size * 0.1;
  // Debug overlay stroke widths and point radii scale with the corridor, with a readable minimum.
  const debugSize = (minimum: number, factor: number) => Math.max(minimum, clampedThickness * factor) / 2;
  const debugContourStrokeWidth = debugSize(0.45, 0.045);
  const handleStrokeWidth = debugSize(0.35, 0.035);
  const handlePointRadius = debugSize(0.7, 0.08);
  const handleDash = `${Math.max(2, clampedThickness * 0.22)} ${Math.max(1.5, clampedThickness * 0.16)}`;

  return (
    <svg viewBox={`${view.minX} ${view.minY} ${view.size} ${view.size}`} preserveAspectRatio="xMidYMid meet" style={style} role="img" aria-label={`${family.label} combination ${label}`}>
      <polygon points={pointsAttribute(family.polygon)} fill="#20252b" stroke="#606a75" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {family.ports.map((port, index) => {
        const labelX = port.midpoint.x + port.normal.x * labelOffset;
        const labelY = port.midpoint.y + port.normal.y * labelOffset;
        return (
          <g key={index}>
            <line
              x1={port.face?.[0].x ?? port.midpoint.x}
              y1={port.face?.[0].y ?? port.midpoint.y}
              x2={port.face?.[1].x ?? port.midpoint.x}
              y2={port.face?.[1].y ?? port.midpoint.y}
              stroke="#87909a"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text x={labelX} y={labelY} textAnchor="middle" dominantBaseline="middle" fontSize={labelFontSize} fontWeight="600" fill="#d8dee5">{index}</text>
          </g>
        );
      })}
      {paths.map((path, index) => (
        <path key={index} d={contourToSvgPath([path])} fill={renderColor} />
      ))}
      {debugVisibility?.cellOutline && <polygon points={pointsAttribute(family.polygon)} fill="none" stroke="#e7ebef" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
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
          <circle cx={port.midpoint.x} cy={port.midpoint.y} r={handlePointRadius} fill="#fff" stroke="none" />
          <line x1={port.midpoint.x} y1={port.midpoint.y} x2={port.midpoint.x + port.normal.x * labelOffset * 0.8} y2={port.midpoint.y + port.normal.y * labelOffset * 0.8} stroke="#fff" strokeWidth={handleStrokeWidth} />
        </g>
      ))}
      {debugVisibility?.target && debug && (
        <circle cx={debug.target.x} cy={debug.target.y} r={debugSize(0.9, 0.09)} fill="#fff" stroke="none" />
      )}
    </svg>
  );
}

function CombinationCard({ family, mask, thickness, cornerRadius, color, grayRendering = false, expanded = false, onOpen, debugVisibility }: {
  family: LabCell;
  mask: number;
  thickness: number;
  cornerRadius: number;
  color: string;
  grayRendering?: boolean;
  expanded?: boolean;
  onOpen?: () => void;
  debugVisibility?: DebugVisibility;
}) {
  const selected = family.ports.filter((_, index) => (mask & (1 << index)) !== 0);
  const label = maskLabel(mask, family.ports.length);
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

function FamilySection({ family, thickness, cornerRadius, color, onOpen }: {
  family: PreparedFamily;
  thickness: number;
  cornerRadius: number;
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
            color={color}
            onOpen={() => onOpen(mask)}
          />
        ))}
      </div>
    </section>
  );
}

function ProblemSection({ problem, cornerRadius, onOpen }: {
  problem: ProblemType;
  cornerRadius: number;
  onOpen: (example: ProblemExample) => void;
}) {
  return (
    <section style={styles.section}>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.heading}>{problem.title}</h2>
          <div style={styles.muted}>{problem.description}</div>
        </div>
      </div>
      <div style={styles.grid}>
        {problem.examples.map((example) => (
          <CombinationCard
            key={example.cell.id}
            family={example.cell}
            mask={example.mask}
            thickness={example.thickness}
            cornerRadius={cornerRadius}
            color={COLORS[0]}
            onOpen={() => onOpen(example)}
          />
        ))}
      </div>
    </section>
  );
}

export function CorridorGeometryTestPage() {
  const [thickness, setThickness] = useState(12);
  const [cornerRadius, setCornerRadius] = useState(4);
  /** Cell size (longest face, px) chosen per family; absent means the family's native size. */
  const [cellSizes, setCellSizes] = useState<Record<string, number>>({});
  const [selectedFamilyId, setSelectedFamilyId] = useState(FAMILIES[0].id);
  const [expandedCard, setExpandedCard] = useState<ExpandedCard | null>(null);
  const [debugVisibility, setDebugVisibility] = useState<DebugVisibility>({
    ports: false,
    target: false,
    centerCurves: false,
    rawRibbonSides: false,
    ribbonSides: false,
    preCornerContour: false,
    cellOutline: false,
  });
  const [grayRendering, setGrayRendering] = useState(false);
  const nativeFamilies = useMemo(() => FAMILIES.map(prepareFamily).filter((family): family is PreparedFamily => family !== null), []);
  const families = useMemo(() => nativeFamilies.map((family) => {
    const size = cellSizes[family.id];
    return size === undefined ? family : scaleCell(family, size / cellSize(family));
  }), [nativeFamilies, cellSizes]);
  const selectedNativeFamily = nativeFamilies.find((family) => family.id === selectedFamilyId);
  const nativeCellSize = selectedNativeFamily ? Math.round(cellSize(selectedNativeFamily)) : 40;
  const selectedCellSize = cellSizes[selectedFamilyId] ?? nativeCellSize;
  const visibleFamilies = families.filter((family) => family.id === selectedFamilyId);
  const totalCombinations = visibleFamilies.reduce((sum, family) => sum + (1 << family.ports.length), 0);
  const familyColor = (family: PreparedFamily) => COLORS[families.indexOf(family) % COLORS.length];
  const showProblems = selectedFamilyId === PROBLEMS_VIEW_ID;
  const expandedFamily = expandedCard ? families.find((family) => family.id === expandedCard.cellId) : undefined;
  const expandedExample = expandedCard ? PROBLEM_EXAMPLES.find((example) => example.cell.id === expandedCard.cellId) : undefined;
  const expandedCell = expandedFamily ?? expandedExample?.cell;

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
          {/* Problem examples carry their own thickness and cell geometry. */}
          {!showProblems && (
            <>
              <label style={styles.control}>
                <span>Corridor thickness: <strong>{thickness}px</strong></span>
                <input className="maze-slider" type="range" min={2} max={40} step={1} value={thickness} onChange={(event) => setThickness(Number(event.target.value))} />
              </label>
              <label style={styles.control}>
                <span>Cell size (longest face): <strong>{selectedCellSize}px</strong></span>
                <input
                  className="maze-slider"
                  type="range"
                  min={10}
                  max={nativeCellSize * 2}
                  step={1}
                  value={selectedCellSize}
                  onChange={(event) => setCellSizes((current) => ({ ...current, [selectedFamilyId]: Number(event.target.value) }))}
                />
              </label>
            </>
          )}
          <label style={styles.control}>
            <span>Junction corner radius: <strong>{cornerRadius}px</strong></span>
            <input className="maze-slider" type="range" min={0} max={20} step={0.5} value={cornerRadius} onChange={(event) => setCornerRadius(Number(event.target.value))} />
          </label>
        </div>
      </header>
      <div style={styles.familySelector}>
        <label style={styles.selectorControl}>
          <span style={styles.selectorLabel}>Show tessellation:</span>
          <select value={selectedFamilyId} onChange={(event) => setSelectedFamilyId(event.target.value)} style={styles.select}>
            {families.map((family) => <option key={family.id} value={family.id}>{family.label}</option>)}
            <option value={PROBLEMS_VIEW_ID}>Overflow problems</option>
          </select>
        </label>
      </div>
      </div>
      <div style={styles.dynamicSummary}>
        {showProblems
          ? `${PROBLEM_TYPES.length} problem types · ${PROBLEM_EXAMPLES.length} examples`
          : `Total combinations: ${totalCombinations} · ${visibleFamilies.length} of ${families.length} tessellations shown`}
      </div>
      {showProblems && PROBLEM_TYPES.map((problem) => (
        <ProblemSection
          key={problem.id}
          problem={problem}
          cornerRadius={cornerRadius}
          onOpen={(example) => setExpandedCard({ cellId: example.cell.id, mask: example.mask })}
        />
      ))}
      {visibleFamilies.map((family) => (
        <FamilySection
          key={family.id}
          family={family}
          thickness={thickness}
          cornerRadius={cornerRadius}
          color={familyColor(family)}
          onOpen={(mask) => setExpandedCard({ cellId: family.id, mask })}
        />
      ))}
      {expandedCard && expandedCell && (
        <div style={styles.modalBackdrop} onMouseDown={() => setExpandedCard(null)}>
          <div
            style={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label={`${expandedCell.label} combination ${maskLabel(expandedCard.mask, expandedCell.ports.length)}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div style={styles.modalHeader}>
              <div>
                <h2 style={styles.modalTitle}>{expandedCell.label}</h2>
                <div style={styles.muted}>
                  Combination {maskLabel(expandedCard.mask, expandedCell.ports.length)}
                  {expandedExample && ` · thickness ${expandedExample.thickness}px`}
                </div>
              </div>
              <button type="button" style={styles.modalClose} onClick={() => setExpandedCard(null)} aria-label="Close enlarged sample"><span style={styles.closeGlyph}>×</span></button>
            </div>
            <div style={styles.modalBody}>
              <CombinationCard
                family={expandedCell}
                mask={expandedCard.mask}
                thickness={expandedExample?.thickness ?? thickness}
                cornerRadius={cornerRadius}
                color={expandedFamily ? familyColor(expandedFamily) : COLORS[0]}
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
                  ["cellOutline", "Cell outline on top"],
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
  dynamicSummary: { maxWidth: 1800, margin: "0 auto 12px", color: "#7e8995", fontSize: 12 },
  settingsPanel: { position: "sticky", top: 0, zIndex: 10, maxWidth: 1800, margin: "-24px auto 28px", padding: "18px 0 12px", background: "#15181c", boxShadow: "0 8px 14px -14px #000" },
  familySelector: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, maxWidth: 1800, margin: "0 auto 10px", paddingTop: 2, color: "#c3cbd4", fontSize: 13 },
  selectorControl: { display: "inline-flex", alignItems: "center", gap: 8 },
  selectorLabel: { color: "#7e8995" },
  select: { minWidth: 150, padding: "4px 8px", border: "1px solid #4a545e", borderRadius: 4, background: "#20252b", color: "#e7ebef", fontSize: 13 },
  section: { maxWidth: 1800, margin: "0 auto 34px" },
  sectionHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 },
  heading: { margin: 0, fontSize: 18, fontWeight: 600 },
  muted: { marginTop: 3, color: "#87929e", fontSize: 12 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(142px, 1fr))", gap: 8 },
  card: { minWidth: 0, padding: 7, background: "#1d2228", border: "1px solid #303840", borderRadius: 5, cursor: "zoom-in", outline: "none" },
  svg: { display: "block", width: "100%", height: 122, background: "#171b20", borderRadius: 3, overflow: "visible" },
  expandedCard: { padding: 12, background: "#1d2228", border: "1px solid #303840", borderRadius: 5 },
  expandedSvg: { display: "block", width: "100%", height: "min(70vh, 560px)", minHeight: 280, background: "#171b20", borderRadius: 3, overflow: "visible" },
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
