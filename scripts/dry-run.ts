#!/usr/bin/env bun
/**
 * Local dry-run: exercise an agent against a seeded in-memory board using the
 * REAL Claude Agent SDK — so you can watch a real agent work with no GitHub,
 * no git, and no infra. Useful to sanity-check SDK auth and output quality.
 *
 * Needs SDK auth in the env (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
 *
 *   bun run scripts/dry-run.ts planner
 *   bun run scripts/dry-run.ts reviewer
 *
 * (The implementer needs a real git remote; use the `--once` live path for it.)
 */

import { sdkRunner } from "../src/agent/runner";
import { MockGitHubClient } from "../src/github/mock-client";
import { createLogger } from "../src/logger";
import { branchForIssue } from "../src/runtime/naming";
import { PlannerAgent } from "../src/runtime/planner";
import { ReviewerAgent } from "../src/runtime/reviewer";

const role = process.argv[2];
const model = process.env.AGENT_MODEL ?? "claude-sonnet-4-6";
const log = createLogger({ role: role ?? "?", mode: "dry-run" });
const gh = new MockGitHubClient();

if (role === "planner") {
  const n = gh.seed({
    title: "Add a /health endpoint",
    body: "Expose an HTTP health-check endpoint that returns service status and the current git SHA as JSON, so uptime monitors can poll it.",
    status: "needs-plan",
    kind: "feature",
  });
  await new PlannerAgent(gh, sdkRunner, model, log).runOnce();
  const issue = await gh.getIssue(n);
  log.info("issue after planning", { status: issue.status });
  const committed = gh.planBranch(branchForIssue(issue));
  if (committed) console.log(`\n${"-".repeat(60)}\n${committed.path} on ${committed.branch}:\n\n${committed.content}\n`);
} else if (role === "reviewer") {
  const n = gh.seed({
    title: "Add /health endpoint",
    body: "PRD: a GET /health endpoint must return 200 with `{ status: 'ok' }`, covered by a test.",
    status: "in-review",
    kind: "feature",
  });
  const pr = await gh.openPullRequest({
    title: "Add /health endpoint",
    body: `Closes #${n}`,
    head: `task/${n}-health`,
    base: "main",
    linkedIssue: n,
  });
  gh.setDiff(
    pr.number,
    [
      "diff --git a/src/health.ts b/src/health.ts",
      "+export const health = () => ({ status: 'ok' });",
      "// note: no test was added for the 200 response",
    ].join("\n"),
  );
  await new ReviewerAgent(gh, sdkRunner, model, log).runOnce();
  log.info("task status after review", { status: (await gh.getIssue(n)).status });
  const findings = await gh.getReviewFindings(n);
  if (findings) console.log(`\n${"-".repeat(60)}\nFindings:\n${findings}\n`);
} else {
  console.error("usage: bun run scripts/dry-run.ts planner|reviewer");
  process.exit(1);
}
