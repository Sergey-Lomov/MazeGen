import { describe, expect, it, vi } from "vitest";
import { beginActivity, endActivity, isActivityRunning, runningActivities, subscribeActivity, trackActivity } from "../activity/backgroundActivity";

describe("backgroundActivity registry (GitHub issue #1004)", () => {
  it("keeps a kind running until every job of it ended, listing distinct sorted labels", () => {
    beginActivity("fonts", "Zeta");
    beginActivity("fonts", "Alpha");
    beginActivity("fonts", "Alpha");
    expect(runningActivities()).toEqual([{ kind: "fonts", labels: ["Alpha", "Zeta"] }]);
    endActivity("fonts", "Alpha");
    expect(runningActivities()[0].labels).toEqual(["Alpha", "Zeta"]);
    endActivity("fonts", "Alpha");
    endActivity("fonts", "Zeta");
    expect(isActivityRunning("fonts")).toBe(false);
    expect(runningActivities()).toEqual([]);
  });

  it("lists kinds in the order they started and leaves an unlabelled job out of the labels", () => {
    beginActivity("analytics");
    beginActivity("fonts");
    expect(runningActivities()).toEqual([{ kind: "analytics", labels: [] }, { kind: "fonts", labels: [] }]);
    endActivity("analytics");
    endActivity("fonts");
  });

  it("hands out the same snapshot until something changes, and notifies on each change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActivity(listener);
    const before = runningActivities();
    expect(runningActivities()).toBe(before);
    beginActivity("analytics");
    expect(runningActivities()).not.toBe(before);
    endActivity("analytics");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    beginActivity("analytics");
    endActivity("analytics");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores an end that matches no job", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActivity(listener);
    endActivity("analytics");
    expect(runningActivities()).toEqual([]);
    beginActivity("analytics");
    endActivity("analytics");
    endActivity("analytics");
    expect(runningActivities()).toEqual([]);
    unsubscribe();
  });

  it("trackActivity ends the job when the promise resolves or rejects, and passes the outcome through", async () => {
    await expect(trackActivity("analytics", Promise.resolve(7))).resolves.toBe(7);
    expect(isActivityRunning("analytics")).toBe(false);
    const failing = trackActivity("analytics", Promise.reject(new Error("boom")));
    expect(isActivityRunning("analytics")).toBe(true);
    await expect(failing).rejects.toThrow("boom");
    expect(isActivityRunning("analytics")).toBe(false);
  });
});
