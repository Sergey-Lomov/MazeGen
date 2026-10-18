import type { PathCommand } from "../../wasm/mazeService";
import { IDENTITY_TRANSFORM, transformCommand, type WorldTransform } from "./worldTransform";

/// The drawing surface a path is traced onto: Pixi `Graphics` and `CanvasRenderingContext2D`
/// both satisfy it.
export interface PathTarget {
  moveTo(x: number, y: number): unknown;
  lineTo(x: number, y: number): unknown;
}

/// Largest angle one chord of a traced arc spans: at 64 chords per circle the chord error is under
/// 0.05% of the radius.
const MAX_CHORD_ANGLE = Math.PI / 32;

/// Generic renderer for core's path commands (`Specs/space.md`, "Path commands"): every command
/// kind is supported on every target. A new segment kind adds its command here, in `pathToSvg`,
/// and in `transformCommand`. In the target space `ccw` means "angle increases" (the command's
/// own convention). An arc is traced as chords whose end points lie exactly on the circle and whose
/// last point is the arc's end, so arcs meeting at a shared vertex join exactly and trace the same
/// polyline as the geometry used for chaining and export; the targets' own `arc` places its
/// joints differently.
export function tracePath(target: PathTarget, commands: readonly PathCommand[], transform: WorldTransform = IDENTITY_TRANSFORM): void {
  let current: [number, number] | undefined;
  const lineTo = (x: number, y: number) => {
    target.lineTo(x, y);
    current = [x, y];
  };
  for (const source of commands) {
    const command = transformCommand(transform, source);
    switch (command.op) {
      case "move_to":
        target.moveTo(command.to[0], command.to[1]);
        current = [command.to[0], command.to[1]];
        break;
      case "line_to":
        lineTo(command.to[0], command.to[1]);
        break;
      case "arc_to": {
        const [cx, cy] = command.center;
        const sweep = arcSweep(command.start_angle, command.end_angle, command.ccw);
        const pointAt = (angle: number): [number, number] => [cx + command.radius * Math.cos(angle), cy + command.radius * Math.sin(angle)];
        const [startX, startY] = pointAt(command.start_angle);
        if (!current) target.moveTo(startX, startY);
        else if (Math.hypot(current[0] - startX, current[1] - startY) > 1e-9) target.lineTo(startX, startY);
        const chords = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_CHORD_ANGLE));
        for (let i = 1; i <= chords; i++) lineTo(...pointAt(command.start_angle + (sweep * i) / chords));
        break;
      }
    }
  }
}

const TWO_PI = Math.PI * 2;

/// Signed angular travel of an arc, positive when the angle increases, in `(-2π, 2π]`.
export function arcSweep(startAngle: number, endAngle: number, increasing: boolean): number {
  let sweep = (endAngle - startAngle) % TWO_PI;
  if (increasing && sweep <= 0) sweep += TWO_PI;
  if (!increasing && sweep >= 0) sweep -= TWO_PI;
  return sweep;
}

function format(value: number): string {
  return String(Number(value.toFixed(4)));
}

/// SVG path data (`d` attribute) of a command list. Coordinates are in the target space, so with
/// SVG's Y-down axis a Y-flipping transform is the caller's. A full circle is emitted as two arcs
/// (SVG cannot draw an arc whose endpoints coincide).
export function pathToSvg(commands: readonly PathCommand[], transform: WorldTransform = IDENTITY_TRANSFORM): string {
  const parts: string[] = [];
  for (const source of commands) {
    const command = transformCommand(transform, source);
    if (command.op === "move_to") {
      parts.push(`M ${format(command.to[0])} ${format(command.to[1])}`);
    } else if (command.op === "line_to") {
      parts.push(`L ${format(command.to[0])} ${format(command.to[1])}`);
    } else {
      const [cx, cy] = command.center;
      const sweep = arcSweep(command.start_angle, command.end_angle, command.ccw);
      const sweepFlag = command.ccw ? 1 : 0;
      const pointAt = (angle: number) => `${format(cx + command.radius * Math.cos(angle))} ${format(cy + command.radius * Math.sin(angle))}`;
      const radius = format(command.radius);
      if (Math.abs(sweep) >= TWO_PI - 1e-12) {
        const middle = command.start_angle + sweep / 2;
        parts.push(`A ${radius} ${radius} 0 0 ${sweepFlag} ${pointAt(middle)}`);
        parts.push(`A ${radius} ${radius} 0 0 ${sweepFlag} ${pointAt(command.end_angle)}`);
      } else {
        parts.push(`A ${radius} ${radius} 0 ${Math.abs(sweep) > Math.PI ? 1 : 0} ${sweepFlag} ${pointAt(command.end_angle)}`);
      }
    }
  }
  return parts.join(" ");
}
