/** Post-edit entity id formatting (GitHub issue #564 second follow-up) — every stable post-edit
 *  entity id (one-way edge, split point, teleport, vertical passage, elevator) is a type-prefixed
 *  string (`"t3"`, `"s1"`, `"o5"`, `"v2"`, `"e7"`), not a bare number, so an id string alone
 *  already says what kind of entity it names — useful in logs, exported files, and the "Changes"
 *  panel's own `withId()` suffix. The underlying counter (`_nextPostEdit*Id`) stays a plain
 *  `number` — only the MINTED id is formatted to a string, at the point each category's counter is
 *  read (`nextPostEditIdCounters`, `assignSequentialIds` call sites, and every store action that
 *  mints a fresh id off a `_nextPostEdit*Id` field). Category namespaces stay fully independent, as
 *  they always have been — a one-way edge and a split point can both be "id 3" without colliding,
 *  since their formatted ids (`"o3"` vs `"s3"`) never compare equal. */

export type PostEditIdCategory = "teleport" | "oneWay" | "splitPoint" | "verticalPassage" | "elevator";

const PREFIX: Record<PostEditIdCategory, string> = {
  teleport: "t",
  oneWay: "o",
  splitPoint: "s",
  verticalPassage: "v",
  elevator: "e",
};

/** Formats a category's raw numeric counter value into its stable string id. */
export function formatPostEditId(category: PostEditIdCategory, n: number): string {
  return `${PREFIX[category]}${n}`;
}

/** Inverse of `formatPostEditId` — the numeric suffix of a category's formatted id, used only to
 *  seed the next `_nextPostEdit*Id` counter (`max(existing) + 1`) from a set of already-minted ids.
 *  Never used to compare/derive identity — ids are compared as opaque strings everywhere else. */
export function parsePostEditIdNumber(category: PostEditIdCategory, id: string): number {
  return Number(id.slice(PREFIX[category].length));
}
