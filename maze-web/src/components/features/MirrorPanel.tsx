import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { mirrorStatus } from "../../pixi/mirror";
import { fieldOpErrorMessage } from "../../pixi/fieldOps";
import { Button } from "../Button";
import { SidePanel } from "../SidePanel";
import { WarningBubble } from "../WarningBubble";
import { Inline, Stack } from "../Layout";
import { indent, spacing } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import * as m from "~/paraglide/messages";

export function MirrorPanel() {
  const mirrorSnapMode = useMazeStore((s) => s.mirrorSnapMode);
  const mirrorScope = useMazeStore((s) => s.mirrorScope);
  const mirrorAxisPoints = useMazeStore((s) => s.mirrorAxisPoints);
  const mirrorSourceSide = useMazeStore((s) => s.mirrorSourceSide);
  const mirrorPolygon = useMazeStore((s) => s.mirrorPolygon);
  const mirrorPolygonFinished = useMazeStore((s) => s.mirrorPolygonFinished);
  const setFieldPrimitive = useMazeStore((s) => s.setFieldPrimitive);
  const setMirrorSnapMode = useMazeStore((s) => s.setMirrorSnapMode);
  const setMirrorScope = useMazeStore((s) => s.setMirrorScope);
  const setMirrorSourceSide = useMazeStore((s) => s.setMirrorSourceSide);
  const finishMirrorPolygon = useMazeStore((s) => s.finishMirrorPolygon);
  const resetMirrorPolygon = useMazeStore((s) => s.resetMirrorPolygon);
  const resetMirrorAxis = useMazeStore((s) => s.resetMirrorAxis);
  const applyMirror = useMazeStore((s) => s.applyMirror);
  const fieldOpError = useMazeStore((s) => s.fieldOpError);

  const status = mirrorStatus({
    axisPoints: mirrorAxisPoints,
    scope: mirrorScope,
    polygon: mirrorPolygon,
    polygonFinished: mirrorPolygonFinished,
  });

  function closePanel() {
    resetMirrorAxis();
    setFieldPrimitive("point");
  }

  const hint = status === "axis"
    ? m["field.mirror.status.axis"]()
    : status === "polygon"
      ? mirrorPolygon.length >= 3 && !mirrorPolygonFinished
        ? m["field.mirror.status.finish_polygon"]()
        : m["field.mirror.status.polygon"]()
      : null;
  const canApply = status === "ready" && fieldOpError === null;

  return (
    <SidePanel title={m["field.mirror.tool"]()} stackKey="mirror" onClose={closePanel}>
      <Stack gap="groupGap" style={styles.body}>
        <Stack gap="itemGap">
          <div style={styles.sectionLabel}>{m["field.mirror.snap"]()}</div>
          <Inline gap="itemGap" style={styles.nestedContent}>
            <Button
              variant={mirrorSnapMode === "centers" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setMirrorSnapMode("centers")}
            >
              {m["field.mirror.centers"]()}
            </Button>
            <Button
              variant={mirrorSnapMode === "corners" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setMirrorSnapMode("corners")}
            >
              {m["field.mirror.corners"]()}
            </Button>
            <Button
              variant={mirrorSnapMode === "free" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setMirrorSnapMode("free")}
            >
              {m["field.mirror.free"]()}
            </Button>
          </Inline>
        </Stack>

        <Stack gap="itemGap">
          <div style={styles.sectionLabel}>{m["field.mirror.scope"]()}</div>
          <Inline gap="itemGap" style={styles.nestedContent}>
            <Button
              variant={mirrorScope === "everything" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setMirrorScope("everything")}
            >
              {m["field.mirror.everything"]()}
            </Button>
            <Button
              variant={mirrorScope === "one_side" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setMirrorScope("one_side")}
            >
              {m["field.mirror.one_side"]()}
            </Button>
            <Button
              variant={mirrorScope === "polygon" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setMirrorScope("polygon")}
            >
              {m["field.mirror.polygon"]()}
            </Button>
          </Inline>
        </Stack>

        <Stack gap="itemGap">
          {mirrorScope === "one_side" && mirrorAxisPoints.length === 2 && (
            <Button variant="secondary" onClick={() => setMirrorSourceSide(mirrorSourceSide === 1 ? -1 : 1)}>
              {m["field.mirror.change_direction"]()}
            </Button>
          )}
          {mirrorAxisPoints.length > 0 && (
            <Button variant="secondary" onClick={resetMirrorAxis}>
              {m["field.mirror.reset_axis"]()}
            </Button>
          )}
          {mirrorScope === "polygon" && mirrorPolygon.length > 0 && (
            <>
              {!mirrorPolygonFinished && mirrorPolygon.length >= 3 && (
                <Button variant="secondary" onClick={finishMirrorPolygon}>
                  {m["field.mirror.finish_polygon"]()}
                </Button>
              )}
              <Button variant="secondary" onClick={resetMirrorPolygon}>
                {m["field.mirror.reset_polygon"]()}
              </Button>
            </>
          )}
          <Button variant="primary" disabled={!canApply} onClick={applyMirror}>
            {m["field.mirror.apply"]()}
          </Button>
        </Stack>

        {fieldOpError !== null
          ? <WarningBubble severity="warning" message={fieldOpErrorMessage(fieldOpError)} />
          : hint !== null && <WarningBubble severity="info" message={hint} />}
      </Stack>
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  sectionLabel: sharedStyles.sectionHeader,
  nestedContent: { paddingLeft: indent.tree, minWidth: 0, boxSizing: "border-box", width: "100%" },
};
