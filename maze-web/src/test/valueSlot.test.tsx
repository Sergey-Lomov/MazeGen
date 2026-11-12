import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VALUE_SLOT, withValueNode } from "../components/dialogs/valueSlot";

function textOf(message: string, node: string): string {
  const { container } = render(<span>{withValueNode(message, node)}</span>);
  return container.textContent ?? "";
}

describe("withValueNode", () => {
  it("puts the node where the value was, keeping the label and the unit", () => {
    expect(textOf(`Side ${VALUE_SLOT} mm`, "—")).toBe("Side — mm");
  });

  it("keeps a message without the slot as it is", () => {
    expect(textOf("Total", "—")).toBe("Total");
  });

  it("puts the node at every occurrence of the slot", () => {
    expect(textOf(`${VALUE_SLOT} of ${VALUE_SLOT}`, "—")).toBe("— of —");
  });
});
