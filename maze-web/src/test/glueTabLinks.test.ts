import { describe, expect, it } from "vitest";
import { VECTOR_BY_CORRIDORS_PARAM_REGISTRY, VECTOR_BY_WALLS_PARAM_REGISTRY } from "../store/parameterLinksRegistry";
import { isPathActive, type ParamActivityContext } from "../store/parameterLinksActivity";
import { DEFAULT_VECTOR_BY_CORRIDORS_LINKS, DEFAULT_VECTOR_BY_WALLS_LINKS } from "../store/slices/parameterLinksDefaults";
import { DEFAULT_GLUE_TAB_STYLE } from "../store/slices/imageExportDefaults";

const PATHS = ["showTabs", "inset", "width", "alternate", "fillColor", "lineWidth", "lineStyle", "lineColor"] as const;

describe("glue-tab parameter links (GitHub issue #901)", () => {
  it("registers every glue-tab parameter in both registries", () => {
    for (const registry of [VECTOR_BY_WALLS_PARAM_REGISTRY, VECTOR_BY_CORRIDORS_PARAM_REGISTRY]) {
      for (const key of PATHS) {
        const descriptor = (registry as Record<string, { label: string; group: string[] }>)[`glueTabs.${key}`];
        expect(descriptor, key).toBeDefined();
        expect(descriptor.label.length).toBeGreaterThan(0);
        expect(descriptor.group.length).toBe(2);
      }
    }
  });

  it("links the fill to the background and the outline to the grid by default", () => {
    for (const links of [DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS]) {
      expect(links).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "background", target: "glueTabs.fillColor", enabled: true }),
        expect.objectContaining({ source: "gridColor", target: "glueTabs.lineColor", enabled: true }),
      ]));
    }
  });

  it("is active only while the tabs show, and the outline rows only with an outline", () => {
    const ctx = {} as ParamActivityContext;
    const active = (path: string, glueTabs: { showTabs: boolean; lineWidth: number }) =>
      isPathActive(path as never, VECTOR_BY_WALLS_PARAM_REGISTRY as never, ctx, { glueTabs });
    expect(active("glueTabs.showTabs", { showTabs: false, lineWidth: 2 })).toBe(true);
    expect(active("glueTabs.width", { showTabs: false, lineWidth: 2 })).toBe(false);
    expect(active("glueTabs.width", { showTabs: true, lineWidth: 0 })).toBe(true);
    expect(active("glueTabs.lineColor", { showTabs: true, lineWidth: 0 })).toBe(false);
    expect(active("glueTabs.lineStyle", { showTabs: true, lineWidth: 2 })).toBe(true);
  });

  it("defaults to a solid 1-unit outline, no inset, a 35-unit width and alternation", () => {
    expect(DEFAULT_GLUE_TAB_STYLE).toMatchObject({ lineStyle: "solid", lineWidth: 1, inset: 0, width: 35, alternate: true });
  });
});
