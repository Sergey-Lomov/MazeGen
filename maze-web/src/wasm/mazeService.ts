import { getWasm } from "./wasmLoader";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, MazeSnapshot, CheckDescriptor, StrategyDescriptor, GenerateConfig } from "./types";

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

function isNavNodeDto(v: unknown): v is NavNodeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as NavNodeDto).node_id === "number";
}

function isNavEdgeDto(v: unknown): v is NavEdgeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as NavEdgeDto).from === "number" &&
    typeof (v as NavEdgeDto).to === "number" &&
    Array.isArray((v as NavEdgeDto).path) &&
    (v as NavEdgeDto).path.every((n: unknown) => typeof n === "number");
}

function validateSnapshot(raw: unknown): MazeSnapshot {
  if (typeof raw !== "object" || raw === null) throw new Error("WASM returned invalid snapshot");
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.nodes) || !s.nodes.every(isNodeDto))
    throw new Error("WASM snapshot: invalid nodes");
  if (!Array.isArray(s.edges) || !s.edges.every(isEdgeDto))
    throw new Error("WASM snapshot: invalid edges");
  if (!Array.isArray(s.warnings) || !s.warnings.every(w => typeof w === "string"))
    throw new Error("WASM snapshot: invalid warnings");
  if (!Array.isArray(s.nav_nodes) || !s.nav_nodes.every(isNavNodeDto))
    throw new Error("WASM snapshot: invalid nav_nodes");
  if (!Array.isArray(s.nav_edges) || !s.nav_edges.every(isNavEdgeDto))
    throw new Error("WASM snapshot: invalid nav_edges");
  if (!Array.isArray(s.components) || !s.components.every(
    (c: unknown) => Array.isArray(c) && (c as unknown[]).every(n => typeof n === "number")
  )) throw new Error("WASM snapshot: invalid components");
  const nodeIds = new Set<number>((s.nodes as NodeDto[]).map(n => n.id));
  for (const e of s.edges as EdgeDto[]) {
    if (!nodeIds.has(e.from)) throw new Error(`WASM snapshot: edge.from ${e.from} not in nodes`);
    if (!nodeIds.has(e.to)) throw new Error(`WASM snapshot: edge.to ${e.to} not in nodes`);
  }
  return s as unknown as MazeSnapshot;
}

export function getAvailableChecks(): CheckDescriptor[] {
  return getWasm().available_checks() as CheckDescriptor[];
}

export function getAvailableStrategies(): StrategyDescriptor[] {
  return getWasm().available_strategies() as StrategyDescriptor[];
}

export function generateMaze(seed: number, width: number, height: number, config: GenerateConfig): MazeSnapshot {
  const raw = getWasm().generate(BigInt(seed), width, height, config);
  return validateSnapshot(raw);
}
