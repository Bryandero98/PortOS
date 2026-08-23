import { afterEach, describe, expect, it, vi } from "vitest";

import { runSteps } from "./googleOAuthAutoConfig.js";

describe("runSteps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs named steps in order and logs their progress", async () => {
    const calls = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runSteps([
      { name: "first", run: async () => calls.push("first") },
      { name: "second", run: async () => calls.push("second") },
    ]);

    expect(calls).toEqual(["first", "second"]);
    expect(log).toHaveBeenNthCalledWith(
      1,
      "📅 Auto-config step started: first",
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      "📅 Auto-config step completed: first",
    );
    expect(log).toHaveBeenNthCalledWith(
      3,
      "📅 Auto-config step started: second",
    );
    expect(log).toHaveBeenNthCalledWith(
      4,
      "📅 Auto-config step completed: second",
    );
  });

  it("fails fast without running later steps", async () => {
    const failure = new Error("step failed");
    const laterStep = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runSteps([
        {
          name: "failure",
          run: async () => {
            throw failure;
          },
        },
        { name: "later", run: laterStep },
      ]),
    ).rejects.toThrow(failure);

    expect(laterStep).not.toHaveBeenCalled();
  });
});
