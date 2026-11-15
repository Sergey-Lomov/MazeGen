import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RemoveUploadedFontsDialog } from "../components/dialogs/RemoveUploadedFontsDialog";
import * as m from "~/paraglide/messages";

afterEach(cleanup);

function open(used: string[] = []) {
  const onDelete = vi.fn();
  const onClose = vi.fn();
  render(<RemoveUploadedFontsDialog families={["Alpha", "Beta"]} usedFamilies={new Set(used)} onDelete={onDelete} onClose={onClose} />);
  return { onDelete, onClose };
}

const choose = (family: string) => fireEvent.click(screen.getByRole("checkbox", { name: family }));
const confirmButton = () => screen.getByTestId("font-remove-confirm");

describe("RemoveUploadedFontsDialog (GitHub issue #985)", () => {
  it("lists every uploaded font and marks those used in the project", () => {
    open(["Beta"]);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getAllByTestId("font-remove-used")).toHaveLength(1);
  });

  it("keeps Delete disabled until a font is chosen", () => {
    open();
    expect(confirmButton()).toBeDisabled();
    choose("Alpha");
    expect(confirmButton()).not.toBeDisabled();
  });

  it("deletes the chosen fonts at once, without a confirmation, when none is used in the project", () => {
    const { onDelete, onClose } = open(["Beta"]);
    choose("Alpha");
    fireEvent.click(confirmButton());
    expect(onDelete).toHaveBeenCalledWith(["Alpha"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("asks once more when a chosen font is used in the project, and deletes only after it is confirmed", () => {
    const { onDelete } = open(["Beta"]);
    choose("Alpha");
    choose("Beta");
    fireEvent.click(confirmButton());
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(m["font_remove.used_message"]())).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: m["common.ok"]() }));
    expect(onDelete).toHaveBeenCalledWith(["Alpha", "Beta"]);
  });

  it("deletes nothing when the extra confirmation is cancelled", () => {
    const { onDelete } = open(["Beta"]);
    choose("Beta");
    fireEvent.click(confirmButton());
    const cancels = screen.getAllByRole("button", { name: m["common.cancel"]() });
    fireEvent.click(cancels[cancels.length - 1]);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText(m["font_remove.used_message"]())).toBeNull();
  });
});
