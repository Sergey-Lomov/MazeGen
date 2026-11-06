import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// GitHub issue #927 — a settings component may not decide on its own what to show. Every conditional render
// (`cond && <X/>`, `cond ? <X/> : <Y/>`) in a component that renders link-aware rows must be one of:
// a schema gate (`gate("name")` / `useGate("name")`, or a local const holding one), the expansion or dialog
// state of the UI, or a condition listed below with the reason it is not a visibility rule of a field. A
// condition on a setting or a store field that the schema rules do not know would hide a field the schema calls
// active, and the panel-vs-schema test cannot notice it unless it happens to flip that very setting.

const featuresDir = join(__dirname, "..", "components", "features");

function settingsPanelFiles(): string[] {
  return readdirSync(featuresDir)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => /Linked(Select|Slider|Color|Toggle|TextField)Row|LinkContextProvider/.test(readFileSync(join(featuresDir, name), "utf8")));
}

const GATE_CALL = /^(use)?[gG]ate\(.+\)$/;
/** UI state, not data: section/subsection expansion and open dialogs. */
const UI_STATE = /^(\w*[Ee]xpanded(\.\w+|\(.*\))?|\w+Open)$/;

const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);
const isJsx = (node: ts.Expression): boolean => {
  const inner = unwrap(node);
  return ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner) || ts.isJsxFragment(inner);
};
const isAnd = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
const text = (node: ts.Node): string => node.getText().replace(/\s+/g, " ");

/** The operands of `a && b && c`. */
function operands(node: ts.Expression): ts.Expression[] {
  const inner = unwrap(node);
  return isAnd(inner) ? [...operands(inner.left), ...operands(inner.right)] : [inner];
}

/** `file: operand` of every conditional-render operand that is not a gate or UI state. */
let cachedConditions: string[] | undefined;
function conditions(): string[] {
  cachedConditions ??= scanConditions();
  return cachedConditions;
}

function scanConditions(): string[] {
  const found: string[] = [];
  for (const name of settingsPanelFiles()) {
    const sf = ts.createSourceFile(name, readFileSync(join(featuresDir, name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const locals = new Map<string, string>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) locals.set(node.name.text, text(node.initializer));
      ts.forEachChild(node, collect);
    };
    collect(sf);

    const accept = (operand: string): boolean => {
      const bare = operand.replace(/^!/, "");
      if (GATE_CALL.test(bare) || UI_STATE.test(bare)) return true;
      return /^\w+$/.test(bare) && GATE_CALL.test(locals.get(bare) ?? "");
    };
    const check = (condition: ts.Expression): void => {
      for (const operand of operands(condition)) if (!accept(text(operand))) found.push(`${name}: ${text(operand)}`);
    };
    const visit = (node: ts.Node): void => {
      if (isAnd(node) && isJsx(node.right) && !(node.parent && isAnd(node.parent) && node.parent.left === node)) check(node.left);
      if (ts.isConditionalExpression(node) && (isJsx(node.whenTrue) || isJsx(node.whenFalse))) check(node.condition);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...new Set(found)].sort();
}

const ALLOWED_CONDITIONS: Record<string, string> = {
  "EdgeMarkerSettingsSubsection.tsx: hasCollision": "warning icon of a marker cell that looks like another one",
  "EdgeMarkerSettingsSubsection.tsx: keys.length > 0": "the per-edge override list is shown only for floors that have edge markers",
  "FloorLabelSection.tsx: position.mode !== \"anchored\"": "picks the editor of the label-position union variant",
  "FloorLabelSection.tsx: position.mode === \"anchored\"": "picks the editor of the label-position union variant",
  "FloorLabelSection.tsx: position.mode === \"cell\"": "picks the editor of the label-position union variant",
  "FloorLabelSection.tsx: position.mode === \"free\"": "picks the editor of the label-position union variant",
  "MarkerFieldRows.tsx: autoFitKind": "the caller opts into the auto-fit button",
  "MarkerFieldRows.tsx: linkTargets.sizeAdaptation !== undefined": "the caller opts into the size-adaptation row (the schema gates it by `hasAreaSpread`)",
  "MarkerSettingsGroup.tsx: fields.textColor": "the caller opts into the text-colour row",
  "MarkerSettingsGroup.tsx: sectionId": "the caller opts into a collapsible section",
  "MarkerSettingsGroup.tsx: showTextSection": "the caller opts into the text subsection",
  "MarkerSettingsGroup.tsx: title": "the caller opts into a section title",
  "TeleportSettingsSection.tsx: activeRenderMode": "the connector editor button needs a render mode to edit; it is not a field",
  "TeleportSettingsSection.tsx: connectorShown": "the connector colour is hidden while the colour-visibility registry says it is not drawn",
  "TeleportSettingsSection.tsx: hasCollision": "warning icon of a group that looks like another one",
  "TeleportSettingsSection.tsx: teleportGroups.length > 0": "the group list is shown only when there are groups",
  "TopologySettingsSection.tsx: onTrimWallsAtFaceBoundaries": "the caller opts into the row (only 'Vector by walls' trims walls)",
  "VectorByWallsSettingsPanel.tsx: PC.tilesWall.isVisible(colorVisibility)": "the colour-visibility registry decides whether the tile wall colour is drawn",
};

describe("settings panel conditional renders", () => {
  it("every condition is a schema gate, UI state or listed with a reason", () => {
    expect(conditions().filter((condition) => !(condition in ALLOWED_CONDITIONS))).toEqual([]);
  });

  it("the list holds no stale entries", () => {
    const found = new Set(conditions());
    expect(Object.keys(ALLOWED_CONDITIONS).filter((condition) => !found.has(condition))).toEqual([]);
  });

  it("finds the settings components", () => {
    const files = settingsPanelFiles();
    expect(files).toContain("VectorByWallsSettingsPanel.tsx");
    expect(files).toContain("TeleportSettingsSection.tsx");
  });
});
