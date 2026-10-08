import { describe, it, expect } from "vitest";
import { applyModifiers, applyColorModifiers, type ColorModifier, type ParamLink } from "../store/parameterLinks";
import { colorToRgb, colorToHsl, colorToOklch } from "../store/colorMath";
import { VECTOR_BY_WALLS_PARAM_REGISTRY } from "../store/parameterLinksRegistry";
import { addLink, propagate, writeLinkedParam, applyLinkedPatch, propagateLinkedSources } from "../store/slices/parameterLinksEngine";

describe("applyModifiers", () => {
  it("returns the raw value when there is no chain", () => {
    expect(applyModifiers(5, undefined)).toBe(5);
    expect(applyModifiers(5, [])).toBe(5);
  });

  it("applies each step to the previous step's result, in order", () => {
    expect(applyModifiers(5, [{ op: "add", value: 3 }, { op: "mul", value: 2 }])).toBe(16);
  });

  it("supports sub and div", () => {
    expect(applyModifiers(10, [{ op: "sub", value: 4 }])).toBe(6);
    expect(applyModifiers(10, [{ op: "div", value: 4 }])).toBe(2.5);
  });
});

describe("applyColorModifiers", () => {
  it("returns the raw color when there is no chain", () => {
    expect(applyColorModifiers(0x336699, undefined)).toBe(0x336699);
    expect(applyColorModifiers(0x336699, [])).toBe(0x336699);
  });

  it("adds to an RGB channel, leaving the other channels unchanged", () => {
    const modifiers: ColorModifier[] = [{ model: "rgb", channel: "r", op: "add", value: 10 }];
    const result = applyColorModifiers(0x336699, modifiers);
    const rgb = colorToRgb(result);
    expect(rgb.r).toBe(0x33 + 10);
    expect(rgb.g).toBe(0x66);
    expect(rgb.b).toBe(0x99);
  });

  it("clamps an RGB channel to 0-255", () => {
    const modifiers: ColorModifier[] = [{ model: "rgb", channel: "g", op: "add", value: 1000 }];
    expect(colorToRgb(applyColorModifiers(0x336699, modifiers)).g).toBe(255);
    const negative: ColorModifier[] = [{ model: "rgb", channel: "g", op: "sub", value: 1000 }];
    expect(colorToRgb(applyColorModifiers(0x336699, negative)).g).toBe(0);
  });

  it("wraps hue mod 360 for both hsl-h and oklch-h", () => {
    const hsl: ColorModifier[] = [{ model: "hsl", channel: "hsl-h", op: "add", value: 400 }];
    expect(colorToHsl(applyColorModifiers(0x336699, hsl)).h).toBeCloseTo(colorToHsl(0x336699).h + 40, 0);

    const oklch: ColorModifier[] = [{ model: "oklch", channel: "oklch-h", op: "sub", value: 400 }];
    const baseH = colorToOklch(0x336699).h;
    const expected = ((baseH - 400) % 360 + 360) % 360;
    // 8-bit RGB repacking after the OKLCH->RGB conversion loses more precision than hsl-h's direct
    // repack, so this needs a coarser tolerance than the HSL case above.
    expect(colorToOklch(applyColorModifiers(0x336699, oklch)).h).toBeCloseTo(expected, -1);
  });

  it("clamps HSL saturation/lightness to 0-100", () => {
    const modifiers: ColorModifier[] = [{ model: "hsl", channel: "l", op: "add", value: 1000 }];
    expect(colorToHsl(applyColorModifiers(0x336699, modifiers)).l).toBe(100);
  });

  it("clamps OKLCH chroma to 0+", () => {
    const modifiers: ColorModifier[] = [{ model: "oklch", channel: "c", op: "sub", value: 1000 }];
    expect(colorToOklch(applyColorModifiers(0x336699, modifiers)).c).toBeCloseTo(0, 5);
  });

  it("applies chained steps across different models through the packed color", () => {
    const modifiers: ColorModifier[] = [
      { model: "oklch", channel: "oklch-l", op: "add", value: 10 },
      { model: "rgb", channel: "r", op: "add", value: 5 },
    ];
    const viaChain = applyColorModifiers(0x336699, modifiers);
    const afterFirst = applyColorModifiers(0x336699, [modifiers[0]]);
    const expected = applyColorModifiers(afterFirst, [modifiers[1]]);
    expect(viaChain).toBe(expected);
  });

  it("multiplies and divides a channel", () => {
    const mul: ColorModifier[] = [{ model: "rgb", channel: "b", op: "mul", value: 2 }];
    expect(colorToRgb(applyColorModifiers(0x330033, mul)).b).toBe(0x66);
    const div: ColorModifier[] = [{ model: "rgb", channel: "b", op: "div", value: 2 }];
    expect(colorToRgb(applyColorModifiers(0x330066, div)).b).toBe(0x33);
  });
});

