import React from "react";
import { Circle, ClipboardPaste, Copy, FlipHorizontal, Hexagon, Minus, Plus, Square, Triangle } from "lucide-react";
import { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { FieldPrimitive, FieldOperation } from "../../store/mazeStore";
import { requiresExactCells } from "../../fieldConfig";
import { ToolIconButton, ToolTooltip } from "../ToolIconButton";
import { typography, muted, spacing, indent } from "../../styles/theme";
import { Inline } from "../Layout";
import { ToggleRow } from "../ToggleRow";
import { Modal } from "../Modal";
import { DEFAULT_MAZE_RENDER_STYLE } from "../../domain/defaultMazeRenderStyle";
import { canvas } from "../../domain/colorTokens";
import { TILE_SIZE } from "../../domain/constants";
import { fieldOperationAvailable } from "../../domain/fieldOps";
import { smoothingOf, zoneEditActive } from "../../store/fieldEditTarget";
import { colorToHex } from "../colorFormat";
import { copyFieldSelection, fieldClipboardBlock, pasteFieldClipboard, type FieldClipboardBlock } from "../../pixi/fieldClipboard";
import { canActivateFieldPrimitive, fieldPrimitiveShortcut, ZONE_COMBINE_SHORTCUT } from "../../pixi/fieldPrimitiveShortcuts";
import * as m from "~/paraglide/messages";

/** The shape tools shared by the custom field editor (`FieldSetupFeature`) and the zone editor
 *  (`ZoneEditPanel`, GitHub issue #1031): the same modes, tools, clipboard and smoothing controls
 *  acting on whichever target the canvas edits (`store/fieldEditTarget.ts`). */

const OPERATION_SHORTCUTS: Record<FieldOperation, readonly string[]> = {
  add: ["+"],
  remove: ["−"],
  select: ["0"],
};

const CLIPBOARD_MODIFIER = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "⌘" : "Ctrl";


/** Add / Remove / Select modes and the shape, polygon, connected area, mirror, copy and paste tools. */
export function FieldToolsSection({ leadingGap = true }: { leadingGap?: boolean } = {}) {
  // Primitives derived from the config: a custom field's config object is rebuilt on every cell edit.
  const reflectAvailable = useMazeStore((s) => fieldOperationAvailable(s.floorFields[s.activeFloorId].fieldConfig.tessellation, "reflect"));
  const copyBlock = useMazeStore((s) => fieldClipboardBlock("copy", s.floorFields[s.activeFloorId].fieldConfig.tessellation, s.fieldHasSelection, s.fieldClipboard !== null));
  const pasteBlock = useMazeStore((s) => fieldClipboardBlock("paste", s.floorFields[s.activeFloorId].fieldConfig.tessellation, s.fieldHasSelection, s.fieldClipboard !== null));
  const fieldPrimitive = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPrimitive);
  const fieldOperation = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldOperation);
  const setFieldPrimitive = useMazeStore((s) => s.setFieldPrimitive);
  const setFieldOperation = useMazeStore((s) => s.setFieldOperation);
  const fieldEditLocked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);
  const zoneEditing = useMazeStore((s) => zoneEditActive(s));
  const combineOpen = useMazeStore((s) => s.zoneCombine !== null);
  const toggleCombine = useMazeStore((s) => s.toggleZoneCombine);

  function renderClipboardTool(tool: "copy" | "paste", block: FieldClipboardBlock | null) {
    const description = block === "tessellation" ? m["field.clipboard.tessellation_disabled"]()
      : block === "no_selection" ? m["field.copy.empty_selection"]()
      : block === "empty_clipboard" ? m["field.paste.empty_clipboard"]()
      : undefined;
    return (
      <ToolIconButton
        selected={false}
        disabled={fieldEditLocked || block !== null}
        title={tool === "copy" ? m["field.copy.tool"]() : m["field.paste.tool"]()}
        shortcut={[CLIPBOARD_MODIFIER, tool === "copy" ? "C" : "V"]}
        description={description}
        preservesFieldSelection
        onClick={tool === "copy" ? copyFieldSelection : pasteFieldClipboard}
      >
        {tool === "copy" ? <Copy {...toolIconProps()} /> : <ClipboardPaste {...toolIconProps()} />}
      </ToolIconButton>
    );
  }

  return (
    <>
          <div style={leadingGap ? styles.sectionLabel : { ...styles.sectionLabel, marginTop: 0 }}>{m["field.modes"]()}</div>
          <Inline gap="itemGap" style={styles.nestedContent}>
            {(["add", "remove", "select"] as FieldOperation[]).map((operation) => (
              <ToolIconButton
                key={operation}
                selected={fieldOperation === operation}
                disabled={fieldEditLocked}
                title={m[`field.mode.${operation}` as "field.mode.add" | "field.mode.remove" | "field.mode.select"]()}
                shortcut={OPERATION_SHORTCUTS[operation]}
                onClick={() => setFieldOperation(operation)}
              >
                {operationIcon(operation)}
              </ToolIconButton>
            ))}
          </Inline>
          <div style={styles.sectionLabel}>{m["field.tools"]()}</div>
          <Inline gap="itemGap" style={{ ...styles.nestedContent, flexWrap: "wrap" }}>
          {primitivesForField().map((tool) => {
            const shortcut = fieldPrimitiveShortcut(tool.primitive);
            return <ToolIconButton
              key={tool.key}
              selected={fieldPrimitive === tool.primitive}
              disabled={!canActivateFieldPrimitive(tool.primitive, fieldOperation, fieldEditLocked, reflectAvailable)}
              title={tool.label}
              shortcut={shortcut ? [shortcut] : undefined}
              description={tool.primitive === "mirror" && !reflectAvailable
                ? m["field.mirror.tessellation_disabled"]()
                : tool.primitive === "mirror" && fieldOperation === "select"
                ? m["field.mirror.select_disabled"]()
                : tool.primitive === "polygon"
                ? m["field.polygon.shift_tooltip"]()
                : tool.primitive === "magic_wand" ? m["field.connected_area.tooltip"]() : undefined}
              descriptionShortcut={tool.primitive === "polygon" ? ["shift"] : undefined}
              onClick={() => {
                setFieldPrimitive(tool.primitive);
              }}
            >
              {primitiveIcon(tool.primitive)}
            </ToolIconButton>;
          })}
          {renderClipboardTool("copy", copyBlock)}
          {renderClipboardTool("paste", pasteBlock)}
          {zoneEditing && (
            <ToolIconButton
              selected={combineOpen}
              disabled={fieldEditLocked}
              title={m["zones.combine_tool"]()}
              shortcut={[ZONE_COMBINE_SHORTCUT]}
              preservesFieldSelection
              onClick={toggleCombine}
            >
              {combineIcon()}
            </ToolIconButton>
          )}
          </Inline>
    </>
  );
}

