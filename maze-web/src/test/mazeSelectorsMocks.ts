import { vi } from "vitest";

export const pixiMock = () => ({
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
  Graphics: vi.fn(() => ({ rect: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), poly: vi.fn() })),
});

export const mazeStoreMock = () => ({
  useMazeStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) },
});
