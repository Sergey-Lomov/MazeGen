import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ColorChannelInput } from "../components/ColorChannelInput";
import * as m from "~/paraglide/messages";

function StatefulChannel({ initial = "50", onValue = vi.fn() }: { initial?: string; onValue?: (value: number) => void }) {
  const [raw, setRaw] = useState(initial);
  return (
    <ColorChannelInput
      name="channel"
      value={raw}
      max={100}
      step={1}
      ariaLabel="Channel value"
      onInput={(result) => {
        setRaw(result.raw);
        if (result.value !== null) onValue(result.value);
      }}
      onBlur={() => setRaw("50")}
    />
  );
}

describe("ColorChannelInput", () => {
  it("does not hint for valid typed input", () => {
    render(<StatefulChannel />);
    const input = screen.getByLabelText("Channel value");
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.blur(input);
    expect(screen.queryByTestId("field-hint")).toBeNull();
  });

  it("delays a typed range-clamp hint until blur", () => {
    const onValue = vi.fn();
    render(<StatefulChannel onValue={onValue} />);
    const input = screen.getByLabelText("Channel value");
    fireEvent.change(input, { target: { value: "150" } });
    expect(onValue).toHaveBeenLastCalledWith(100);
    expect(screen.queryByTestId("field-hint")).toBeNull();
    fireEvent.blur(input);
    expect(screen.getByTestId("field-hint")).toHaveTextContent(
      m["input_hint.clamped_max"]({ min: "0", max: "100" }),
    );
  });
});
