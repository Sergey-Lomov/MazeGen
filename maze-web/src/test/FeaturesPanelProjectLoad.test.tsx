import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { FeaturesPanel } from "../components/FeaturesPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { serializeProject, serializeQualityPreset, serializeVisualPreset } from "../store/projectExport";
import { resetNotifications } from "../notifications/notificationStore";
import { errorCards, errorDetails } from "./notificationTestHelpers";

vi.mock("../components/features/ToolGlyph", () => ({ ToolGlyph: () => null }));
vi.mock("../wasm/mazeService", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/mazeService")>()),
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

const loadProject = vi.fn();

beforeEach(() => {
  resetNotifications();
  loadProject.mockReset();
  useMazeStore.setState({ ...baseStoreState(), loadProject });
});

function pickProjectFile(content: string, container: HTMLElement) {
  const input = container.querySelector('input[name="project-file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([content], "project.maze")] } });
}

function renderPanel() {
  return render(<FeaturesPanel onRefit={() => {}} onExportPng={() => Promise.resolve(null)} />);
}

// GitHub issue #769: project load failures are error toasts, and a rejected file never reaches
// `loadProject`, so the store stays untouched.
describe("FeaturesPanel project load", () => {
  it("loads a valid project file without a toast", async () => {
    const { container } = renderPanel();
    pickProjectFile(JSON.stringify(serializeProject(useMazeStore.getState())), container);
    await waitFor(() => expect(loadProject).toHaveBeenCalledTimes(1));
    expect(errorCards()).toEqual([]);
  });

  it("raises a dedicated error toast for a quality preset", async () => {
    const { container } = renderPanel();
    pickProjectFile(JSON.stringify(serializeQualityPreset(useMazeStore.getState())), container);
    await waitFor(() => expect(errorCards()).toEqual(["project_load/project.load_error_quality_preset"]));
    expect(loadProject).not.toHaveBeenCalled();
  });

  it("raises a dedicated error toast for a style preset", async () => {
    const { container } = renderPanel();
    pickProjectFile(JSON.stringify(serializeVisualPreset(useMazeStore.getState())), container);
    await waitFor(() => expect(errorCards()).toEqual(["project_load/project.load_error_visual_preset"]));
    expect(loadProject).not.toHaveBeenCalled();
  });

  it("raises an error toast with details for a malformed project", async () => {
    const { container } = renderPanel();
    pickProjectFile(JSON.stringify({ ...serializeProject(useMazeStore.getState()), version: 999_999 }), container);
    await waitFor(() => expect(errorCards()).toEqual(["project_load/project.load_error"]));
    expect(errorDetails("project.load_error")).toBeTruthy();
    expect(loadProject).not.toHaveBeenCalled();
  });

  it("rejects an unknown tessellation kind with an error toast", async () => {
    const { container } = renderPanel();
    const project = serializeProject(useMazeStore.getState());
    project.tessellation.kind = "octagonal" as never;
    pickProjectFile(JSON.stringify(project), container);

    await waitFor(() => expect(errorCards()).toEqual(["project_load/project.load_error"]));
    expect(errorDetails("project.load_error")).toContain("tessellation.kind");
    expect(loadProject).not.toHaveBeenCalled();
  });

  it("raises an error toast for a file that is not JSON", async () => {
    const { container } = renderPanel();
    pickProjectFile("{not json", container);
    await waitFor(() => expect(errorCards()).toEqual(["project_load/file_load.invalid_json"]));
    expect(loadProject).not.toHaveBeenCalled();
  });
});