describe("registry color descriptors", () => {
  it("formats a color field's value as #rrggbb", () => {
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY.floorColor.type).toBe("color");
    expect(VECTOR_BY_WALLS_PARAM_REGISTRY.floorColor.format(0x336699)).toBe("#336699");
  });
});

describe("engine color-chain propagation", () => {
  type Path = "source" | "target";
  const settings = { source: 0x336699, target: 0x000000 };

  it("propagates a color link's chain from source into target", () => {
    const colorModifiers: ColorModifier[] = [{ model: "rgb", channel: "r", op: "add", value: 10 }];
    const { settings: next } = addLink<Path, typeof settings>(settings, [], "source", "target", undefined, colorModifiers);
    expect(next.target).toBe(applyColorModifiers(0x336699, colorModifiers));
  });

  it("re-propagates an already-linked color chain when the source changes", () => {
    const colorModifiers: ColorModifier[] = [{ model: "oklch", channel: "oklch-l", op: "mul", value: 0.5 }];
    const { settings: linked, links } = addLink<Path, typeof settings>(settings, [], "source", "target", undefined, colorModifiers);
    const changed = { ...linked, source: 0x112233 };
    const next = propagate(changed, links, ["source"]);
    expect(next.target).toBe(applyColorModifiers(0x112233, colorModifiers));
  });
});

describe("link-aware write helpers (GitHub issue #704)", () => {
  type Path = "a" | "b" | "c" | "nested.x" | "nested.y";
  type S = { a: number; b: number; c: number; nested: { x: number; y: number }; links: ParamLink<Path>[] };
  const link = (source: Path, target: Path, enabled = true): ParamLink<Path> => ({ id: `${source}>${target}`, source, target, enabled });
  const base = (links: ParamLink<Path>[]): S => ({ a: 1, b: 1, c: 1, nested: { x: 1, y: 1 }, links });

  it("writeLinkedParam writes the value, detaches the field's own incoming link and refreshes dependents", () => {
    const next = writeLinkedParam<Path, S>(base([link("a", "b"), link("b", "c")]), "b", 7);
    expect(next.b).toBe(7);
    expect(next.c).toBe(7);
    expect(next.links.find((l) => l.target === "b")?.enabled).toBe(false);
    expect(next.links.find((l) => l.target === "c")?.enabled).toBe(true);
  });

  it("writeLinkedParam on a field with no incoming link just writes and propagates", () => {
    const next = writeLinkedParam<Path, S>(base([link("a", "b")]), "a", 5);
    expect(next.b).toBe(5);
    expect(next.links[0].enabled).toBe(true);
  });

  it("applyLinkedPatch detaches only the overridable paths present in the root patch (nested path included)", () => {
    const settings = base([link("a", "nested.x"), link("a", "nested.y")]);
    const next = applyLinkedPatch<Path, S>(settings, { ...settings, nested: { ...settings.nested, x: 9 } }, { nested: { x: 9 } }, ["nested.x", "nested.y"]);
    expect(next.nested).toEqual({ x: 9, y: 1 });
    expect(next.links.find((l) => l.target === "nested.x")?.enabled).toBe(false);
    expect(next.links.find((l) => l.target === "nested.y")?.enabled).toBe(true);
  });

  it("propagateLinkedSources refreshes dependents without detaching the edited field's own link", () => {
    const settings = base([link("a", "b"), link("b", "c")]);
    const next = propagateLinkedSources<Path, S>({ ...settings, b: 4 }, ["b"]);
    expect(next.c).toBe(4);
    expect(next.links.every((l) => l.enabled)).toBe(true);
  });
});
