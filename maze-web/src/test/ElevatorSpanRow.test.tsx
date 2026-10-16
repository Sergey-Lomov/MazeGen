import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ElevatorSpanRow } from "../components/ElevatorSpanRow";
import * as m from "~/paraglide/messages";

function StatefulRow() {
  const [min, setMin] = useState(2);
  const [max, setMax] = useState(4);
  return <ElevatorSpanRow min={min} max={max} onMinChange={setMin} onMaxChange={setMax} />;
}

describe("ElevatorSpanRow", () => {
  it("uses NumberInput normalization and explains the minimum clamp", () => {
    render(<StatefulRow />);
    const input = document.querySelector('input[name="elevator-span-min"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("1");
    expect(screen.getByTestId("field-hint")).toHaveTextContent(
      m["input_hint.clamped_min"]({ min: "1", max: "∞" }),
    );
  });
});
