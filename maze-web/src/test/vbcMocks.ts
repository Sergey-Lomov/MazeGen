import { vi } from "vitest";


// Minimal stand-in for Pixi v8's `Bounds` (`getRequiredExportMargin`'s pixel-accurate path
// only ever reads `.minX/.minY/.maxX/.maxY` and calls `.clone()`/`.addBounds()`).
export interface FakeBounds { minX: number; minY: number; maxX: number; maxY: number; clone(): FakeBounds; addBounds(b: FakeBounds): void }
export function makeBounds(minX: number, minY: number, maxX: number, maxY: number): FakeBounds {
  return {
    minX, minY, maxX, maxY,
    clone() { return makeBounds(this.minX, this.minY, this.maxX, this.maxY); },
    addBounds(b: FakeBounds) {
      this.minX = Math.min(this.minX, b.minX);
      this.minY = Math.min(this.minY, b.minY);
      this.maxX = Math.max(this.maxX, b.maxX);
      this.maxY = Math.max(this.maxY, b.maxY);
    },
  };
}
export function makeEmptyBounds(): FakeBounds {
  return makeBounds(Infinity, Infinity, -Infinity, -Infinity);
}


/** Shared mutable store stand-in: tests set `current` and fire `subscribeCallback`. */
export const mockStore: { current: Record<string, unknown>; subscribeCallback: ((state: unknown) => void) | null } = {
  current: {},
  subscribeCallback: null,
};

export const mazeSelectorsMock = () => ({
  buildCorridorSegments: vi.fn(() => []),
  shortestCorridorFaceAcrossFloors: vi.fn(() => Infinity),
  buildMazeMarkers: vi.fn(() => []),
  buildTeleportEdges: vi.fn(() => []),
  buildTeleportFloorInputs: vi.fn((opts: { unscopedEdges: unknown; allowOutOfField: boolean; fieldCells?: unknown }) => ({
    floorContext: { resolveNodeLevel: () => undefined, unscopedNodeById: new Map(), unscopedEdges: opts.unscopedEdges, activeFloorIndex: 0 },
    spread: { blockedCellsByFloor: new Map(), allowOutOfField: opts.allowOutOfField, ...(opts.fieldCells ? { fieldCells: opts.fieldCells } : {}) },
  })),
  buildSplitPassages: vi.fn(() => ({ passages: [], wallFaces: [], specialShapes: [] })),
  maxSplitNodeCount: vi.fn(() => 0),
  buildVerticalConnectionMarkers: vi.fn(() => []),
  buildTeleportAvoidanceWaypoints: vi.fn((sources: { markers?: { pos: [number, number] }[] }) => (sources.markers ?? []).map((m) => m.pos)),
  selectNodeLevelResolver: vi.fn(() => () => undefined),
  selectVerticalPassagePairSet: vi.fn(() => new Set()),
  selectFloorScopedMaze: vi.fn((nodes: unknown[], edges: unknown[], _floors: unknown, _activeFloorId: unknown, start: number | null = null, finish: number | null = null) => ({
    nodes, edges, start, finish,
  })),
});

export const wallRendererMock = () => ({
  chainSegmentsAtSharedVertices: vi.fn(() => []),
});

export const teleportRendererMock = () => ({
  TeleportRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
});

export const verticalConnectionRendererMock = () => ({
  VerticalConnectionRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
});

export const gridRendererMock = () => ({
  GridRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
});

export const mazeStoreMock = () => ({
  useMazeStore: {
    getState: vi.fn(() => mockStore.current),
    subscribe: vi.fn((cb: (state: unknown) => void) => {
      mockStore.subscribeCallback = cb;
      return () => { mockStore.subscribeCallback = null; };
    }),
  },
});

export const pixiMock = () => ({
  Container: vi.fn().mockImplementation(function (this: { addChild: () => void; addChildAt: () => void; removeChildren: () => unknown[]; destroy: () => void; visible: boolean; getLocalBounds: () => unknown }) {
    this.addChild = vi.fn();
    this.addChildAt = vi.fn();
    this.removeChildren = vi.fn(() => []);
    this.destroy = vi.fn();
    this.visible = false;
    // Empty by default (Infinity/-Infinity, pixi's own "nothing drawn" convention) — tests that
    // care about `getRequiredExportMargin`'s pixel-accurate path override this per-container.
    this.getLocalBounds = vi.fn(() => makeEmptyBounds());
  }),
  Graphics: vi.fn().mockImplementation(function (this: { clear: () => void; moveTo: () => unknown; lineTo: () => unknown; arcTo: () => unknown; arc: () => unknown; quadraticCurveTo: () => unknown; bezierCurveTo: () => unknown; closePath: () => unknown; stroke: () => unknown; circle: () => unknown; poly: () => unknown; rect: () => unknown; fill: () => unknown; setStrokeStyle: () => unknown; addChild: () => void; removeChildren: () => unknown[]; destroy: () => void }, context?: unknown) {
    this.clear = vi.fn();
    this.moveTo = vi.fn(() => this);
    this.lineTo = vi.fn(() => this);
    this.arcTo = vi.fn(() => this);
    this.arc = vi.fn(() => this);
    this.quadraticCurveTo = vi.fn(() => this);
    this.bezierCurveTo = vi.fn(() => this);
    this.closePath = vi.fn(() => this);
    this.stroke = vi.fn(() => this);
    this.circle = vi.fn(() => this);
    this.poly = vi.fn(() => this);
    this.rect = vi.fn(() => this);
    this.fill = vi.fn(() => this);
    this.setStrokeStyle = vi.fn(() => this);
    this.addChild = vi.fn();
    this.removeChildren = vi.fn(() => []);
    this.destroy = vi.fn();
    (this as unknown as { context: unknown }).context = context;
    (this as unknown as { position: { set: () => void } }).position = { set: vi.fn() };
  }),
  GraphicsContext: vi.fn().mockImplementation(function (this: { moveTo: () => unknown; lineTo: () => unknown; arc: () => unknown; quadraticCurveTo: () => unknown; bezierCurveTo: () => unknown; closePath: () => unknown; fill: () => unknown; destroy: () => void }) {
    this.moveTo = vi.fn(() => this);
    this.lineTo = vi.fn(() => this);
    this.arc = vi.fn(() => this);
    this.quadraticCurveTo = vi.fn(() => this);
    this.bezierCurveTo = vi.fn(() => this);
    this.closePath = vi.fn(() => this);
    this.fill = vi.fn(() => this);
    (this as unknown as { stroke: () => unknown }).stroke = vi.fn(() => this);
    (this as unknown as { circle: () => unknown }).circle = vi.fn(() => this);
    this.destroy = vi.fn();
  }),
});
