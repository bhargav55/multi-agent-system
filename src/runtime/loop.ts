/**
 * The polling loop shared by all three services (decision 5). Runs a cycle,
 * then sleeps the poll interval, forever — GitHub status is the queue, so a
 * restart just re-polls. A failing cycle is logged and swallowed so a transient
 * error never kills the service.
 */

import type { Logger } from "../logger";

export type Cycle = () => Promise<unknown>;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const runLoop = async (
  cycle: Cycle,
  intervalMs: number,
  log: Logger,
  signal: AbortSignal,
): Promise<void> => {
  while (!signal.aborted) {
    const start = Date.now();
    try {
      await cycle();
    } catch (err) {
      log.error("cycle failed", { error: String(err) });
    }
    if (signal.aborted) break;
    await sleep(Math.max(0, intervalMs - (Date.now() - start)), signal);
  }
};
