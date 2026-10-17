import type { PresetConnectionTool } from "./fieldEditUtils";
import type { PostEditTool } from "../store/postEditTypes";

type Shortcut = readonly string[];

const SHARED_TOOL_SHORTCUTS: Partial<Record<PresetConnectionTool | PostEditTool, Shortcut>> = {
  wall: ["W"],
  passage: ["P"],
  one_way: ["Alt", "P"],
  set_start: ["S"],
  set_finish: ["F"],
  teleport_two_way: ["T"],
  teleport_one_way: ["Alt", "T"],
  vertical_passage_two_way: ["V"],
  vertical_passage_one_way: ["Alt", "V"],
  elevator: ["E"],
  manage_split_nodes: ["N"],
  move: ["M"],
  settings: ["C"],
  reset: ["R"],
};

const PRESET_TOOL_SHORTCUTS: Partial<Record<PresetConnectionTool, Shortcut>> = {
  ...SHARED_TOOL_SHORTCUTS,
  lock_in: ["I"],
  lock_out: ["O"],
  full_lock: ["L"],
  gen_source: ["G"],
  clear: ["D"],
};

const POST_EDIT_TOOL_SHORTCUTS: Partial<Record<PostEditTool, Shortcut>> = {
  ...SHARED_TOOL_SHORTCUTS,
  delete: ["D"],
};

export function presetToolShortcut(tool: PresetConnectionTool): Shortcut | undefined {
  return PRESET_TOOL_SHORTCUTS[tool];
}

export function postEditToolShortcut(tool: PostEditTool): Shortcut | undefined {
  return POST_EDIT_TOOL_SHORTCUTS[tool];
}

export function presetToolForShortcut(e: KeyboardEvent, allowVertical = true): PresetConnectionTool | undefined {
  const tool = findToolForShortcut(PRESET_TOOL_SHORTCUTS, e);
  return allowVertical || !isVerticalTool(tool) ? tool : undefined;
}

export function postEditToolForShortcut(e: KeyboardEvent, allowVertical = true): PostEditTool | undefined {
  const tool = findToolForShortcut(POST_EDIT_TOOL_SHORTCUTS, e);
  return allowVertical || !isVerticalTool(tool) ? tool : undefined;
}

/** Removes a previously focused feature-card header so a keyboard tool selection does not leave a
 * tab-focus outline around an unrelated card. */
export function blurActiveElement(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function findToolForShortcut<T extends string>(shortcuts: Partial<Record<T, Shortcut>>, e: KeyboardEvent): T | undefined {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return undefined;
  return (Object.entries(shortcuts) as [T, Shortcut][]).find(([, shortcut]) =>
    e.altKey === (shortcut[0] === "Alt") && e.code === `Key${shortcut.at(-1)}`,
  )?.[0];
}

function isVerticalTool(tool: string | undefined): boolean {
  return tool === "vertical_passage_two_way" || tool === "vertical_passage_one_way" || tool === "elevator";
}
