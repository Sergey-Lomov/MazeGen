import { describe, it, expect, vi } from "vitest";
import { WorkerPool } from "../wasm/workerPool";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: { id: number; payload: number; transfer: Transferable[] }[] = [];
  terminate = vi.fn();

  postMessage(value: { id: number; payload: number }, transfer: Transferable[]) {
    this.sent.push({ ...value, transfer });
  }

  answer(index: number, body: object) {
    this.onmessage?.({ data: { id: this.sent[index].id, ...body } } as MessageEvent);
  }
}

function makePool(maxIdle?: number) {
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool<number, string>({
    create: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    maxIdle,
  });
  return { pool, workers };
}

describe("WorkerPool", () => {
  it("reuses an idle worker for sequential requests", async () => {
    const { pool, workers } = makePool();
    const first = pool.run(1).promise;
    workers[0].answer(0, { result: "a" });
    await expect(first).resolves.toBe("a");
    const second = pool.run(2).promise;
    workers[0].answer(1, { result: "b" });
    await expect(second).resolves.toBe("b");

    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).not.toHaveBeenCalled();
  });

  it("gives concurrent requests separate workers and drops extras beyond maxIdle", async () => {
    const { pool, workers } = makePool(1);
    const a = pool.run(1).promise;
    const b = pool.run(2).promise;
    expect(workers).toHaveLength(2);
    workers[0].answer(0, { result: "a" });
    workers[1].answer(0, { result: "b" });
    await Promise.all([a, b]);

    expect(pool.size).toBe(1);
    expect(workers[1].terminate).toHaveBeenCalledTimes(1);
  });

  it("forwards transferables", () => {
    const { pool, workers } = makePool();
    const buffer = new ArrayBuffer(4);
    void pool.run(1, [buffer]);
    expect(workers[0].sent[0].transfer).toEqual([buffer]);
  });

  it("ignores a response with a foreign id", async () => {
    const { pool, workers } = makePool();
    const job = pool.run(1).promise;
    workers[0].onmessage?.({ data: { id: 999, result: "stale" } } as MessageEvent);
    workers[0].answer(0, { result: "ok" });
    await expect(job).resolves.toBe("ok");
  });

  it("cancel rejects the job and terminates its worker", async () => {
    const { pool, workers } = makePool();
    const job = pool.run(1);
    job.cancel(new Error("cancelled"));
    await expect(job.promise).rejects.toThrow("cancelled");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);

    void pool.run(2);
    expect(workers).toHaveLength(2);
  });

  it("cancel after settle is a no-op", async () => {
    const { pool, workers } = makePool();
    const job = pool.run(1);
    workers[0].answer(0, { result: "a" });
    await job.promise;
    job.cancel(new Error("late"));
    expect(workers[0].terminate).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
  });

  it("retires the worker after an error response or runtime error", async () => {
    const { pool, workers } = makePool();
    const failed = pool.run(1).promise;
    workers[0].answer(0, { error: "boom" });
    await expect(failed).rejects.toThrow("boom");
    const crashed = pool.run(2).promise;
    workers[1].onerror?.({ message: "crash" } as ErrorEvent);
    await expect(crashed).rejects.toThrow("crash");

    expect(workers.map((w) => w.terminate.mock.calls.length)).toEqual([1, 1]);
    expect(pool.size).toBe(0);
  });

  it("drops an idle worker that crashes so the next request gets a fresh one", async () => {
    const { pool, workers } = makePool();
    const first = pool.run(1).promise;
    workers[0].answer(0, { result: "a" });
    await first;
    workers[0].onerror?.({ message: "idle crash" } as ErrorEvent);

    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
    const second = pool.run(2).promise;
    expect(workers).toHaveLength(2);
    workers[1].answer(0, { result: "b" });
    await expect(second).resolves.toBe("b");
  });

  it("dispose rejects running jobs, terminates all workers and the pool stays usable", async () => {
    const { pool, workers } = makePool(2);
    const idle = pool.run(1).promise;
    const running = pool.run(2).promise;
    workers[0].answer(0, { result: "a" });
    await idle;
    pool.dispose();

    await expect(running).rejects.toThrow("Worker pool disposed");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[1].terminate).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
    void pool.run(3);
    expect(workers).toHaveLength(3);
  });
});
