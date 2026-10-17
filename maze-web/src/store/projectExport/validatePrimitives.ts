import type { SplitPattern } from "../../wasm/types";

// ─── Primitive asserts ───────────────────────────────────────────────────────

export function assertString(v: unknown, path: string): string {
  if (typeof v !== "string") throw new Error(`Expected string at ${path}, got ${typeof v}`);
  return v;
}

export function assertNumber(v: unknown, path: string): number {
  if (typeof v !== "number") throw new Error(`Expected number at ${path}, got ${typeof v}`);
  return v;
}

export function assertBoolean(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new Error(`Expected boolean at ${path}, got ${typeof v}`);
  return v;
}

export function assertArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`Expected array at ${path}`);
  return v;
}

export function assertObject(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(`Expected object at ${path}`);
  return v as Record<string, unknown>;
}

export function assertStringRecord(v: unknown, path: string): Record<string, string> {
  const obj = assertObject(v, path);
  for (const [k, val] of Object.entries(obj)) {
    assertString(val, `${path}.${k}`);
  }
  return obj as Record<string, string>;
}

export function assertBoolRecord(v: unknown, path: string): Record<string, boolean> {
  const obj = assertObject(v, path);
  for (const [k, val] of Object.entries(obj)) {
    assertBoolean(val, `${path}.${k}`);
  }
  return obj as Record<string, boolean>;
}

export function assertStringRecordRecord(v: unknown, path: string): Record<string, Record<string, string>> {
  const obj = assertObject(v, path);
  for (const [k, val] of Object.entries(obj)) {
    assertStringRecord(val, `${path}.${k}`);
  }
  return obj as Record<string, Record<string, string>>;
}

export function assertHexOrientation(v: unknown, path: string): void {
  const s = assertString(v, path);
  if (s !== "flat_top" && s !== "pointy_top")
    throw new Error(`Invalid hex orientation at ${path}: ${s}`);
}

export function assertTriOrientation(v: unknown, path: string): void {
  const s = assertString(v, path);
  if (s !== "r0" && s !== "r90" && s !== "r180" && s !== "r270")
    throw new Error(`Invalid triangle orientation at ${path}: ${s}`);
}

// ─── Optional-field helpers (sections with defaults for old files) ──────────

export function optBool(obj: Record<string, unknown> | null, key: string, fallback: boolean): boolean {
  return obj != null && typeof obj[key] === "boolean" ? (obj[key] as boolean) : fallback;
}

export function optNumber(obj: Record<string, unknown> | null, key: string, fallback: number): number {
  return obj != null && typeof obj[key] === "number" ? (obj[key] as number) : fallback;
}

