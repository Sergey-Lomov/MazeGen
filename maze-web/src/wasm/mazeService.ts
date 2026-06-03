import { getWasm } from "./wasmLoader";
import type { NodeDto, EdgeDto, MazeSnapshot } from "./types";

function isNodeDto(v: unknown): v is NodeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as NodeDto).id === "number" &&
    typeof (v as NodeDto).x === "number" &&
    typeof (v as NodeDto).y === "number";
}

function isEdgeDto(v: unknown): v is EdgeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as EdgeDto).from === "number" &&
    typeof (v as EdgeDto).to === "number";
}

function validateSnapshot(raw: unknown): MazeSnapshot {
  if (typeof raw !== "object" || raw === null) throw new Error("WASM returned invalid snapshot");
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.nodes) || !s.nodes.every(isNodeDto))
    throw new Error("WASM snapshot: invalid nodes");
  if (!Array.isArray(s.edges) || !s.edges.every(isEdgeDto))
    throw new Error("WASM snapshot: invalid edges");
  const nodeIds = new Set<number>((s.nodes as NodeDto[]).map(n => n.id));
  for (const e of s.edges as EdgeDto[]) {
    if (!nodeIds.has(e.from)) throw new Error(`WASM snapshot: edge.from ${e.from} not in nodes`);
    if (!nodeIds.has(e.to)) throw new Error(`WASM snapshot: edge.to ${e.to} not in nodes`);
  }
  return s as unknown as MazeSnapshot;
}

export function generateMaze(seed: number, width: number, height: number): MazeSnapshot {
  const raw = getWasm().generate(BigInt(seed), width, height);
  return validateSnapshot(raw);
}
