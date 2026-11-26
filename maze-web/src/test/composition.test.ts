import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { defaultCompositionState, compositionTransientUi } from "../store/slices/compositionSlice";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import { Container } from "pixi.js";
import { ELEMENT_TYPES, TEST_TEXT_TYPE, compositionShowsMaze } from "../composition/elementTypes";
import { CompositionLayer } from "../pixi/imageExport/CompositionLayer";
import { makeState } from "./projectExportKit";

const store = () => useMazeStore.getState();
const elements = () => store().compositions.find((c) => c.id === store().activeCompositionId)!.elements;
const PLACEHOLDER = TEST_TEXT_TYPE.id;
const MAZE_TYPE_ID = "test_maze";

// The real display needs an installed MSDF font; the layer's ordering is what is under test here.
vi.mock("../pixi/imageExport/compositionElementDisplays", async () => {
  const { Container: PixiContainer } = await import("pixi.js");
  const display = (data: unknown) => Object.assign(new PixiContainer(), { label: (data as { text: string }).text });
  return { COMPOSITION_ELEMENT_DISPLAYS: { test_text: display } };
});

describe("composition slice (GitHub issue #1099)", () => {
  beforeEach(() => {
    useMazeStore.setState({ ...defaultCompositionState(), ...compositionTransientUi });
  });

  it("starts with one empty composition", () => {
    expect(store().compositions).toHaveLength(1);
    expect(elements()).toEqual([]);
  });

  it("adds elements on top with unique ids and selects the new one", () => {
    store().addCompositionElement(PLACEHOLDER);
    store().addCompositionElement(PLACEHOLDER);
    const list = elements();
    expect(list.map((e) => e.id)).toEqual(["element_1", "element_2"]);
    expect(new Set(list.map((e) => e.name)).size).toBe(2);
    expect(store().selectedCompositionElementId).toBe("element_2");
  });

  it("ignores an unregistered element type", () => {
    store().addCompositionElement("nope");
    expect(elements()).toEqual([]);
  });

  it("reorders within the z-order and clamps", () => {
    for (let i = 0; i < 3; i++) store().addCompositionElement(PLACEHOLDER);
    store().moveCompositionElement("element_1", 2);
    expect(elements().map((e) => e.id)).toEqual(["element_2", "element_3", "element_1"]);
    store().moveCompositionElement("element_1", 99);
    expect(elements().map((e) => e.id)).toEqual(["element_2", "element_3", "element_1"]);
    store().moveCompositionElement("element_1", -5);
    expect(elements().map((e) => e.id)).toEqual(["element_1", "element_2", "element_3"]);
  });

  it("renames with trimming and rejects a blank name", () => {
    store().addCompositionElement(PLACEHOLDER);
    store().renameCompositionElement("element_1", "  Title  ");
    expect(elements()[0].name).toBe("Title");
    store().renameCompositionElement("element_1", "   ");
    expect(elements()[0].name).toBe("Title");
  });

  it("keeps the composition object when a patch changes nothing", () => {
    store().addCompositionElement(PLACEHOLDER);
    const before = store().compositions;
    store().setCompositionElementVisible("element_1", true);
    store().setCompositionElementLocked("element_1", false);
    store().setCompositionElementVisible("missing", false);
    expect(store().compositions).toBe(before);
  });

  it("toggles visibility and lock", () => {
    store().addCompositionElement(PLACEHOLDER);
    store().setCompositionElementVisible("element_1", false);
    store().setCompositionElementLocked("element_1", true);
    expect(elements()[0]).toMatchObject({ visible: false, locked: true });
  });

  it("protects a locked element from removal, rename and moving", () => {
    for (let i = 0; i < 2; i++) store().addCompositionElement(PLACEHOLDER);
    store().setCompositionElementLocked("element_1", true);
    store().removeCompositionElement("element_1");
    store().renameCompositionElement("element_1", "X");
    store().moveCompositionElement("element_1", 1);
    expect(elements().map((e) => e.id)).toEqual(["element_1", "element_2"]);
    expect(elements()[0].name).not.toBe("X");
  });

  it("removes an element, clears its selection and never reuses its id", () => {
    store().addCompositionElement(PLACEHOLDER);
    store().removeCompositionElement("element_1");
    expect(elements()).toEqual([]);
    expect(store().selectedCompositionElementId).toBeNull();
    store().addCompositionElement(PLACEHOLDER);
    expect(elements()[0].id).toBe("element_2");
  });
});