export function optEnum<T extends string>(obj: Record<string, unknown> | null, key: string, allowed: readonly T[], fallback: T): T {
  const v = obj?.[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function optSection(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> | null {
  return parent[key] != null ? assertObject(parent[key], path) : null;
}

/** Validates `floors` (GitHub issue #335) — absent in project files saved before this feature
 * existed, so it defaults to a single floor, same default as a fresh store. A malformed floor
 * entry is dropped individually rather than failing the whole load, same leniency
 * `validateSplitGeneration`'s pattern list applies; an empty result after dropping falls back to
 * the single-floor default too (floors must never end up empty). */
export function validateFloors(v: unknown, path: string): { floors: { id: string; title: string; titleCustomized?: boolean }[]; nextFloorNumber: number; activeFloorId: string } {
  const fallbackFloor = { id: `floor_${crypto.randomUUID()}`, title: "Floor 1" };
  const fallback = { floors: [fallbackFloor], nextFloorNumber: 2, activeFloorId: fallbackFloor.id };
  if (v == null) return fallback;
  let obj: Record<string, unknown>;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  const rawFloors = Array.isArray(obj.floors) ? obj.floors : [];
  const floors: { id: string; title: string; titleCustomized?: boolean }[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawFloors) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.title !== "string") continue;
    // A duplicate id would collide as a React list key (FloorsFeature keys rows by `floor.id`) —
    // drop the later duplicate rather than throw, same "recoverable, not fatal" leniency this
    // function already applies to a malformed entry (unlike `assertUniqueIds`'s throw-on-dup
    // convention used for other id-bearing arrays, where a duplicate signals real corruption —
    // here it's just as likely a hand-edited file, and the file otherwise loads fine either way).
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    floors.push(entry.titleCustomized === true
      ? { id: entry.id, title: entry.title, titleCustomized: true }
      : { id: entry.id, title: entry.title });
  }
  if (floors.length === 0) return fallback;
  const nextFloorNumber = Math.max(1, Math.trunc(optNumber(obj, "nextFloorNumber", floors.length + 1)));
  // Active floor selection (GitHub issue #354) — absent in files saved before this issue, or
  // naming a floor that got dropped above, falls back to the bottom floor, same convention
  // `activeFloorId` itself uses everywhere else (e.g. removeFloor's fallback in floorsSlice.ts).
  const rawActiveFloorId = obj.activeFloorId;
  const activeFloorId = typeof rawActiveFloorId === "string" && floors.some((f) => f.id === rawActiveFloorId)
    ? rawActiveFloorId
    : floors[0].id;
  return { floors, nextFloorNumber, activeFloorId };
}

/** Validates `generation.splitGeneration` (GitHub issue #222) — absent in project files saved
 * before this feature existed, so it defaults cleanly to "feature off" rather than throwing.
 * Malformed patterns are dropped individually (never fail the whole load) — a hand-edited or
 * corrupted pattern only degrades that one pattern's availability, not the entire file; the same
 * leniency `validatePairArray`'s callers apply to individually-recoverable entries elsewhere. */
export function validateSplitGeneration(v: unknown, path: string): { patternMode: boolean; maxSplitNodes: number; patterns: SplitPattern[] } {
  if (v == null) return { patternMode: false, maxSplitNodes: 2, patterns: [] };
  let obj: Record<string, unknown>;
  try {
    obj = assertObject(v, path);
  } catch {
    return { patternMode: false, maxSplitNodes: 2, patterns: [] };
  }
  const patternMode = optBool(obj, "patternMode", false);
  const maxSplitNodes = Math.max(1, Math.trunc(optNumber(obj, "maxSplitNodes", 2)));
  const rawPatterns = Array.isArray(obj.patterns) ? obj.patterns : [];
  const patterns: SplitPattern[] = [];
  for (const raw of rawPatterns) {
    const pattern = tryValidateSplitPattern(raw);
    if (pattern) patterns.push(pattern);
  }
  return { patternMode, maxSplitNodes, patterns };
}

export function tryValidateSplitPattern(v: unknown): SplitPattern | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.shape !== "string" || typeof obj.node_count !== "number" || !Array.isArray(obj.faces)) return null;
  const faces: SplitPattern["faces"] = [];
  for (const nodeFaces of obj.faces) {
    if (!Array.isArray(nodeFaces)) return null;
    const validatedNodeFaces: SplitPattern["faces"][number] = [];
    for (const face of nodeFaces) {
      const validatedFace = tryValidateSplitPatternFace(face);
      if (!validatedFace) return null;
      validatedNodeFaces.push(validatedFace);
    }
    faces.push(validatedNodeFaces);
  }
  const weight = typeof obj.weight === "number" ? obj.weight : 1.0;
  return { shape: obj.shape, node_count: obj.node_count, faces, weight };
}

export function tryValidateSplitPatternFace(v: unknown): SplitPattern["faces"][number][number] | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.face_index !== "number") return null;
  const requirement = tryValidateSplitFaceRequirement(obj.requirement);
  if (!requirement) return null;
  const sibling_target = typeof obj.sibling_target === "number" ? obj.sibling_target : undefined;
  return { face_index: obj.face_index, requirement, sibling_target };
}

export function tryValidateSplitFaceRequirement(v: unknown): SplitPattern["faces"][number][number]["requirement"] | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  switch (obj.kind) {
    case "passage": return { kind: "passage" };
    case "wall": return { kind: "wall" };
    case "unspecified": return { kind: "unspecified" };
    case "one_way":
      return obj.direction === "forward" || obj.direction === "backward"
        ? { kind: "one_way", direction: obj.direction }
        : null;
    default: return null;
  }
}

export function validatePairArray<T>(
  v: unknown,
  path: string,
  validateValue: (value: unknown, path: string) => T,
): [string, T][] {
  const arr = assertArray(v, path);
  return arr.map((entry, i) => {
    const pair = assertArray(entry, `${path}[${i}]`);
    return [
      assertString(pair[0], `${path}[${i}][0]`),
      validateValue(pair[1], `${path}[${i}][1]`),
    ] as [string, T];
  });
}

/** Throws if any entry in `items` shares an `id` with an earlier entry — shared by every
 * validated array whose entries carry a client-minted id (`postEdit.teleports`,
 * `quality.rules[].checks`, `presets.teleports`), where a duplicate signals file corruption
 * rather than something recoverable with a default. `label` names the id field in the error
 * message (e.g. "teleport id", "localId"). */
export function assertUniqueIds<T, K extends number | string>(items: T[], getId: (item: T) => K, label: string, path: string): void {
  const seen = new Set<K>();
  for (const item of items) {
    const id = getId(item);
    if (seen.has(id)) throw new Error(`Duplicate ${label} ${id} at ${path}`);
    seen.add(id);
  }
}

export function validateTeleportDirection(v: unknown, path: string): "forward" | "backward" | "two_way" {
  const direction = assertString(v, path);
  if (direction !== "forward" && direction !== "backward" && direction !== "two_way")
    throw new Error(`Invalid teleport direction at ${path}: ${direction}`);
  return direction;
}

export function validateVerticalPassageDirection(v: unknown, path: string): "forward" | "backward" | "two_way" {
  return validateTeleportDirection(v, path);
}

