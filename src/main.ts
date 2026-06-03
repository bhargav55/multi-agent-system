#!/usr/bin/env bun
/**
 * Service entrypoint. One binary, three roles (decision 4): each Railway service
 * sets AGENT_ROLE and runs the matching agent's poll loop. Coordination is via
 * GitHub status only — services share no state and never talk to each other.
 */

import { sdkRunner } from "./agent/runner";
import { loadConfig, type RuntimeConfig } from "./config";
import { OctokitGitHubClient } from "./github/octokit-client";
import { createLogger, type Logger } from "./logger";
import type { GitHubClient } from "./github/client";
import { ImplementerAgent } from "./runtime/implementer";
import { runLoop, type Cycle } from "./runtime/loop";
import { PlannerAgent } from "./runtime/planner";
import { ReviewerAgent } from "./runtime/reviewer";
import { GitWorkspace } from "./runtime/workspace";

const buildCycle = (cfg: RuntimeConfig, gh: GitHubClient, log: Logger): Cycle => {
  switch (cfg.role) {
    case "planner": {
      const agent = new PlannerAgent(gh, sdkRunner, cfg.model, log);
      return () => agent.runOnce();
    }
    case "implementer": {
      const cloneUrl = `https://x-access-token:${cfg.githubToken}@github.com/${cfg.repo.owner}/${cfg.repo.repo}.git`;
      const workspace = new GitWorkspace({ cloneUrl });
      const agent = new ImplementerAgent(gh, sdkRunner, workspace, cfg.model, log, cfg.base);
      return () => agent.runOnce();
    }
    case "reviewer": {
      const agent = new ReviewerAgent(gh, sdkRunner, cfg.model, log);
      return () => agent.runOnce();
    }
  }
};

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  const log = createLogger({ role: cfg.role, repo: `${cfg.repo.owner}/${cfg.repo.repo}` });
  const gh = new OctokitGitHubClient(cfg.repo, cfg.githubToken, cfg.base);

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());

  const cycle = buildCycle(cfg, gh, log);

  // `--once`: run a single cycle and exit (manual testing, or external cron).
  if (process.argv.includes("--once")) {
    log.info("running one cycle (--once)", { model: cfg.model });
    await cycle();
    log.info("cycle complete; exiting", {});
    return;
  }

  log.info("service starting", { model: cfg.model, pollIntervalMs: cfg.pollIntervalMs });
  await runLoop(cycle, cfg.pollIntervalMs, log, controller.signal);
  log.info("service stopped", {});
};

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "fatal", msg: String(err) }));
  process.exit(1);
});
