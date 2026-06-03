#!/usr/bin/env bun
/**
 * Service entrypoint. One binary, three roles: each service sets AGENT_ROLE and
 * runs the matching service's poll loop. There is no shared state — every
 * service lists open PRs and derives what to do from each PR's artifacts.
 */

import { sdkRunner } from "./agent/runner";
import { loadConfig, type RuntimeConfig } from "./config";
import { OctokitGitHubClient } from "./github/pr-octokit";
import type { GitHubClient } from "./github/pr-client";
import { createLogger, type Logger } from "./logger";
import { runLoop, type Cycle } from "./runtime/loop";
import { GitWorkspace } from "./runtime/workspace";
import { ImplementerService } from "./services/implementer";
import { PlannerService } from "./services/planner";
import { ReviewerService } from "./services/reviewer";

const buildCycle = (cfg: RuntimeConfig, gh: GitHubClient, log: Logger): Cycle => {
  const cloneUrl = `https://x-access-token:${cfg.githubToken}@github.com/${cfg.repo.owner}/${cfg.repo.repo}.git`;
  switch (cfg.role) {
    case "planner": {
      const workspace = new GitWorkspace({ cloneUrl });
      const agent = new PlannerService(gh, sdkRunner, workspace, cfg.model, log);
      return () => agent.runOnce();
    }
    case "implementer": {
      const workspace = new GitWorkspace({ cloneUrl });
      const agent = new ImplementerService(gh, sdkRunner, workspace, cfg.model, log);
      return () => agent.runOnce();
    }
    case "reviewer": {
      const agent = new ReviewerService(gh, sdkRunner, cfg.model, log);
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
