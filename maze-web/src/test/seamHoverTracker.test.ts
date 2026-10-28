import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { HOVER_DELAY_MS, SeamHoverTracker } from "../pixi/SeamHoverTracker";

// Which arrow or pair the pointer is over comes from the arrow hit-tests, mocked here as "the pointer's x is the
// arrow index, its y the pair index"; what is under test is when the focus reaches the store.
vi.mock("../pixi/seamArrowSync", () => ({ selectSeamArrowData: () => ({ arrows: [{ id: 0, width: 1 }, { id: 1, width: 1 }, { id: 2, width: 1 }], focus: null }) }));
vi.mock("../pixi/selectors/seamArrows", () => ({
  arrowContains: (arrow: { id: number }, at: [number, number]) => arrow.id === at[0],
  pairAt: (_arrow: unknown, at: [number, number], _reach: number, cells: boolean) => (cells ? at[1] : null),
}));

type Handler = (event: { globalX: number; globalY: number }) => void;

function setup() {
  const handlers = new Map<string, Handler>();
  const stage = { on: (name: string, handler: Handler) => handlers.set(name, handler), off: (name: string) => handlers.delete(name) };
  const viewport = { toLocal: ({ x, y }: { x: number; y: number }) => ({ x, y }), scale: { x: 1 } };
  const tracker = new SeamHoverTracker(viewport as unknown as Container, stage as unknown as Container);
  const move = (arrow: number, pair: number) => handlers.get("pointermove")!({ globalX: arrow, globalY: pair });
  return { tracker, move, leave: () => handlers.get("pointerleave")!({ globalX: 0, globalY: 0 }) };
}

describe("SeamHoverTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useMazeStore.setState({ openCard: "field_setup", seamHover: null, topologyGlueEditor: null });
  });
  afterEach(() => vi.useRealTimers());

  it("focuses an arrow only after the pointer has rested on it", () => {
    const { move } = setup();
    move(1, 0);
    expect(useMazeStore.getState().seamHover).toBeNull();
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(useMazeStore.getState().seamHover).toEqual({ arrow: 1, pair: 0 });
  });

  it("does not focus an arrow the pointer only passes over", () => {
    const { move } = setup();
    move(1, 0);
    vi.advanceTimersByTime(HOVER_DELAY_MS / 2);
    move(-1, 0);
    vi.advanceTimersByTime(HOVER_DELAY_MS * 2);
    expect(useMazeStore.getState().seamHover).toBeNull();
  });

  it("drops the focus at once on leaving, and moves it at once between arrows", () => {
    const { move, leave } = setup();
    move(1, 0);
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    move(2, 1);
    expect(useMazeStore.getState().seamHover).toEqual({ arrow: 2, pair: 1 });
    leave();
    expect(useMazeStore.getState().seamHover).toBeNull();
  });

  it("gives no pair focus while a glue is added or edited", () => {
    useMazeStore.setState({ topologyGlueEditor: { mode: "add" } });
    const { move } = setup();
    move(1, 2);
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(useMazeStore.getState().seamHover).toEqual({ arrow: 1, pair: null });
  });

  it("does not focus when the card closed while the delay ran", () => {
    const { move } = setup();
    move(1, 0);
    useMazeStore.setState({ openCard: undefined });
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(useMazeStore.getState().seamHover).toBeNull();
  });

  it("drops a pending focus on destroy", () => {
    const { tracker, move } = setup();
    move(1, 0);
    tracker.destroy();
    vi.advanceTimersByTime(HOVER_DELAY_MS * 2);
    expect(useMazeStore.getState().seamHover).toBeNull();
  });
});