/** The smoothing switch with its info dialog. The hold-`S` hint exists only in a custom editor. */
export function SmoothingToggleRow({ customEditor }: { customEditor: boolean }) {
  const exactCells = useMazeStore((s) => requiresExactCells(s.floorFields[s.activeFloorId].fieldConfig.shape));
  // The zone editor has its own switch, off by default, apart from the field's.
  const zoneEditing = useMazeStore((s) => zoneEditActive(s));
  const smoothPrimitives = useMazeStore((s) => smoothingOf(s));
  const setSmoothPrimitives = useMazeStore((s) => (zoneEditing ? s.setZoneSmoothing : s.setSmoothPrimitives));
  const smoothInverted = useMazeStore((s) => s.smoothInverted);
  const fieldEditLocked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);
  const [smoothingInfoOpen, setSmoothingInfoOpen] = useState(false);
  const row = (
    <ToggleRow
      label={m["field.smooth_primitives"]()}
      checked={smoothPrimitives !== smoothInverted && !exactCells}
      onChange={setSmoothPrimitives}
      disabled={fieldEditLocked || exactCells}
      disabledHint={exactCells ? m["field.smoothing_unavailable"]() : undefined}
      info={() => setSmoothingInfoOpen(true)}
    />
  );
  return (
    <>
      {customEditor ? (
        <ToolTooltip
          block
          title={m["field.smooth_primitives"]()}
          description={m["field.smooth_hold_hint"]()}
          descriptionShortcut={["S"]}
        >
          {row}
        </ToolTooltip>
      ) : row}
      {smoothingInfoOpen && (
        <Modal
          title={m["field.smoothing_info_title"]()}
          onClose={() => setSmoothingInfoOpen(false)}
        >
          <div style={styles.infoText}>{m["field.smoothing_info_description"]()}</div>
          {customEditor && <div style={{ ...styles.infoText, marginTop: 8 }}>{m["field.smoothing_info_hotkey"]()}</div>}
        </Modal>
      )}
    </>
  );
}

