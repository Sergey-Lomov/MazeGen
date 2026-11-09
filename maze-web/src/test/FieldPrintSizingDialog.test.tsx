import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FieldPrintSizingDialog } from "../components/dialogs/FieldPrintSizingDialog";
import { useMazeStore } from "../store/mazeStore";
import type { PredefinedFieldConfig } from "../pixi/fieldPrintSizing";
import { computePrintSizing, type PrintSizingAnswer, type PrintSizingRequest } from "../pixi/printSizingJob";
import { baseStoreState } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";
import * as m from "~/paraglide/messages";

interface FakeJob {
  request: PrintSizingRequest;
  resolve(answer?: PrintSizingAnswer): void;
  reject(error: Error): void;
  cancel: ReturnType<typeof vi.fn>;
}

const jobs = vi.hoisted(() => [] as unknown[]);
const started = jobs as FakeJob[];

vi.mock("../wasm/workerClients", () => ({
  startPrintSizing: (request: PrintSizingRequest) => {
    let resolve!: (answer: PrintSizingAnswer) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PrintSizingAnswer>((res, rej) => { resolve = res; reject = rej; });
    const job: FakeJob = {
      request,
      resolve: (answer) => resolve(answer ?? computePrintSizing(request)),
      reject,
      cancel: vi.fn((reason: Error) => reject(reason)),
    };
    jobs.push(job);
    return { promise, cancel: job.cancel };
  },
}));

const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) as PredefinedFieldConfig;

function renderDialog(onApply = vi.fn(), onClose = vi.fn()) {
  const view = render(<FieldPrintSizingDialog config={config} hasMultipleFloors={false} onApply={onApply} onClose={onClose} />);
  return { ...view, onApply, onClose };
}

function cellSizeInput(): HTMLInputElement {
  return document.querySelector('input[name="cell-size"]') as HTMLInputElement;
}

beforeEach(() => {
  started.length = 0;
  useMazeStore.setState({ ...baseStoreState() });
});

describe("FieldPrintSizingDialog worker calculation", () => {
  it("shows a progress indicator only after the delay and holds it, then fills in", async () => {
    renderDialog();

    expect(started).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: m["common.confirm"]() })).toBeDisabled();
    expect(await screen.findByRole("progressbar", { name: m["field.print_sizing.calculating"]() })).toBeInTheDocument();

    await act(async () => started[0].resolve());

    // Held for its minimum duration, so still there right after the answer.
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByRole("button", { name: m["common.confirm"]() })).not.toBeDisabled();
  });

  it("shows no progress indicator for a calculation that ends at once", async () => {
    renderDialog();

    await act(async () => started[0].resolve());

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: m["common.confirm"]() })).not.toBeDisabled();
  });

  it("cancels the running calculation and starts a new one when a parameter changes", async () => {
    renderDialog();

    fireEvent.change(cellSizeInput(), { target: { value: "12" } });
    fireEvent.blur(cellSizeInput());

    await waitFor(() => expect(started).toHaveLength(2));
    expect(started[0].cancel).toHaveBeenCalledTimes(1);
    expect(started[1].cancel).not.toHaveBeenCalled();
    expect(started[1].request.input.cellSizeMm).toBe(12);
  });

  it("does not show the result of a superseded calculation", async () => {
    renderDialog();
    fireEvent.change(cellSizeInput(), { target: { value: "12" } });
    fireEvent.blur(cellSizeInput());
    await waitFor(() => expect(started).toHaveLength(2));

    await screen.findByRole("progressbar");
    await act(async () => started[0].resolve());
    expect(screen.getByRole("button", { name: m["common.confirm"]() })).toBeDisabled();

    await act(async () => started[1].resolve());
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByRole("button", { name: m["common.confirm"]() })).not.toBeDisabled();
  });

  it("keeps the previous results on screen, unconfirmable, while a new calculation is quick", async () => {
    renderDialog();
    await act(async () => started[0].resolve());
    expect(screen.getByText(/Field size:/)).toBeInTheDocument();

    fireEvent.change(cellSizeInput(), { target: { value: "12" } });
    fireEvent.blur(cellSizeInput());
    await waitFor(() => expect(started).toHaveLength(2));

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/Field size:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m["common.confirm"]() })).toBeDisabled();
  });

  it("cancels the running calculation when the dialog closes", () => {
    const { unmount } = renderDialog();

    unmount();

    expect(started[0].cancel).toHaveBeenCalledTimes(1);
  });

  it("explains a failed calculation", async () => {
    renderDialog();

    await act(async () => started[0].reject(new Error("worker crashed")));

    expect(screen.getByText(m["field.print_sizing.failed"]({ reason: "worker crashed" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m["common.confirm"]() })).toBeDisabled();
  });

  it("explains why no size was found", async () => {
    renderDialog();
    fireEvent.change(cellSizeInput(), { target: { value: "500" } });
    fireEvent.blur(cellSizeInput());
    await waitFor(() => expect(started).toHaveLength(2));

    await act(async () => started[1].resolve());

    expect(screen.getByText(m["field.print_sizing.invalid"]())).toBeInTheDocument();
  });

  it("warns when the result sits on the search limit", async () => {
    renderDialog();
    const answer = computePrintSizing(started[0].request);

    await act(async () => started[0].resolve({ ...answer, result: { ...answer.result!, limit: 1000 } }));

    expect(screen.getByText(m["field.print_sizing.limit_reached"]({ limit: "1000" }))).toBeInTheDocument();
  });

  it("applies once when confirmed twice while a typed size is calculated", async () => {
    const { onApply, onClose } = renderDialog();
    await act(async () => started[0].resolve());

    fireEvent.change(cellSizeInput(), { target: { value: "12" } });
    const confirm = screen.getByRole("button", { name: m["common.confirm"]() });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(started.length).toBeGreaterThanOrEqual(2));
    const applyJobs = started.filter((job) => job.request.input.cellSizeMm === 12 && !job.cancel.mock.calls.length);
    await act(async () => applyJobs.forEach((job) => job.resolve()));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][1].cellSizeMm).toBe(12);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
