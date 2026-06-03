#!/usr/bin/env bun
/**
 * Local dry-run: exercise a service against a seeded in-memory PR using the REAL
 * Claude Agent SDK — so you can watch a real agent work with no GitHub, no git
 * push, and no infra. Useful to sanity-check SDK auth and output quality.
 *
 * Needs SDK auth in the env (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
 *
 *   bun run scripts/dry-run.ts planner
 *   bun run scripts/dry-run.ts reviewer
 *
 * (The implementer needs a real git remote; use the `--once` live path for it.)
 */

import { sdkRunner } from "../src/agent/runner";
import { MockGitHubClient } from "../src/github/pr-mock";
import { createLogger } from "../src/logger";
import { planPath } from "../src/runtime/derive";
import type { Workspace } from "../src/runtime/workspace";
import { PlannerService } from "../src/services/planner";
import { ReviewerService } from "../src/services/reviewer";

const role = process.argv[2];
const model = process.env.AGENT_MODEL ?? "claude-sonnet-4-6";
const log = createLogger({ role: role ?? "?", mode: "dry-run" });
const gh = new MockGitHubClient();

/** Lets the planner explore THIS repo read-only (no clone, no cleanup). */
const localWorkspace: Workspace = {
  async prepareExisting() {
    return { dir: process.cwd() };
  },
  async runTests() {
    throw new Error("dry-run does not run tests");
  },
  async hasChanges() {
    return false;
  },
  async currentSha() {
    return "dry-run";
  },
  async commitAll() {},
  async push() {},
  async cleanup() {},
};

if (role === "planner") {
  const n = gh.seed({
    headRef: "feature/health",
    body: "Expose an HTTP health-check endpoint that returns service status and the current git SHA as JSON, so uptime monitors can poll it.",
    changedFiles: [{ path: "prds/health.md", status: "added" }],
  });
  await new PlannerService(gh, sdkRunner, localWorkspace, model, log).runOnce();
  const committed = gh.commits.find((c) => c.path === planPath("health"));
  log.info("PR after planning", { labels: gh.get(n).labels });
  if (committed) console.log(`\n${"-".repeat(60)}\n${committed.path} on ${committed.branch}:\n\n${committed.content}\n`);
} else if (role === "reviewer") {
  const n = gh.seed({
    headRef: "feature/health",
    headSha: "head1",
    changedFiles: [
      { path: "prds/health.md", status: "added" },
      { path: planPath("health"), status: "added" },
      { path: "src/health.ts", status: "added" },
    ],
  });
  gh.setDiff(
    n,
    "head1",
    [
      "diff --git a/src/health.ts b/src/health.ts",
      "+export const health = () => ({ status: 'ok' });",
      "// note: no test was added for the 200 response",
    ].join("\n"),
  );
  await new ReviewerService(gh, sdkRunner, model, log).runOnce();
  log.info("PR after review", { labels: gh.get(n).labels });
  const submitted = gh.reviews.find((r) => r.number === n);
  if (submitted) console.log(`\n${"-".repeat(60)}\n${submitted.event}:\n${submitted.body}\n`);
} else {
  console.error("usage: bun run scripts/dry-run.ts planner|reviewer");
  process.exit(1);
}