describe("composition layer on the main canvas", () => {
  const colorsOf = (layer: Container) => layer.children[0].children.map((c) => (c as Container).label);

  it("shows visible elements of the active composition in z-order and follows the store", () => {
    useMazeStore.setState({ ...defaultCompositionState(), ...compositionTransientUi });
    const parent = new Container();
    const layer = new CompositionLayer(parent);
    for (let i = 0; i < 3; i++) store().addCompositionElement(TEST_TEXT_TYPE.id);
    store().setCompositionElementVisible("element_2", false);
    expect(colorsOf(parent)).toEqual(["Text 1", "Text 3"]);
    store().moveCompositionElement("element_1", 2);
    expect(colorsOf(parent)).toEqual(["Text 3", "Text 1"]);
    store().removeCompositionElement("element_3");
    expect(colorsOf(parent)).toEqual(["Text 1"]);
    layer.destroy();
  });

  it("reuses an element's display across a rename, a lock and a reorder, and rebuilds it when its data changes", () => {
    useMazeStore.setState({ ...defaultCompositionState(), ...compositionTransientUi });
    const parent = new Container();
    const layer = new CompositionLayer(parent);
    for (let i = 0; i < 2; i++) store().addCompositionElement(PLACEHOLDER);
    const displays = () => [...parent.children[0].children];
    const [bottom, top] = displays();

    store().renameCompositionElement("element_1", "Renamed");
    store().setCompositionElementLocked("element_2", true);
    expect(displays()).toEqual([bottom, top]);

    store().moveCompositionElement("element_1", 1);
    expect(displays()).toEqual([top, bottom]);
    expect(bottom.destroyed).toBe(false);

    const element = store().compositions[0].elements.find((e) => e.id === "element_1")!;
    useMazeStore.setState({
      compositions: [{ ...store().compositions[0], elements: store().compositions[0].elements.map((e) => (e === element ? { ...e, data: { ...(e.data as object) } } : e)) }],
    });
    expect(bottom.destroyed).toBe(true);
    expect(top.destroyed).toBe(false);
    layer.destroy();
  });

  it("destroys the display of a hidden element and rebuilds it when shown again", () => {
    useMazeStore.setState({ ...defaultCompositionState(), ...compositionTransientUi });
    const parent = new Container();
    const layer = new CompositionLayer(parent);
    store().addCompositionElement(PLACEHOLDER);
    const [first] = parent.children[0].children;
    store().setCompositionElementVisible("element_1", false);
    expect(first.destroyed).toBe(true);
    store().setCompositionElementVisible("element_1", true);
    expect(parent.children[0].children).toHaveLength(1);
    layer.destroy();
  });

  it("stops following the store once destroyed", () => {
    useMazeStore.setState({ ...defaultCompositionState(), ...compositionTransientUi });
    const parent = new Container();
    const layer = new CompositionLayer(parent);
    layer.destroy();
    expect(() => store().addCompositionElement(TEST_TEXT_TYPE.id)).not.toThrow();
  });

  it("has a display factory and a unique id for every registered element type", async () => {
    const { COMPOSITION_ELEMENT_DISPLAYS } = await vi.importActual<typeof import("../pixi/imageExport/compositionElementDisplays")>("../pixi/imageExport/compositionElementDisplays");
    const ids = ELEMENT_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(COMPOSITION_ELEMENT_DISPLAYS[id]).toBeTypeOf("function");
  });
});

