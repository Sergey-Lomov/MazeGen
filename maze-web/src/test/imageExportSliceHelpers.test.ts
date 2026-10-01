import { describe, it, expect } from "vitest";
import { getParamValue, setParamValue, validateLinkGraph, propagate, forceLinks, reconcileLinks, setLinkEnabledByTarget, addLink, removeLink } from "../store/slices/parameterLinksEngine";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { VECTOR_BY_WALLS_PARAM_REGISTRY, VECTOR_BY_CORRIDORS_PARAM_REGISTRY } from "../store/parameterLinksRegistry";
import type { ParamDescriptor, ParamLink } from "../store/parameterLinks";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportSlice";
import { validateVectorByWallsSettings, validateVectorByCorridorsSettings } from "../store/projectExport/validateImageExport";

const registry: Record<string, ParamDescriptor> = {
  a: { type: "number", equals: Object.is, label: "a", group: [], format: String },
  b: { type: "number", equals: Object.is, label: "b", group: [], format: String },
  c: { type: "number", equals: Object.is, label: "c", group: [], format: String },
  color: { type: "color", equals: Object.is, label: "color", group: [], format: String },
};

function link(source: string, target: string, enabled = true): ParamLink<string> {
  return { id: `${source}->${target}`, source, target, enabled };
}

describe("getParamValue / setParamValue", () => {
  it("reads/writes a top-level field", () => {
    const settings = { a: 1 };
    expect(getParamValue(settings, "a")).toBe(1);
    expect(setParamValue(settings, "a", 2)).toEqual({ a: 2 });
  });

  it("reads/writes a dot-path nested field without mutating the original", () => {
    const settings = { marker: { size: 1, other: "x" } };
    expect(getParamValue(settings, "marker.size")).toBe(1);
    const next = setParamValue(settings, "marker.size", 5);
    expect(next).toEqual({ marker: { size: 5, other: "x" } });
    expect(settings.marker.size).toBe(1);
  });

  it("reads/writes a field nested three levels deep without mutating the original", () => {
    const settings = { index: { coverage: { elevator: true, other: false } } };
    expect(getParamValue(settings, "index.coverage.elevator")).toBe(true);
    const next = setParamValue(settings, "index.coverage.elevator", false);
    expect(next).toEqual({ index: { coverage: { elevator: false, other: false } } });
    expect(settings.index.coverage.elevator).toBe(true);
  });
});

describe("propagate", () => {
  it("propagates a changed source to every enabled dependent field", () => {
    const links = [link("a", "b"), link("a", "c")];
    const next = propagate({ a: 5, b: 0, c: 0 }, links, ["a"]);
    expect(next).toEqual({ a: 5, b: 5, c: 5 });
  });

  it("a disabled link resists propagation", () => {
    const links = [link("a", "b", false)];
    const next = propagate({ a: 5, b: 0 }, links, ["a"]);
    expect(next.b).toBe(0);
  });

  it("propagates transitively through a chain A->B->C", () => {
    const links = [link("a", "b"), link("b", "c")];
    const next = propagate({ a: 7, b: 0, c: 0 }, links, ["a"]);
    expect(next.b).toBe(7);
    expect(next.c).toBe(7);
  });

  it("result is independent of the input links array order", () => {
    const links1 = [link("a", "b"), link("b", "c")];
    const links2 = [link("b", "c"), link("a", "b")];
    const settings = { a: 3, b: 0, c: 0 };
    expect(propagate(settings, links1, ["a"])).toEqual(propagate(settings, links2, ["a"]));
  });

  it("a diamond dependency (a->b, a->c, b->d, c->d) sets d exactly once, from whichever branch reaches it first", () => {
    const links = [link("a", "b"), link("a", "c"), link("b", "d"), link("c", "d")];
    const next = propagate({ a: 1, b: 0, c: 0, d: 0 }, links, ["a"]);
    expect(next).toEqual({ a: 1, b: 1, c: 1, d: 1 });
  });
});

describe("forceLinks", () => {
  it("enables every link and propagates every source's value through", () => {
    const links = [link("a", "b", false), link("b", "c", false)];
    const { settings, links: nextLinks } = forceLinks({ a: 9, b: 0, c: 0 }, links);
    expect(settings).toEqual({ a: 9, b: 9, c: 9 });
    expect(nextLinks.every((l) => l.enabled)).toBe(true);
  });
});

describe("reconcileLinks", () => {
  it("marks a link disabled when target disagrees with source, independent of list order", () => {
    const settings = { a: 1, b: 2 };
    const links1 = [link("a", "b")];
    const links2 = [link("a", "b")];
    expect(reconcileLinks(settings, links1, registry)[0].enabled).toBe(false);
    expect(reconcileLinks(settings, links2, registry)[0].enabled).toBe(false);
  });

  it("keeps a link enabled when target already matches source", () => {
    const settings = { a: 1, b: 1 };
    const [result] = reconcileLinks(settings, [link("a", "b")], registry);
    expect(result.enabled).toBe(true);
  });
});

