import { describe, it, expect, vi } from "vitest";
import type { PostEditTool } from "../store/postEditTypes";
import type { PresetConnectionTool } from "../pixi/fieldEditUtils";

// `toolGlyphs` pulls in pixi.js at module load (`Application`, `Graphics`); the offscreen render
// path itself needs a real GL context and is not exercised here — only the static `GLYPHS` map.
vi.mock("pixi.js", () => ({
  Application: vi.fn(),
  Graphics: vi.fn(),
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
}));

const { GLYPHS } = await import("../components/features/toolGlyphs");

// Every tool value, spelled out so tsc's `Record` exhaustiveness check breaks this file the moment
// a new tool is added to the union — forcing a decision here (glyph, or explicit exemption below)
// instead of silently shipping a blank icon button.
const ALL_POST_EDIT_TOOLS: Record<PostEditTool, true> = {
  wall: true,
  passage: true,
  reset: true,
  delete: true,
  one_way: true,
  set_start: true,
  set_finish: true,
  teleport_one_way: true,
  teleport_two_way: true,
  vertical_passage_one_way: true,
  vertical_passage_two_way: true,
  elevator: true,
  manage_split_nodes: true,
};

const ALL_PRESET_TOOLS: Record<PresetConnectionTool, true> = {
  wall: true,
  passage: true,
  reset: true,
  one_way: true,
  set_start: true,
  set_finish: true,
  lock_in: true,
  lock_out: true,
  full_lock: true,
  gen_source: true,
  teleport_one_way: true,
  teleport_two_way: true,
  vertical_passage_one_way: true,
  vertical_passage_two_way: true,
  elevator: true,
  manage_split_nodes: true,
  clear: true,
};

// Post-edit's `reset` tool has different semantics from the preset `reset` (undecided-edge stub),
// so it maps to the synthetic `post_edit_reset` key via `glyphKeyFor`, not to `GLYPHS.reset`.
const POST_EDIT_GLYPH_KEY: Partial<Record<PostEditTool, string>> = { reset: "post_edit_reset" };

describe("toolGlyphs GLYPHS completeness", () => {
  it("every PostEditTool resolves to a glyph function", () => {
    for (const tool of Object.keys(ALL_POST_EDIT_TOOLS) as PostEditTool[]) {
      const key = POST_EDIT_GLYPH_KEY[tool] ?? tool;
      expect(GLYPHS[key as keyof typeof GLYPHS], `missing glyph for post-edit tool "${tool}"`).toBeTypeOf("function");
    }
  });

  it("every PresetConnectionTool resolves to a glyph function", () => {
    for (const tool of Object.keys(ALL_PRESET_TOOLS) as PresetConnectionTool[]) {
      expect(GLYPHS[tool as keyof typeof GLYPHS], `missing glyph for preset tool "${tool}"`).toBeTypeOf("function");
    }
  });

  it("post_edit_reset is a distinct entry, not an alias of the preset reset stub", () => {
    expect(GLYPHS.post_edit_reset).toBeTypeOf("function");
    expect(GLYPHS.post_edit_reset).not.toBe(GLYPHS.reset);
  });
});