describe("maze picture on the composition canvas", () => {
  it("is shown only with a visible element of a maze-rendering type", () => {
    const element = (type: string, visible = true) => ({ id: "e", type, name: "E", visible, locked: false, data: {} });
    const stateWith = (...elements: ReturnType<typeof element>[]) => ({
      compositions: [{ id: "c", name: "C", elements }],
      activeCompositionId: "c",
    });
    expect(compositionShowsMaze(stateWith())).toBe(false);
    expect(compositionShowsMaze(stateWith(element(PLACEHOLDER)))).toBe(false);
    expect(compositionShowsMaze(stateWith(element(MAZE_TYPE_ID)))).toBe(false);
    const mazeType = { ...TEST_TEXT_TYPE, id: MAZE_TYPE_ID, rendersMaze: true };
    const resolve = (id: string) => (id === MAZE_TYPE_ID ? mazeType : null);
    expect(compositionShowsMaze(stateWith(element(MAZE_TYPE_ID)), resolve)).toBe(true);
    expect(compositionShowsMaze(stateWith(element(MAZE_TYPE_ID, false)), resolve)).toBe(false);
  });
});

describe("composition in the project file", () => {
  it("round-trips compositions, their order and counters", () => {
    let state = makeState();
    useMazeStore.setState({ ...defaultCompositionState() });
    store().addCompositionElement(PLACEHOLDER);
    store().addCompositionElement(PLACEHOLDER);
    store().setCompositionElementVisible("element_1", false);
    store().moveCompositionElement("element_1", 1);
    const { compositions, activeCompositionId, nextCompositionNumber, nextElementNumber } = store();
    state = makeState({ compositions, activeCompositionId, nextCompositionNumber, nextElementNumber });
    const file = parseAndValidate(JSON.parse(JSON.stringify(serializeProject(state))));
    expect(file.compositions).toEqual({ compositions, activeCompositionId, nextCompositionNumber, nextElementNumber });
  });

  function savedSection() {
    return JSON.parse(JSON.stringify(serializeProject(makeState())));
  }

  it("rejects a file without the compositions section", () => {
    const json = savedSection();
    delete json.compositions;
    expect(() => parseAndValidate(json)).toThrow(/compositions/);
  });

  it("rejects a file saved before the section existed", () => {
    const json = savedSection();
    json.version = 6;
    expect(() => parseAndValidate(json)).toThrow(/No migration for version 6/);
  });

  it("rejects no compositions, an unknown active id, an unknown element type and duplicate ids", () => {
    const withMutation = (mutate: (section: any) => void) => {
      const json = savedSection();
      mutate(json.compositions);
      return () => parseAndValidate(json);
    };
    expect(withMutation((s) => { s.compositions = []; })).toThrow(/at least one composition/);
    expect(withMutation((s) => { s.activeCompositionId = "missing"; })).toThrow(/activeCompositionId/);
    const element = { id: "e", type: PLACEHOLDER, name: "E", visible: true, locked: false, data: { x: 0, y: 0, text: "T", fontSize: 10, color: "#000000" } };
    expect(withMutation((s) => { s.compositions[0].elements = [{ ...element, type: "mystery" }]; })).toThrow(/unknown composition element type "mystery"/);
    expect(withMutation((s) => { s.compositions[0].elements = [element, element]; })).toThrow(/Duplicate composition element id/);
    expect(withMutation((s) => { s.compositions[0].elements = [{ ...element, data: { ...element.data, color: "red" } }]; })).toThrow(/color/);
  });

  it("loads the saved compositions and resets the transient selection", async () => {
    useMazeStore.setState({ ...defaultCompositionState() });
    store().addCompositionElement(PLACEHOLDER);
    const saved = serializeProject(makeState({ ...store() }));
    useMazeStore.setState({ ...defaultCompositionState(), ...compositionTransientUi, compositionPanelOpen: true, selectedCompositionElementId: "stale" });
    await store().loadProject(parseAndValidate(JSON.parse(JSON.stringify(saved))));
    expect(elements().map((e) => e.id)).toEqual(["element_1"]);
    expect(store().compositionPanelOpen).toBe(false);
    expect(store().selectedCompositionElementId).toBeNull();
  });
});
