import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { StepSlider } from "../components/StepSlider";

// `handleChange` throttles onChange to one call per rAF — mock it to run synchronously so tests
// don't need to await a real animation frame.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StepSlider", () => {
  it("calls onChange on every input tick", () => {
    const onChange = vi.fn();
    const { getByRole } = render(<StepSlider value={0} max={10} onChange={onChange} />);
    fireEvent.change(getByRole("slider"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("does not call onChangeEnd on an ordinary input tick — only onChange", () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { getByRole } = render(<StepSlider value={0} max={10} onChange={onChange} onChangeEnd={onChangeEnd} />);
    fireEvent.change(getByRole("slider"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith(3);
    expect(onChangeEnd).not.toHaveBeenCalled();
  });

  it("calls onChangeEnd with the last delivered value once the drag settles (pointerup)", () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { getByRole } = render(<StepSlider value={0} max={10} onChange={onChange} onChangeEnd={onChangeEnd} />);
    const slider = getByRole("slider");
    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.change(slider, { target: { value: "7" } });
    fireEvent.pointerUp(slider);
    expect(onChangeEnd).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).toHaveBeenCalledWith(7);
  });

  it("works with no onChangeEnd provided at all — settle events are simply ignored", () => {
    const onChange = vi.fn();
    const { getByRole } = render(<StepSlider value={0} max={10} onChange={onChange} />);
    const slider = getByRole("slider");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(() => fireEvent.pointerUp(slider)).not.toThrow();
  });

  it("flushes a still-pending rAF tick synchronously when the drag settles before the frame fires", () => {
    // Unlike this file's default synchronous rAF stub (top of file), this test controls exactly
    // when the queued callback runs — so `handleEnd`'s own `flush()` call (cancelling the pending
    // rAF and delivering its value immediately) is the thing actually exercised, not the browser's
    // own frame callback beating it to it.
    let queued: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queued = cb;
      return 1;
    });
    const cancelled: number[] = [];
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { cancelled.push(id); });

    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { getByRole } = render(<StepSlider value={0} max={10} onChange={onChange} onChangeEnd={onChangeEnd} />);
    const slider = getByRole("slider");

    fireEvent.change(slider, { target: { value: "5" } });
    expect(onChange).not.toHaveBeenCalled(); // still queued, not yet delivered
    expect(queued).not.toBeNull();

    fireEvent.pointerUp(slider);
    expect(cancelled).toEqual([1]); // the pending rAF was cancelled, not left to fire later
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(5);
    expect(onChangeEnd).toHaveBeenCalledWith(5);
  });
});
