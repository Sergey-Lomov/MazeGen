import type React from "react";
import { ToolIconButton } from "./ToolIconButton";
import { ToolGlyph } from "./features/ToolGlyph";
import type { ToolGlyphKey } from "./features/toolGlyphs";
import { spacing } from "../styles/theme";

interface Props<T extends string> {
  tools: readonly (readonly [T, string])[];
  activeTool: T;
  onPick: (tool: T) => void;
  glyphFor?: (tool: T) => ToolGlyphKey;
  isDanger?: (tool: T) => boolean;
}

/** Generic tool-button row shared by preset and post-edit feature catalogs. */
export function ToolIconRow<T extends string>({ tools, activeTool, onPick, glyphFor, isDanger }: Props<T>) {
  return (
    <div style={styles.row}>
      {tools.map(([tool, label]) => (
        <ToolIconButton
          key={tool}
          selected={activeTool === tool}
          danger={isDanger?.(tool) ?? false}
          title={label}
          onClick={() => onPick(tool)}
        >
          <ToolGlyph tool={glyphFor?.(tool) ?? tool as ToolGlyphKey} />
        </ToolIconButton>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: "flex", flexWrap: "wrap", gap: spacing.itemGap },
};
