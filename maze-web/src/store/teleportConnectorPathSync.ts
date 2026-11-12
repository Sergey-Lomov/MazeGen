import type { StoreApi } from "zustand";
import type { MazeStore } from "./storeTypes";
import { teleportPairConnectorKeys } from "../pixi/renderers/teleportConnectorManual";

/** Removes paths whose teleport pair is absent from a generated maze. An empty edge list means
 * there is no generated maze to compare against yet, so paths must remain available for project
 * loading and for the first generation. A cross-floor pair (endpoints on different floors) lives
 * under one key per floor (GitHub issue #989); a path under its plain pair key is dropped. */
export function retainLiveTeleportConnectorPaths(
  paths: NonNullable<MazeStore["vectorByWallsSettings"]["manualTeleportConnectorPaths"]>,
  edges: MazeStore["edges"],
  nodes: MazeStore["nodes"],
): NonNullable<MazeStore["vectorByWallsSettings"]["manualTeleportConnectorPaths"]> {
  if (edges.length === 0) return paths;
  const levelById = new Map(nodes.map((node) => [node.id, node.level ?? 0]));
  const live = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "teleport") continue;
    for (const key of teleportPairConnectorKeys(edge.from, edge.to, levelById.get(edge.from) !== levelById.get(edge.to))) live.add(key);
  }
  return Object.fromEntries(Object.entries(paths).filter(([key]) => live.has(key)));
}

/** A manual connector path is keyed by its teleport pair. Whatever removes a teleport (post-edit,
 * preset, regeneration) ends in a new `edges`, so a path whose pair is no longer there is dropped
 * here, in one place (GitHub issue #950). An empty `edges` means "no maze yet" and drops nothing. */
export function installTeleportConnectorPathSync(store: StoreApi<MazeStore>): void {
  store.subscribe((state, prev) => {
    if ((state.edges === prev.edges && state.nodes === prev.nodes) || state.edges.length === 0) return;
    const paths = state.vectorByWallsSettings.manualTeleportConnectorPaths;
    const keys = paths ? Object.keys(paths) : [];
    if (keys.length === 0) return;
    const kept = retainLiveTeleportConnectorPaths(paths!, state.edges, state.nodes);
    if (Object.keys(kept).length === keys.length) return;
    state.setManualTeleportConnectorPaths(kept);
  });
}
