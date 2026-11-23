import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileNameModal, timestampedBaseName } from "../components/FileNameModal";
import { resetSavedHandles, saveJsonInPlace } from "../store/projectExport/fileSave";
import * as m from "~/paraglide/messages";

describe("FileNameModal", () => {
  it("keeps the extension outside the editable generated name", () => {
    const onConfirm = vi.fn();
    render(<FileNameModal defaultBaseName="maze-project-18182000" extension=".maze" onConfirm={onConfirm} onCancel={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: m["file_name.label"]() });
    expect(input).toHaveValue("maze-project-18182000");
    expect(screen.getByText(".maze")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "castle" } });
    fireEvent.click(screen.getByRole("button", { name: m["file_name.save"]() }));

    expect(onConfirm).toHaveBeenCalledWith("castle.maze");
  });

  it("disables saving for an empty or whitespace-only base name", () => {
    render(<FileNameModal defaultBaseName="maze-project" extension=".maze" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByRole("textbox", { name: m["file_name.label"]() }), { target: { value: "   " } });

    expect(screen.getByRole("button", { name: m["file_name.save"]() })).toBeDisabled();
  });

  it("uses a wide dialog for longer file names", () => {
    render(<FileNameModal defaultBaseName="maze-style-18080503" extension=".mazestyle" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(m["file_name.title"]()).parentElement?.parentElement).toHaveStyle({ width: "min(460px, calc(100vw - 32px))" });
  });

  it("prefills the last confirmed name for a remember key", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });
    const { unmount } = render(<FileNameModal defaultBaseName="maze-project-111" extension=".maze" rememberKey="test" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: m["file_name.label"]() }), { target: { value: "castle" } });
    fireEvent.click(screen.getByRole("button", { name: m["file_name.save"]() }));
    unmount();

    render(<FileNameModal defaultBaseName="maze-project-222" extension=".maze" rememberKey="test" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: m["file_name.label"]() })).toHaveValue("castle");
    vi.unstubAllGlobals();
  });

  it("offers Save in place and Download as separate actions when the browser supports it", () => {
    vi.stubGlobal("showSaveFilePicker", vi.fn());
    const onConfirm = vi.fn();
    const onSaveInPlace = vi.fn();
    render(<FileNameModal defaultBaseName="castle" extension=".maze" onSaveInPlace={onSaveInPlace} onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: m["file_name.save"]() }));
    expect(onSaveInPlace).toHaveBeenCalledWith("castle.maze");
    fireEvent.click(screen.getByRole("button", { name: m["file_name.download"]() }));
    expect(onConfirm).toHaveBeenCalledWith("castle.maze");
    vi.unstubAllGlobals();
  });

  it("prefills the base name of the file saved in place before the remembered one", async () => {
    const store = new Map<string, string>([["maze:lastFileBaseName:kind1", "remembered"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({
      name: "castle.maze",
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined, abort: async () => undefined }),
    })));
    resetSavedHandles();
    await saveJsonInPlace("kind1", {}, "x.maze", ".maze");

    render(<FileNameModal defaultBaseName="maze-project-1" extension=".maze" rememberKey="kind1" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: m["file_name.label"]() })).toHaveValue("castle");
    resetSavedHandles();
    vi.unstubAllGlobals();
  });

  it("shows a single downloading Save button without in-place support", () => {
    const onConfirm = vi.fn();
    render(<FileNameModal defaultBaseName="castle" extension=".maze" onSaveInPlace={vi.fn()} onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(screen.queryByRole("button", { name: m["file_name.download"]() })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: m["file_name.save"]() }));
    expect(onConfirm).toHaveBeenCalledWith("castle.maze");
  });

  it("builds a compact local timestamp", () => {
    expect(timestampedBaseName("maze-project", new Date(2026, 10, 18, 8, 5, 3))).toBe("maze-project-18080503");
  });
});
