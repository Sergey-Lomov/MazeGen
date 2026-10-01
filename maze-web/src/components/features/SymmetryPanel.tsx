import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { symmetryStatus } from "../../pixi/symmetry";
import { Button } from "../Button";
import { SidePanel } from "../SidePanel";
import { Inline, Stack } from "../Layout";
import { indent, muted, spacing, typography } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import * as m from "~/paraglide/messages";

export function SymmetryPanel() {
  const symmetryOperation = useMazeStore((s) => s.symmetryOperation);
  const symmetrySnapMode = useMazeStore((s) => s.symmetrySnapMode);
  const symmetryScope = useMazeStore((s) => s.symmetryScope);
  const symmetryAxisPoints = useMazeStore((s) => s.symmetryAxisPoints);
  const symmetrySourceSide = useMazeStore((s) => s.symmetrySourceSide);
  const symmetryPolygon = useMazeStore((s) => s.symmetryPolygon);
  const symmetryPolygonFinished = useMazeStore((s) => s.symmetryPolygonFinished);
  const setFieldPrimitive = useMazeStore((s) => s.setFieldPrimitive);
  const setSymmetryOperation = useMazeStore((s) => s.setSymmetryOperation);
  const setSymmetrySnapMode = useMazeStore((s) => s.setSymmetrySnapMode);
  const setSymmetryScope = useMazeStore((s) => s.setSymmetryScope);
  const setSymmetrySourceSide = useMazeStore((s) => s.setSymmetrySourceSide);
  const finishSymmetryPolygon = useMazeStore((s) => s.finishSymmetryPolygon);
  const resetSymmetryPolygon = useMazeStore((s) => s.resetSymmetryPolygon);
  const resetSymmetryAxis = useMazeStore((s) => s.resetSymmetryAxis);
  const applySymmetry = useMazeStore((s) => s.applySymmetry);

  const status = symmetryStatus({
    axisPoints: symmetryAxisPoints,
    scope: symmetryScope,
    polygon: symmetryPolygon,
    polygonFinished: symmetryPolygonFinished,
  });

  function closePanel() {
    resetSymmetryAxis();
    setFieldPrimitive("point");
  }

  const statusMessage = status === "axis"
    ? m["field.symmetry.status.axis"]()
    : status === "polygon"
      ? symmetryPolygon.length >= 3 && !symmetryPolygonFinished
        ? m["field.symmetry.status.finish_polygon"]()
        : m["field.symmetry.status.polygon"]()
      : m["field.symmetry.status.ready"]();

  return (
    <SidePanel title={m["field.symmetry.tool"]()} onClose={closePanel}>
      <Stack gap="groupGap" style={styles.body}>
        <Stack gap="itemGap">
          <div style={styles.sectionLabel}>{m["field.symmetry.operation"]()}</div>
          <Inline gap="itemGap" style={styles.nestedContent}>
            <Button
              variant={symmetryOperation === "add" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setSymmetryOperation("add")}
            >
              {m["field.symmetry.add"]()}
            </Button>
            <Button
              variant={symmetryOperation === "subtract" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setSymmetryOperation("subtract")}
            >
              {m["field.symmetry.subtract"]()}
            </Button>
          </Inline>
        </Stack>

        <Stack gap="itemGap">
          <div style={styles.sectionLabel}>{m["field.symmetry.snap"]()}</div>
          <Inline gap="itemGap" style={styles.nestedContent}>
            <Button
              variant={symmetrySnapMode === "centers" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setSymmetrySnapMode("centers")}
            >
              {m["field.symmetry.centers"]()}
            </Button>
            <Button
              variant={symmetrySnapMode === "corners" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setSymmetrySnapMode("corners")}
            >
              {m["field.symmetry.corners"]()}
            </Button>
            <Button
              variant={symmetrySnapMode === "free" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setSymmetrySnapMode("free")}
            >
              {m["field.symmetry.free"]()}
            </Button>
          </Inline>
        </Stack>

        <Stack gap="itemGap">
          <div style={styles.sectionLabel}>{m["field.symmetry.scope"]()}</div>
          <Inline gap="itemGap" style={styles.nestedContent}>
            <Button
              variant={symmetryScope === "everything" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setSymmetryScope("everything")}
            >
              {m["field.symmetry.everything"]()}
            </Button>
            <Button
              variant={symmetryScope === "one_side" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setSymmetryScope("one_side")}
            >
              {m["field.symmetry.one_side"]()}
            </Button>
            <Button
              variant={symmetryScope === "polygon" ? "toggle-selected" : "toggle"}
              layoutStyle={{ flex: 1 }}
              onClick={() => setSymmetryScope("polygon")}
            >
              {m["field.symmetry.polygon"]()}
            </Button>
          </Inline>
        </Stack>

        <Stack gap="itemGap">
          {symmetryScope === "one_side" && symmetryAxisPoints.length === 2 && (
            <Button variant="secondary" onClick={() => setSymmetrySourceSide(symmetrySourceSide === 1 ? -1 : 1)}>
              {m["field.symmetry.change_direction"]()}
            </Button>
          )}
          {symmetryAxisPoints.length > 0 && (
            <Button variant="secondary" onClick={resetSymmetryAxis}>
              {m["field.symmetry.reset_axis"]()}
            </Button>
          )}
          {symmetryScope === "polygon" && symmetryPolygon.length > 0 && (
            <>
              {!symmetryPolygonFinished && symmetryPolygon.length >= 3 && (
                <Button variant="secondary" onClick={finishSymmetryPolygon}>
                  {m["field.symmetry.finish_polygon"]()}
                </Button>
              )}
              <Button variant="secondary" onClick={resetSymmetryPolygon}>
                {m["field.symmetry.reset_polygon"]()}
              </Button>
            </>
          )}
        </Stack>

        <div>
          <div style={styles.infoText}>{statusMessage}</div>
          <Button
            variant="primary"
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            disabled={status !== "ready"}
            onClick={applySymmetry}
          >
            {m["field.symmetry.apply"]()}
          </Button>
        </div>
      </Stack>
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { padding: spacing.groupGap },
  sectionLabel: sharedStyles.sectionHeader,
  nestedContent: { paddingLeft: indent.tree, minWidth: 0, boxSizing: "border-box", width: "100%" },
  infoText: { ...typography.body, ...muted(typography.body) },
};
