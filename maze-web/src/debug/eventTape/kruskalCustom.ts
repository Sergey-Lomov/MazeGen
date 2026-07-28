// Hand-written custom-field decoders for KruskalEvent (registered in codegen/src/codecs.rs as
// EdgePairsCodec/PresetUnionsCodec) — mirrors `write_edge_pairs`/`write_preset_unions` in
// `maze-core/src/generation/kruskal.rs`. `EdgesShuffled`/`PresetUnionsApplied`'s field types
// (`Vec<(NodeId, NodeId)>`/`Vec<(NodeId, NodeId, EdgeKind)>`) aren't standard wire types, so the
// generated `decodeKruskalEvent` calls these by name instead of inlining their bytes.

import { readNodeId, readU32 } from "./wire";

export function readEdgePairs(bytes: Uint8Array, offset: number): { value: [bigint, bigint][]; next: number } {
  if (bytes.byteLength - offset < 4) {
    throw new Error(`KruskalEvent: EdgesShuffled payload too short (${bytes.byteLength - offset} bytes, need at least 4)`);
  }
  const count = readU32(bytes, offset);
  const pairs: [bigint, bigint][] = [];
  for (let i = 0; i < count; i++) {
    const base = offset + 4 + i * 16;
    pairs.push([readNodeId(bytes, base), readNodeId(bytes, base + 8)]);
  }
  return { value: pairs, next: offset + 4 + count * 16 };
}

export function readPresetUnions(bytes: Uint8Array, offset: number): { value: [bigint, bigint, "basic" | "teleport"][]; next: number } {
  if (bytes.byteLength - offset < 4) {
    throw new Error(`KruskalEvent: PresetUnionsApplied payload too short (${bytes.byteLength - offset} bytes, need at least 4)`);
  }
  const count = readU32(bytes, offset);
  const pairs: [bigint, bigint, "basic" | "teleport"][] = [];
  for (let i = 0; i < count; i++) {
    const base = offset + 4 + i * 17;
    const kind = bytes[base + 16] !== 0 ? "teleport" : "basic";
    pairs.push([readNodeId(bytes, base), readNodeId(bytes, base + 8), kind]);
  }
  return { value: pairs, next: offset + 4 + count * 17 };
}
