import { describe, it, expect } from "vitest";
import { detectIdentity, namesIdentity } from "./splitBindingFixture";
import { type SplitFaceKind } from "../pixi/splitFaceLayout";

// GitHub issue #487 — a split point whose face configuration matches a recognized special-split
// topology gets semantic per-node names instead of "Node N". Named: degree-4 "bridge"/"diagonal",
// and every degree-6 (hex) kind. Node order per kind matches `buildSplitPassagesCore`'s own branch.
const N = (kinds: SplitFaceKind[]) => ({ faces: kinds.map((kind) => ({ kind })) });

describe("splitNodeSemanticNames", () => {
  it("names a degree-4 bridge: node 0 Corridor, node 1 Bridge", () => {
    const names = namesIdentity([
      N(["passage", "wall", "passage", "wall"]),
      N(["wall", "passage", "wall", "passage"]),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Corridor", "Bridge"]);
    expect(names?.map((n) => n.short)).toEqual(["Cor", "Brg"]);
  });

  it("names a degree-4 diagonal divider: 'Corridor 1' / 'Corridor 2'", () => {
    const names = namesIdentity([
      N(["passage", "passage", "wall", "wall"]),
      N(["wall", "wall", "passage", "passage"]),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Corridor 1", "Corridor 2"]);
    expect(names?.map((n) => n.short)).toEqual(["Cor1", "Cor2"]);
  });

  it("names the Cairo divider by face ownership", () => {
    const order = [0, 1, 2, 3, 4];
    const raw = (faces: number[]): SplitFaceKind[] => Array.from({ length: 5 }, (_, i) => faces.includes(i) ? "passage" : "wall");
    const rawKinds = [raw([order[1], order[4]]), raw([order[2], order[3]])];
    expect(detectIdentity(rawKinds)).toBe("cairo_diagonal_divider");
    const names = namesIdentity([
      N(raw([order[1], order[4]])),
      N(raw([order[2], order[3]])),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Corridor 2", "Corridor 1"]);
    expect(names?.map((n) => n.short)).toEqual(["Cor2", "Cor1"]);
  });

  it("names the Cairo adjacent divider by its canonical face ownership", () => {
    const names = namesIdentity([
      N(["wall", "passage", "passage", "wall", "wall"]),
      N(["wall", "wall", "wall", "passage", "passage"]),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Corridor 1", "Corridor 2"]);
    expect(names?.map((n) => n.short)).toEqual(["Cor1", "Cor2"]);
  });

  it("names the Cairo 2x3 bridge by its canonical face ownership", () => {
    const names = namesIdentity([
      N(["passage", "wall", "passage", "passage", "wall"]),
      N(["wall", "passage", "wall", "wall", "passage"]),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Fork", "Bridge"]);
    expect(names?.map((n) => n.short)).toEqual(["Frk", "Brg"]);
  });

  it("names a hex bridge: node 0 Corridor, node 1 Bridge", () => {
    const names = namesIdentity([
      N(["passage", "wall", "wall", "passage", "wall", "wall"]),
      N(["wall", "passage", "wall", "wall", "passage", "wall"]),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Corridor", "Bridge"]);
  });

  it("names a hex diagonal (two non-opposite pairs): 'Corridor 1' / 'Corridor 2'", () => {
    const names = namesIdentity([
      N(["passage", "wall", "passage", "wall", "wall", "wall"]),
      N(["wall", "wall", "wall", "wall", "passage", "passage"]),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Corridor 1", "Corridor 2"]);
  });

  it("names a hex diagonal divider (two three-face halves): 'Fork 1' / 'Fork 2'", () => {
    const names = namesIdentity([
      N(["passage", "passage", "passage", "wall", "wall", "wall"]),
      N(["wall", "wall", "wall", "passage", "passage", "passage"]),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Fork 1", "Fork 2"]);
  });

  it("names a hex triple bridge: Corridor / Lower bridge / Upper bridge by row order", () => {
    const names = namesIdentity([
      N(["passage", "wall", "wall", "passage", "wall", "wall"]),
      N(["wall", "passage", "wall", "wall", "passage", "wall"]),
      N(["wall", "wall", "passage", "wall", "wall", "passage"]),
    ]);
    expect(names?.map((n) => n.full)).toEqual(["Corridor", "Lower bridge", "Upper bridge"]);
  });

  it("names a hex triple corridor: through pair Middle, adjacent pairs Side 1/2 by lowest face", () => {
    // Node 0: adjacent {4,5}; node 1: opposite {0,3} (the through corridor); node 2: adjacent {1,2}.
    const names = namesIdentity([
      N(["wall", "wall", "wall", "wall", "passage", "passage"]),
      N(["passage", "wall", "wall", "passage", "wall", "wall"]),
      N(["wall", "passage", "passage", "wall", "wall", "wall"]),
    ]);
    // Side corridors ordered by lowest owned face index: node 2 ({1,2}) -> Side 1, node 0 ({4,5}) -> Side 2.
    expect(names?.map((n) => n.full)).toEqual(["Side corridor 2", "Middle corridor", "Side corridor 1"]);
  });

  it("returns null for an unrecognized topology", () => {
    const names = namesIdentity([
      N(["passage", "passage", "passage", "wall"]),
      N(["wall", "wall", "wall", "passage"]),
    ]);
    expect(names).toBeNull();
  });

  it("returns null for a one-way bridge (directionality must stay visible)", () => {
    const names = namesIdentity([
      N(["one_way_out", "wall", "passage", "wall"]),
      N(["wall", "passage", "wall", "passage"]),
    ]);
    expect(names).toBeNull();
  });

  it("returns null for a one-way hex connection", () => {
    const names = namesIdentity([
      N(["one_way_in", "wall", "wall", "passage", "wall", "wall"]),
      N(["wall", "passage", "wall", "wall", "passage", "wall"]),
    ]);
    expect(names).toBeNull();
  });

  it("returns null for an unsupported tile degree (degree 3)", () => {
    const names = namesIdentity([
      N(["passage", "passage", "wall"]),
      N(["wall", "wall", "passage"]),
    ]);
    expect(names).toBeNull();
  });
});
