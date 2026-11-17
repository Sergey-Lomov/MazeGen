// Pure drop resolution for the QC panel's drag-and-drop (GitHub issue #39). Kept free of
// dnd-kit and React so the placement rules can be unit-tested directly.

export const RULE_PREFIX = "rule:";
export const STAGE_PREFIX = "stage:";
export const STAGE_HEAD_PREFIX = "stage-head:";
export const NEW_STAGE_START_ID = "new-stage:start";
export const NEW_STAGE_END_ID = "new-stage:end";

export const ruleDndId = (ruleId: string) => `${RULE_PREFIX}${ruleId}`;
export const stageHeadDndId = (stageId: string) => `${STAGE_HEAD_PREFIX}${stageId}`;
export const stageDndId = (stageId: string) => `${STAGE_PREFIX}${stageId}`;

export interface DndStage {
  stageId: string;
  ruleIds: string[];
}

export type DropAction =
  | { type: "moveRuleToNewStage"; ruleId: string; position: "start" | "end" }
  | { type: "reorderStage"; stageId: string; index: number };

// Live stageId -> ruleIds layout shown while a rule is dragged (the dragged rule sits in its
// would-be slot, which the UI renders as the placeholder).
export type PreviewLayout = Record<string, string[]>;

export function initialPreview(stages: DndStage[]): PreviewLayout {
  return Object.fromEntries(stages.map((s) => [s.stageId, [...s.ruleIds]]));
}

export function containerOf(ruleId: string, layout: PreviewLayout): string | undefined {
  return Object.keys(layout).find((k) => layout[k].includes(ruleId));
}

// Next preview layout when the dragged `ruleId` hovers `overId`, or null when nothing changes.
// Over a rule: inserted above it (`below` false) or below it. Over a stage's title/toolbar: becomes
// that stage's first slot. Over an empty stage body: becomes its only rule. Anything else
// (including the dragged rule itself and non-empty stage bodies) leaves the layout as is.
export function movePreview(preview: PreviewLayout, ruleId: string, overId: string, below: boolean): PreviewLayout | null {
  const from = containerOf(ruleId, preview);
  if (!from) return null;
  let to: string | undefined;
  let index = 0;
  if (overId.startsWith(RULE_PREFIX)) {
    const overRuleId = overId.slice(RULE_PREFIX.length);
    if (overRuleId === ruleId) return null;
    to = containerOf(overRuleId, preview);
    if (!to) return null;
    index = preview[to].filter((id) => id !== ruleId).indexOf(overRuleId) + (below ? 1 : 0);
  } else if (overId.startsWith(STAGE_HEAD_PREFIX)) {
    to = overId.slice(STAGE_HEAD_PREFIX.length);
  } else if (overId.startsWith(STAGE_PREFIX)) {
    to = overId.slice(STAGE_PREFIX.length);
    if (!preview[to] || preview[to].length > 0) return null;
  } else {
    return null;
  }
  if (!preview[to]) return null;
  const target = to;
  const next: PreviewLayout = {};
  for (const [k, v] of Object.entries(preview)) next[k] = v.filter((id) => id !== ruleId);
  next[target] = [...next[target].slice(0, index), ruleId, ...next[target].slice(index)];
  if (target === from && next[target].join() === preview[target].join()) return null;
  return next;
}

// Store placement for the rule's final preview slot, or null when it ended up where it started.
export function finalizeRuleDrop(preview: PreviewLayout, ruleId: string, stages: DndStage[]): { targetStageId: string; index: number } | null {
  const targetStageId = containerOf(ruleId, preview);
  if (!targetStageId) return null;
  const index = preview[targetStageId].indexOf(ruleId);
  const origin = stages.find((s) => s.ruleIds.includes(ruleId));
  if (origin?.stageId === targetStageId && origin.ruleIds[index] === ruleId) return null;
  return { targetStageId, index };
}

// Maps a drag-end (`activeId` dropped over `overId`) to a store action, or null. Rule drops onto
// existing stages are handled by the preview layout (`finalizeRuleDrop`); this only covers a rule
// dropped on an outer "new stage" zone, and stage reordering (a stage dropped on a rule resolves to
// that rule's stage; stage drops never create a stage).
export function resolveDrop(activeId: string, overId: string | null, stages: DndStage[]): DropAction | null {
  if (!overId || activeId === overId) return null;

  if (activeId.startsWith(RULE_PREFIX)) {
    const ruleId = activeId.slice(RULE_PREFIX.length);
    if (overId === NEW_STAGE_START_ID) return { type: "moveRuleToNewStage", ruleId, position: "start" };
    if (overId === NEW_STAGE_END_ID) return { type: "moveRuleToNewStage", ruleId, position: "end" };
    return null;
  }

  if (activeId.startsWith(STAGE_PREFIX)) {
    const stageId = activeId.slice(STAGE_PREFIX.length);
    let overStage: DndStage | undefined;
    if (overId.startsWith(STAGE_PREFIX)) overStage = stages.find((s) => s.stageId === overId.slice(STAGE_PREFIX.length));
    else if (overId.startsWith(RULE_PREFIX)) overStage = stages.find((s) => s.ruleIds.includes(overId.slice(RULE_PREFIX.length)));
    else if (overId === NEW_STAGE_START_ID) return { type: "reorderStage", stageId, index: 0 };
    else if (overId === NEW_STAGE_END_ID) return { type: "reorderStage", stageId, index: stages.length - 1 };
    if (!overStage || overStage.stageId === stageId) return null;
    return { type: "reorderStage", stageId, index: stages.findIndex((s) => s.stageId === overStage.stageId) };
  }
  return null;
}
