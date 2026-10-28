import { nodeEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";

export const pe = (from: number, to: number, kind: PostEditEdge["kind"], _legacyId?: string): PostEditEdge =>
  ({ from: nodeEndpoint(from), to: nodeEndpoint(to), kind });
export const noSplits = () => undefined;
export const n = (id: number, x: number, y: number): NodeDto => ({ id, x, y, i: 0 });
export const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });
export const squareCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 4, rows: 4 });
export const cairoCfg: FieldConfig = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });
export const teleport = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });

/** Both directions of an undirected corridor between `a` and `b`. */
export const twoWay = (a: number, b: number): EdgeDto[] => [e(a, b), e(b, a)];

export const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 4 });
export const hexNeighborNodes = (x: number, y: number) => [
  n(1, x + 1, y), n(2, x, y + 1), n(3, x - 1, y + 1),
  n(4, x - 1, y), n(5, x, y - 1), n(6, x + 1, y - 1),
];
