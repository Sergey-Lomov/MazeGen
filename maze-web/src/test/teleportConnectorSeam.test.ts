import { describe, it, expect, vi } from "vitest";
import { routeTeleportConnectors } from "../pixi/renderers/teleportConnectorPlan";
import { TeleportConnectorRouter } from "../pixi/renderers/teleportConnectorRouter";
import type { TeleportEdge, TeleportLineStyle } from "../pixi/renderers/types";
import { DEFAULT_MAZE_RENDER_STYLE } from "../pixi/defaultMazeRenderStyle";
import type { FieldConfig } from "../fieldConfig";
import { buildSeamModel, type SeamCellInput, type SeamModel } from "../pixi/selectors/seams";
import type { FoldFace } from "../wasm/mazeService";

// GitHub issue #873: a connector goes through a seam whenever that is shorter than the direct one, as
// if the field continued beyond the glue. The seam model needs a warm geometry snapshot, so it is
// swapped for hand-made ones; the display transform is the identity.
let model: SeamModel;
vi.mock("../pixi/selectors/seams", async (importActual) => ({
  ...(await importActual<typeof import("../pixi/selectors/seams")>()),
  getSeamModel: () => model,
}));
vi.mock("../pixi/tessellationGeometry", () => ({ displayTransform: () => ({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }) }));

const seam = { cfg: {} as FieldConfig };

/// A 10-wide strip of `rows` rows whose west edge (x = 0) is glued to the east edge (x = 10): cells
/// (0,r) and (9,r), one seam per row, all with the same unfold.
function stripModel(isometric: boolean, rows = 1): SeamModel {
  const fold = (id: number, partner: [number, number], shift: number): FoldFace => ({
    fold: id, partner_cell: partner, partner_face_idx: 0, twist: false, start_meets: "end", isometric,
    transform: isometric ? [1, 0, 0, 1, shift, 0] : null,
  });
  const cell = (cell: [number, number], x: number, partner: [number, number], shift: number): SeamCellInput => ({
    cell,
    center: [x + (x === 0 ? 0.5 : -0.5), cell[1] + 0.5],
    faces: [{ contact_point: [x, cell[1] + 0.5], segments: [{ kind: "line", from: [x, cell[1]], to: [x, cell[1] + 1] }], fold: fold(cell[1], partner, shift) }],
  });
  // West cell sees the east cell shifted by -10 into its own frame, and the other way round.
  const cells: SeamCellInput[] = [];
  for (let r = 0; r < rows; r++) cells.push(cell([0, r], 0, [9, r], -10), cell([9, r], 10, [0, r], 10));
  return buildSeamModel(cells);
}

function plan(edges: TeleportEdge[], connectorStyle: TeleportLineStyle["connectorStyle"], withSeam = true) {
  return routeTeleportConnectors({
    router: new TeleportConnectorRouter(),
    edges,
    style: { ...DEFAULT_MAZE_RENDER_STYLE.teleport, connectorStyle },
    cfg: undefined,
    waypoints: [],
    avoidFieldExit: false,
    fieldCells: [],
    markerMaxFactor: 1,
    seam: withSeam ? seam : undefined,
  });
}

/// Every segment of every piece is horizontal or vertical (a straight fallback would be diagonal).
function expectAxisAligned(pieces: number[][]): void {
  for (const piece of pieces) {
    for (let i = 0; i + 3 < piece.length; i += 2) {
      expect(Math.min(Math.abs(piece[i + 2] - piece[i]), Math.abs(piece[i + 3] - piece[i + 1]))).toBeCloseTo(0, 6);
    }
  }
}

const farApart: TeleportEdge = { from: [0.5, 0.5], to: [9.5, 0.5], oneWay: false };

