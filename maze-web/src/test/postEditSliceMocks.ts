import { vi } from "vitest";

/** Shared `vi.mock` factories for the `postEditSlice.*.test.ts` files. `vi.mock` itself is hoisted
 *  and must stay in each test file; it reaches this module through a dynamic `import()` so the
 *  factory never touches the store (which would re-enter the mock being built). */

type MazeService = typeof import("../wasm/mazeService");
type WasmLoader = typeof import("../wasm/wasmLoader");

/** Keeps the pure geometry helpers real; stubs generation and analytics. */
export function mazeServiceMock(actual: MazeService) {
  return {
    getFieldPreset: actual.getFieldPreset,
    getFieldCapabilities: actual.getFieldCapabilities,
    translateFieldCells: actual.translateFieldCells,
    reflectFieldCells: actual.reflectFieldCells,
    getGeometrySnapshot: actual.getGeometrySnapshot,
    getCellAt: actual.getCellAt,
    getCellsInRegion: actual.getCellsInRegion,
    generateMaze: vi.fn(),
    computeAnalyticsAsync: vi.fn(),
    computeAnalytics: vi.fn(),
    getAvailableChecks: vi.fn(() => []),
    getAvailableStrategies: vi.fn(() => []),
  };
}

export function wasmLoaderMock(actual: WasmLoader) {
  return { ...actual, initWasm: vi.fn(() => Promise.resolve()) };
}