describe("setLinkEnabledByTarget", () => {
  it("disabling does not re-propagate — the caller already wrote the field", () => {
    const links = [link("a", "b")];
    const { settings, links: nextLinks } = setLinkEnabledByTarget({ a: 1, b: 99 }, links, "b", false);
    expect(settings.b).toBe(99);
    expect(nextLinks[0].enabled).toBe(false);
  });

  it("re-enabling re-propagates from the link's source", () => {
    const links = [link("a", "b", false)];
    const { settings, links: nextLinks } = setLinkEnabledByTarget({ a: 5, b: 99 }, links, "b", true);
    expect(settings.b).toBe(5);
    expect(nextLinks[0].enabled).toBe(true);
  });

  it("no-ops when no link targets the given path", () => {
    const links = [link("a", "b")];
    const result = setLinkEnabledByTarget({ a: 1, b: 1 }, links, "c", false);
    expect(result.links).toBe(links);
  });
});

describe("addLink", () => {
  it("creates a new link and propagates the source's current value into the target", () => {
    const { settings, links } = addLink({ a: 7, b: 0 }, [], "a", "b");
    expect(settings.b).toBe(7);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ source: "a", target: "b", enabled: true });
  });

  it("replaces any existing link already targeting the same target", () => {
    const links = [link("a", "c"), link("b", "c")];
    const { links: nextLinks } = addLink({ a: 1, b: 2, c: 2 }, links, "a", "c");
    const targetingC = nextLinks.filter((l) => l.target === "c");
    expect(targetingC).toHaveLength(1);
    expect(targetingC[0].source).toBe("a");
  });
});

describe("removeLink", () => {
  it("removes whichever link targets the given path, leaving the value untouched", () => {
    const links = [link("a", "b"), link("a", "c")];
    const { settings, links: nextLinks } = removeLink({ a: 1, b: 1, c: 1 }, links, "b");
    expect(settings).toEqual({ a: 1, b: 1, c: 1 });
    expect(nextLinks).toEqual([link("a", "c")]);
  });

  it("no-ops when no link targets the given path", () => {
    const links = [link("a", "b")];
    const result = removeLink({ a: 1, b: 1 }, links, "c");
    expect(result.links).toBe(links);
  });
});

describe("validateLinkGraph", () => {
  it("accepts a valid acyclic graph with unique targets", () => {
    expect(() => validateLinkGraph([link("a", "b"), link("b", "c")], registry)).not.toThrow();
  });

  it("rejects a cycle", () => {
    expect(() => validateLinkGraph([link("a", "b"), link("b", "a")], registry)).toThrow();
  });

  it("rejects duplicate targets regardless of array order", () => {
    const l1 = link("a", "c");
    const l2 = link("b", "c");
    expect(() => validateLinkGraph([l1, l2], registry)).toThrow();
    expect(() => validateLinkGraph([l2, l1], registry)).toThrow();
  });

  it("rejects a type mismatch between source and target", () => {
    expect(() => validateLinkGraph([link("a", "color")], registry)).toThrow();
  });

  it("rejects an unknown source path", () => {
    expect(() => validateLinkGraph([link("nope", "b")], registry)).toThrow(/unknown source/);
  });

  it("rejects an unknown target path", () => {
    expect(() => validateLinkGraph([link("a", "nope")], registry)).toThrow(/unknown target/);
  });

  it("DEFAULT_VECTOR_BY_WALLS_LINKS is internally valid", () => {
    expect(() => validateLinkGraph(DEFAULT_VECTOR_BY_WALLS_LINKS, VECTOR_BY_WALLS_PARAM_REGISTRY)).not.toThrow();
  });

  it("DEFAULT_VECTOR_BY_CORRIDORS_LINKS is internally valid", () => {
    expect(() => validateLinkGraph(DEFAULT_VECTOR_BY_CORRIDORS_LINKS, VECTOR_BY_CORRIDORS_PARAM_REGISTRY)).not.toThrow();
  });
});

describe("round-trip persistence of the four shared-style source values", () => {
  it("VectorByWallsSettings' cornerStyle/markerSize/markerBorderWidth/gapWidth survive a save/load cycle", () => {
    const saved = { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, cornerStyle: "miter" as const, markerSize: 0.42, markerBorderWidth: 4, gapWidth: 5 };
    const loaded = validateVectorByWallsSettings(saved, "vectorByWallsSettings");
    expect(loaded.cornerStyle).toBe("miter");
    expect(loaded.markerSize).toBe(0.42);
    expect(loaded.markerBorderWidth).toBe(4);
    expect(loaded.gapWidth).toBe(5);
  });

  it("VectorByCorridorsSettings' cornerStyle/markerSize/markerBorderWidth/gapWidth survive a save/load cycle", () => {
    const saved = { ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, cornerStyle: "miter" as const, markerSize: 0.42, markerBorderWidth: 4, gapWidth: 5 };
    const loaded = validateVectorByCorridorsSettings(saved, "vectorByCorridorsSettings");
    expect(loaded.cornerStyle).toBe("miter");
    expect(loaded.markerSize).toBe(0.42);
    expect(loaded.markerBorderWidth).toBe(4);
    expect(loaded.gapWidth).toBe(5);
  });

  it("links is never loaded from a project file — always seeded fresh from the defaults", () => {
    const tampered = { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, links: [] };
    const loaded = validateVectorByWallsSettings(tampered, "vectorByWallsSettings");
    expect(loaded.links).toBe(DEFAULT_VECTOR_BY_WALLS_LINKS);
  });
});

