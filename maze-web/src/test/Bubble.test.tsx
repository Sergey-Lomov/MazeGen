import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Bubble, BubbleArrow, BubbleHoverZone, BubbleHoverZones, bubbleColors } from "../components/Bubble";
import { ui } from "../styles/theme";

describe("Bubble", () => {
  it("colours each variant from its own palette", () => {
    render(
      <>
        <Bubble>neutral</Bubble>
        <Bubble variant="success">success</Bubble>
        <Bubble variant="danger">danger</Bubble>
      </>,
    );

    expect(bubbleColors("neutral")).toEqual(ui.debug.refHighlight);
    expect(bubbleColors("success")).toEqual({ bg: ui.bg.success, text: ui.text.success });
    expect(bubbleColors("danger")).toEqual({ bg: ui.bg.error, text: ui.text.error });
    const palettes = ["neutral", "success", "danger"].map((name) => screen.getByText(name).style.borderColor);
    expect(new Set(palettes).size).toBe(3);
  });

  it("lets explicit colours win over the variant", () => {
    render(
      <>
        <Bubble variant="danger" colors={ui.topology.runA}>override</Bubble>
        <Bubble colors={ui.topology.runA}>reference</Bubble>
        <Bubble variant="danger">danger</Bubble>
      </>,
    );

    const borderOf = (name: string) => screen.getByText(name).style.borderColor;
    expect(borderOf("override")).toBe(borderOf("reference"));
    expect(borderOf("override")).not.toBe(borderOf("danger"));
  });

  it("shows the pointer cursor only when interactive", () => {
    render(
      <>
        <Bubble>plain</Bubble>
        <Bubble interactive>clickable</Bubble>
      </>,
    );

    expect(screen.getByText("plain").style.cursor).toBe("default");
    expect(screen.getByText("clickable").style.cursor).toBe("pointer");
  });

  it("passes handlers and attributes through and merges style last", () => {
    const onClick = vi.fn();
    render(<Bubble data-testid="chip" onClick={onClick} style={{ whiteSpace: "normal" }}>x</Bubble>);

    const chip = screen.getByTestId("chip");
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(chip.style.whiteSpace).toBe("normal");
  });

  it("uses body typography for the body size", () => {
    render(
      <>
        <Bubble>caption</Bubble>
        <Bubble size="body">body</Bubble>
      </>,
    );

    expect(screen.getByText("body").style.fontSize).not.toBe(screen.getByText("caption").style.fontSize);
  });
});

describe("BubbleHoverZone", () => {
  it("pads each zone instead of spacing them, so neighbours touch", () => {
    render(
      <BubbleHoverZones data-testid="zones">
        <BubbleHoverZone data-testid="zone"><Bubble>a</Bubble></BubbleHoverZone>
      </BubbleHoverZones>,
    );

    expect(screen.getByTestId("zones").style.flexWrap).toBe("wrap");
    expect(screen.getByTestId("zones").style.gap).toBe("");
    expect(screen.getByTestId("zone").style.padding).not.toBe("");
  });

  it("passes hover handlers through and merges style last", () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    render(
      <BubbleHoverZones style={{ paddingLeft: 7 }} data-testid="zones">
        <BubbleHoverZone data-testid="zone" onMouseEnter={onEnter} onMouseLeave={onLeave} style={{ cursor: "pointer" }}>
          <Bubble>a</Bubble>
        </BubbleHoverZone>
      </BubbleHoverZones>,
    );

    const zone = screen.getByTestId("zone");
    fireEvent.mouseEnter(zone);
    fireEvent.mouseLeave(zone);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(zone.style.cursor).toBe("pointer");
    expect(screen.getByTestId("zones").style.paddingLeft).toBe("7px");
  });
});

describe("BubbleArrow", () => {
  it("renders the glyph without wrapping and passes handlers and style through", () => {
    const onEnter = vi.fn();
    render(<BubbleArrow onMouseEnter={onEnter} style={{ justifySelf: "center" }}>↔</BubbleArrow>);

    const arrow = screen.getByText("↔");
    fireEvent.mouseEnter(arrow);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(arrow.style.whiteSpace).toBe("nowrap");
    expect(arrow.style.justifySelf).toBe("center");
  });
});
