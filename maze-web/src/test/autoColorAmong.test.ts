import { describe, expect, it } from "vitest";
import { AUTO_COLOR_COUNT, autoColorAmong, glueColor } from "../domain/glueColor";
import { colorToOklch } from "../domain/colorMath";
import { zoneColors } from "../domain/selectors/zoneSelectors";
import type { Zone } from "../wasm/mazeService";

const zone = (id: number, kind: Zone["kind"]): Zone => ({ id, name: "", kind, cells: [] });
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("autoColorAmong", () => {
  it("is the plain glue palette up to three rounds", () => {
    const total = AUTO_COLOR_COUNT * 3;
    expect(range(total).map((i) => autoColorAmong(i, total))).toEqual(range(total).map((i) => glueColor(i)));
  });

  it("keeps 54 colours apart and away from black and white", () => {
    const colors = range(54).map((i) => autoColorAmong(i, 54));
    expect(new Set(colors).size).toBe(54);
    for (const color of colors) {
      const { l } = colorToOklch(color);
      expect(l).toBeGreaterThan(15);
      expect(l).toBeLessThan(90);
    }
  });

  it("does not depend on how many zones come after the item within its round bound", () => {
    expect(autoColorAmong(3, 49)).toBe(autoColorAmong(3, 54));
  });
});

describe("zoneColors", () => {
  it("indexes the automatic and the manual zones independently", () => {
    const mixed = [zone(1, "auto"), zone(2, "manual"), zone(3, "auto"), zone(4, "manual")];
    const alone = (kind: Zone["kind"], ids: number[]) => zoneColors(ids.map((id) => zone(id, kind)));
    expect(zoneColors(mixed)).toEqual([alone("auto", [1, 3])[0], alone("manual", [2, 4])[0], alone("auto", [1, 3])[1], alone("manual", [2, 4])[1]]);
  });

  it("fits the automatic palette to their number, the manual one stays plain", () => {
    const many = [...range(54).map((i) => zone(i + 1, "auto")), zone(100, "manual"), zone(101, "manual")];
    const colors = zoneColors(many);
    expect(colors[54]).toBe(glueColor(0));
    expect(colors[55]).toBe(glueColor(1));
    expect(colors[0]).toBe(autoColorAmong(0, 54));
  });
});