interface PrimitiveToolOption {
  key: string;
  primitive: FieldPrimitive;
  label: string;
}

function primitivesForField(): PrimitiveToolOption[] {
  const primitives: PrimitiveToolOption[] = [
    { key: "point", primitive: "point", label: m["field.shape.point"]() },
    { key: "rectangle", primitive: "rectangle", label: m["field.shape.rectangle"]() },
    { key: "circle", primitive: "circle", label: m["field.shape.circle"]() },
    { key: "triangle", primitive: "triangle", label: m["field.shape.right_triangle"]() },
    { key: "equilateral_triangle", primitive: "equilateral_triangle", label: m["field.shape.equilateral_triangle"]() },
    { key: "hexagon", primitive: "hexagon", label: m["field.shape.hexagon"]() },
    { key: "parallelogram", primitive: "parallelogram", label: m["field.shape.parallelogram"]() },
    { key: "polygon", primitive: "polygon", label: m["field.polygon.tool"]() },
    { key: "magic_wand", primitive: "magic_wand", label: m["field.connected_area.tool"]() },
    { key: "mirror", primitive: "mirror", label: m["field.mirror.tool"]() },
  ];
  return primitives;
}

function toolIconProps() {
  const iconSize = TILE_SIZE * 0.8;
  const wallStyle = DEFAULT_MAZE_RENDER_STYLE.wall;
  return {
    size: iconSize,
    color: colorToHex(canvas.wall.default),
    strokeWidth: wallStyle.width * 24 / iconSize,
    strokeLinecap: wallStyle.cap,
    strokeLinejoin: wallStyle.join,
  } as const;
}

