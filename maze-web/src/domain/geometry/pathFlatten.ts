import type { PathCommand, SegmentDto, WorldPoint } from "../../wasm/mazeService";
import { arcSweep } from "./pathRenderer";

/// Fewest chords an arc is split into, so a tiny tolerance relative to the radius cannot yield a
/// degenerate flattening.
const MIN_ARC_CHORDS = 2;
/// Most chords of one arc; bounds the cost of a near-zero tolerance.
const MAX_ARC_CHORDS = 256;

function arcPoints(
  center: WorldPoint,
  radius: number,
  startAngle: number,
  sweep: number,
  tolerance: number,
  out: WorldPoint[],
): void {
  // A chord of angle `step` deviates from its arc by `r(1 - cos(step / 2))`.
  const ratio = Math.min(1, tolerance / Math.max(radius, tolerance));
  const maxStep = 2 * Math.acos(1 - ratio);
  const chords = Math.min(MAX_ARC_CHORDS, Math.max(MIN_ARC_CHORDS, Math.ceil(Math.abs(sweep) / maxStep)));
  for (let i = 1; i <= chords; i++) {
    const angle = startAngle + (sweep * i) / chords;
    out.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
}

/// Flattens path commands to a polyline within `tolerance` of the true curve (arcs become chords;
/// `move_to` starts a new chain only at the first command). For a closed boundary the first point
/// is not repeated at the end.
export function flattenCommands(commands: readonly PathCommand[], tolerance: number): WorldPoint[] {
  const points: WorldPoint[] = [];
  for (const command of commands) {
    if (command.op === "arc_to") {
      const sweep = arcSweep(command.start_angle, command.end_angle, command.ccw);
      const first: WorldPoint = [
        command.center[0] + command.radius * Math.cos(command.start_angle),
        command.center[1] + command.radius * Math.sin(command.start_angle),
      ];
      const last = points[points.length - 1];
      if (!last || Math.hypot(last[0] - first[0], last[1] - first[1]) > 1e-9) points.push(first);
      arcPoints(command.center, command.radius, command.start_angle, sweep, tolerance, points);
    } else {
      points.push(command.to);
    }
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-9) points.pop();
  return points;
}

/// The path commands of one face segment chain; `move_to` the first start point.
export function segmentsToCommands(segments: readonly SegmentDto[]): PathCommand[] {
  const commands: PathCommand[] = [];
  segments.forEach((segment, index) => {
    if (index === 0) commands.push({ op: "move_to", to: segment.from });
    if (segment.kind === "line") {
      commands.push({ op: "line_to", to: segment.to });
    } else {
      commands.push({
        op: "arc_to",
        center: segment.center,
        radius: segment.radius,
        start_angle: segment.start_angle,
        end_angle: segment.start_angle + segment.sweep,
        ccw: segment.sweep > 0,
      });
    }
  });
  return commands;
}

/// The open polyline of a face's segments, both ends included.
export function flattenSegments(segments: readonly SegmentDto[], tolerance: number): WorldPoint[] {
  const points: WorldPoint[] = [];
  for (const command of segmentsToCommands(segments)) {
    if (command.op === "arc_to") {
      arcPoints(
        command.center,
        command.radius,
        command.start_angle,
        arcSweep(command.start_angle, command.end_angle, command.ccw),
        tolerance,
        points,
      );
    } else {
      points.push(command.to);
    }
  }
  return points;
}