describe("param registry paths resolve against real settings", () => {
  // `validateLinkGraph` only checks graph structure (types, acyclicity, unique targets) — it never
  // reads `settings` itself, so a misspelled registry key (e.g. "markerIndex.coverge.elevator")
  // would pass that check silently and only fail once a user opened the dialog. This walks every
  // registered path through `getParamValue` against the real default settings instead.
  it("every VECTOR_BY_WALLS_PARAM_REGISTRY path resolves to a defined value on DEFAULT_VECTOR_BY_WALLS_SETTINGS", () => {
    for (const path of Object.keys(VECTOR_BY_WALLS_PARAM_REGISTRY)) {
      expect(getParamValue(DEFAULT_VECTOR_BY_WALLS_SETTINGS, path), `path "${path}"`).not.toBeUndefined();
    }
  });

  it("every VECTOR_BY_CORRIDORS_PARAM_REGISTRY path resolves to a defined value on DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS", () => {
    for (const path of Object.keys(VECTOR_BY_CORRIDORS_PARAM_REGISTRY)) {
      expect(getParamValue(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, path), `path "${path}"`).not.toBeUndefined();
    }
  });
});

describe("registry format functions", () => {
  it("formatMarkerShape renders every MarkerShape value distinctly from the raw enum string", () => {
    const format = VECTOR_BY_WALLS_PARAM_REGISTRY["startMarker.shape"].format;
    const shapes = ["circle", "triangle", "square", "diamond", "pentagon", "star", "hexagon", "cross"];
    const rendered = shapes.map((s) => format(s));
    expect(new Set(rendered).size).toBe(shapes.length);
    expect(rendered).not.toContain("circle");
  });

  it("formatVerticalArrowStyle renders every VerticalArrowStyle value distinctly", () => {
    const format = VECTOR_BY_WALLS_PARAM_REGISTRY.twoWayArrowStyle.format;
    const styles = ["triangle", "chevron", "arrow", "sign"];
    const rendered = styles.map((s) => format(s));
    expect(new Set(rendered).size).toBe(styles.length);
  });

  it("elevator badges and marker index use different i18n keys for IndexLabelStyle, even where the rendered wording happens to coincide in some locales", () => {
    // Wording can coincide by accident in one locale (e.g. ru's "roman"/"letters" strings currently
    // match) — what must hold is that each format function is backed by its own key set, so a future
    // wording change to one doesn't silently affect the other. "arabic" has distinct wording in both
    // locales today ("Numbers"/"Цифры" vs "Arabic numerals"/"Арабские цифры"), enough to prove the
    // two functions aren't aliases of the same key set.
    const badgeFormat = VECTOR_BY_WALLS_PARAM_REGISTRY["elevatorBadges.labelType"].format;
    const indexFormat = VECTOR_BY_WALLS_PARAM_REGISTRY["markerIndex.labelStyle"].format;
    expect(badgeFormat("arabic")).not.toBe(indexFormat("arabic"));
  });

  it("teleport floor badge reuses the elevator badges IndexLabelStyle wording, not marker index's", () => {
    const badgeFormat = VECTOR_BY_WALLS_PARAM_REGISTRY["elevatorBadges.labelType"].format;
    const teleportFormat = VECTOR_BY_WALLS_PARAM_REGISTRY["teleportFloorBadge.labelType"].format;
    expect(teleportFormat("arabic")).toBe(badgeFormat("arabic"));
  });

  it("elevator badges and marker index use separate format functions for LabelFontWeight, not one aliasing the other", () => {
    // Unlike IndexLabelStyle, LabelFontWeight's "regular"/"bold" wording happens to be identical
    // between the two key sets in every current locale, so the assertion can't be "renders
    // differently" here — instead it pins that the two descriptors reference distinct functions, so
    // a future wording change to one key set can't accidentally also change the other's text.
    const badgeFormat = VECTOR_BY_WALLS_PARAM_REGISTRY["elevatorBadges.fontWeight"].format;
    const indexFormat = VECTOR_BY_WALLS_PARAM_REGISTRY["markerIndex.fontWeight"].format;
    expect(badgeFormat).not.toBe(indexFormat);
  });

  it("formatBoolean renders true/false distinctly", () => {
    const format = VECTOR_BY_WALLS_PARAM_REGISTRY.showGrid.format;
    expect(format(true)).not.toBe(format(false));
  });

  it("formatCornerStyle renders round/miter distinctly, including for the vertical-arrow-corner-style fields", () => {
    const format = VECTOR_BY_WALLS_PARAM_REGISTRY.twoWayArrowCornerStyle.format;
    expect(format("round")).not.toBe(format("miter"));
  });
});
