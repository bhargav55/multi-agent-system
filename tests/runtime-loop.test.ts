import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";
import { runLoop } from "../src/runtime/loop";

const silent = createLogger({}, { out: () => {}, err: () => {} });

describe("runLoop", () => {
  it("runs cycles until aborted", async () => {
    const controller = new AbortController();
    let runs = 0;
    await runLoop(
      async () => {
        runs += 1;
        if (runs >= 3) controller.abort();
      },
      1,
      silent,
      controller.signal,
    );
    expect(runs).toBe(3);
  });

  it("keeps polling after a cycle throws", async () => {
    const controller = new AbortController();
    let runs = 0;
    await runLoop(
      async () => {
        runs += 1;
        if (runs === 1) throw new Error("transient");
        if (runs >= 2) controller.abort();
      },
      1,
      silent,
      controller.signal,
    );
    expect(runs).toBe(2);
  });

  it("does not run a cycle if already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let runs = 0;
    await runLoop(async () => void (runs += 1), 1, silent, controller.signal);
    expect(runs).toBe(0);
  });
});