function primitiveIcon(primitive: FieldPrimitive): React.ReactNode {
  const iconProps = toolIconProps();
  const iconSize = iconProps.size;
  const wallColor = iconProps.color;
  const wallStyle = DEFAULT_MAZE_RENDER_STYLE.wall;
  switch (primitive) {
    case "point":
      return (
        <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`} aria-hidden="true">
          <circle cx={iconSize / 2} cy={iconSize / 2} r={iconSize * 0.18} fill={wallColor} />
        </svg>
      );
    case "mirror": return <FlipHorizontal {...iconProps} />;
    case "magic_wand": {
      const cellSize = 5;
      const cellGap = 1;
      const shapeWidth = 3 * cellSize + 2 * cellGap;
      const shapeHeight = 2 * cellSize + cellGap;
      const gridOriginX = (24 - shapeWidth) / 2;
      const gridOriginY = (24 - shapeHeight) / 2;
      const cellRadius = cellSize * 0.2;
      const filledCells = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 2]];
      return (
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <g fill={wallColor}>
            {filledCells.map(([row, col]) => (
              <rect
                key={row + "-" + col}
                x={gridOriginX + col * (cellSize + cellGap)}
                y={gridOriginY + row * (cellSize + cellGap)}
                width={cellSize}
                height={cellSize}
                rx={cellRadius}
                ry={cellRadius}
              />
            ))}
          </g>
        </svg>
      );
    }
    case "rectangle": return <Square {...iconProps} />;
    case "circle": return <Circle {...iconProps} />;
    case "triangle":
      return (
        <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`} fill="none" aria-hidden="true">
          <path
            d={`M${iconSize * 0.2} ${iconSize * 0.8}V${iconSize * 0.2}L${iconSize * 0.8} ${iconSize * 0.8}Z`}
            stroke={wallColor}
            strokeWidth={wallStyle.width}
            strokeLinecap={wallStyle.cap}
            strokeLinejoin={wallStyle.join}
          />
        </svg>
      );
    case "equilateral_triangle": return <Triangle {...iconProps} />;
    case "hexagon": return <Hexagon {...iconProps} />;
    case "parallelogram":
      return (
        <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`} fill="none" aria-hidden="true">
          <path
            d={`M${iconSize * 0.28} ${iconSize * 0.14}h${iconSize * 0.56}l-${iconSize * 0.12} ${iconSize * 0.72}H${iconSize * 0.16}z`}
            stroke={wallColor}
            strokeWidth={wallStyle.width}
            strokeLinecap={wallStyle.cap}
            strokeLinejoin={wallStyle.join}
          />
        </svg>
      );
    case "polygon":
      return (
        <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`} fill="none" aria-hidden="true">
          <path
            d={`M${iconSize * 0.18} ${iconSize * 0.72}L${iconSize * 0.3} ${iconSize * 0.2}L${iconSize * 0.78} ${iconSize * 0.14}L${iconSize * 0.86} ${iconSize * 0.68}L${iconSize * 0.52} ${iconSize * 0.86}Z`}
            stroke={wallColor}
            strokeWidth={wallStyle.width}
            strokeLinecap={wallStyle.cap}
            strokeLinejoin={wallStyle.join}
          />
        </svg>
      );
  }
}

/** Two overlapping circles: the zone combination tool. */
function combineIcon(): React.ReactNode {
  const { size, color, strokeWidth } = toolIconProps();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="12" r="6" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="15" cy="12" r="6" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

function operationIcon(operation: FieldOperation): React.ReactNode {
  const color = operation === "add"
    ? colorToHex(canvas.fieldEditor.previewAdd)
    : operation === "remove"
      ? colorToHex(canvas.fieldEditor.previewRemove)
      : colorToHex(canvas.fieldEditor.previewSelect);
  if (operation === "select") {
    const size = TILE_SIZE * 0.8;
    // Use the same 24x24 coordinate system as FlipHorizontal. This keeps the physical
    // stroke width identical after the SVG is scaled to the button size.
    const frameOffset = 3;
    const side = 18;
    // Keep the 1:2:1 line ratio while making both gaps exactly one quarter of a side.
    const segments = [
      [0, side / 8],
      [side * 3 / 8, side * 5 / 8],
      [side * 7 / 8, side],
    ] as const;
    const wallStyle = DEFAULT_MAZE_RENDER_STYLE.wall;
    const dashPath = [
      ...segments.map(([start, end]) => `M${frameOffset + start} ${frameOffset}h${end - start}`),
      ...segments.map(([start, end]) => `M${frameOffset + side} ${frameOffset + start}v${end - start}`),
      ...segments.map(([start, end]) => `M${frameOffset + side - end} ${frameOffset + side}h${end - start}`),
      ...segments.map(([start, end]) => `M${frameOffset} ${frameOffset + side - end}v${end - start}`),
    ].join(" ");
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d={dashPath}
          stroke={color}
          strokeWidth={wallStyle.width * 24 / size}
          strokeLinecap={wallStyle.cap}
          strokeLinejoin={wallStyle.join}
        />
      </svg>
    );
  }
  const Icon = operation === "add" ? Plus : Minus;
  return <Icon size={TILE_SIZE * 0.7} color={color} strokeWidth={2.5} />;
}


const styles: Record<string, React.CSSProperties> = {
  sectionLabel: { ...typography.body, marginTop: spacing.groupGap },
  // One indent level for the "Tools" section's own content, relative to `sectionLabel`.
  nestedContent: { paddingLeft: indent.tree, minWidth: 0, boxSizing: "border-box", width: "100%" },
  infoText: { ...typography.body, ...muted(typography.body) },
};