describe("routeTeleportConnectors seam-aware routing", () => {
  it("without a seam context the connector stays one line across the field", () => {
    model = stripModel(true);
    const [routed] = plan([farApart], "straight", false);
    expect(routed.points).toEqual([0.5, 0.5, 9.5, 0.5]);
    expect(routed.partnerPoints).toBeUndefined();
  });

  it("an aligned pair is joined by a straight line across the seam", () => {
    model = stripModel(true);
    const [routed] = plan([farApart], "straight");
    expect(routed.points).toEqual([0.5, 0.5, 0, 0.5]);
    expect(routed.partnerPoints).toEqual([10, 0.5, 9.5, 0.5]);
  });

  it.each(["straight", "orthogonal", "curved"] as const)("%s keeps its own shape across the seam: pieces run from source to the west face and from the east face to target", (connectorStyle) => {
    model = stripModel(true);
    const [routed] = plan([{ from: [0.5, 0.2], to: [9.5, 0.8], oneWay: false }], connectorStyle);
    const first = routed.points;
    const second = routed.partnerPoints!;
    expect(first.slice(0, 2)).toEqual([0.5, 0.2]);
    expect(first[first.length - 2]).toBeCloseTo(0, 6);
    expect(second[0]).toBeCloseTo(10, 6);
    expect(second.slice(-2)).toEqual([9.5, 0.8]);
    // The pieces meet at the same height on the two faces, as the glued faces do.
    expect(second[1]).toBeCloseTo(first[first.length - 1], 6);
  });

  it("an orthogonal connector across the seam keeps its bend", () => {
    model = stripModel(true);
    const [routed] = plan([{ from: [0.5, 0.2], to: [9.5, 0.8], oneWay: false }], "orthogonal");
    expectAxisAligned([routed.points, routed.partnerPoints!]);
    // A bend: some piece turns, i.e. has a vertex whose neighbours differ in both x and y.
    const turns = [routed.points, routed.partnerPoints!].some((piece) => {
      for (let i = 2; i + 3 < piece.length; i += 2) {
        if (Math.abs(piece[i + 2] - piece[i - 2]) > 1e-6 && Math.abs(piece[i + 3] - piece[i - 1]) > 1e-6) return true;
      }
      return false;
    });
    expect(turns).toBe(true);
  });

  it("keeps the direct connector when it is shorter than the way through the seam", () => {
    model = stripModel(true);
    const [routed] = plan([{ from: [4, 0.5], to: [6, 0.5], oneWay: false }], "straight");
    expect(routed.points).toEqual([4, 0.5, 6, 0.5]);
    expect(routed.partnerPoints).toBeUndefined();
  });

  it("a topological-only seam is unfolded from its chain ends: far cells are joined across it too", () => {
    model = stripModel(false);
    const [routed] = plan([farApart], "straight");
    expect(routed.points[routed.points.length - 2]).toBeCloseTo(0, 6);
    expect(routed.partnerPoints![0]).toBeCloseTo(10, 6);
    expect(routed.partnerPoints!.slice(-2)).toEqual([9.5, 0.5]);
    expect(routed.partnerPoints![1]).toBeCloseTo(routed.points[routed.points.length - 1], 6);
  });

  it("a topological-only seam keeps the direct connector when it is shorter", () => {
    model = stripModel(false);
    const [routed] = plan([{ from: [4, 0.5], to: [6, 0.5], oneWay: false }], "straight");
    expect(routed.partnerPoints).toBeUndefined();
  });

  it("a routed shape that leaves the field through a neighbouring face of the same glue is still cut there", () => {
    model = stripModel(true, 2);
    const [routed] = plan([{ from: [9.5, 0.2], to: [0.5, 1.6], oneWay: false }], "orthogonal");
    expect(routed.partnerPoints).toBeDefined();
    expect(routed.points[routed.points.length - 2]).toBeCloseTo(10, 6);
    expect(routed.partnerPoints![0]).toBeCloseTo(0, 6);
    expect(routed.partnerPoints!.slice(-2)).toEqual([0.5, 1.6]);
    expect(routed.partnerPoints![1]).toBeCloseTo(routed.points[routed.points.length - 1], 6);
    expectAxisAligned([routed.points, routed.partnerPoints!]);
  });
});
