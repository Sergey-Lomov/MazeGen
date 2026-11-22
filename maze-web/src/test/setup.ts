import "@testing-library/jest-dom";
import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initWasm } from "../wasm/wasmLoader";

// The real `maze-core` module (built by `scripts/wasm-rebuild.sh`), so suites exercise core geometry and
// field presets instead of TypeScript stand-ins.
await initWasm(readFileSync(resolve(process.cwd(), "src/wasm/pkg/maze_wasm_bg.wasm")));
import { SIDE_PANEL_SLOT_ID } from "../components/sidePanelSlot";

// The store installs the auto zone sync when it is created, and its debounce timer would fire inside any test that
// sets up floors by hand (ids with no field behind them). Suites that test the sync opt back in with
// `vi.mock("../store/autoZoneSync", (importOriginal) => importOriginal())`.
vi.mock("../store/autoZoneSync", async (importOriginal) => ({ ...(await importOriginal<object>()), installAutoZoneSync: () => {} }));

// `SidePanel` portals into this DOM node (see `App.tsx`) — every test render needs it present the
// same way the real app always does, or any component using `SidePanel` silently renders nothing.
if (typeof document !== "undefined" && !document.getElementById(SIDE_PANEL_SLOT_ID)) {
  const slot = document.createElement("div");
  slot.id = SIDE_PANEL_SLOT_ID;
  document.body.appendChild(slot);
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = () => null;
}
