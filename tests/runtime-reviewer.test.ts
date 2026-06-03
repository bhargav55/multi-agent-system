import { describe, expect, it } from "vitest";
import type { AgentResult, AgentRunner } from "../src/agent/runner";
import { FIX_ROUND_CAP, fixRoundLabel } from "../src/config";
import { MockGitHubClient } from "../src/github/mock-client";
import { createLogger } from "../src/logger";
import { ReviewerAgent, parseReviewResult } from "../src/runtime/reviewer";

const silent = createLogger({}, { out: () => {}, err: () => {} });

const result = (structured: unknown): AgentResult => ({
  text: "",
  structured,
  numTurns: 1,
  costUsd: 0.02,
  durationMs: 10,
});

const runnerReturning = (structured: unknown): AgentRunner => async () => result(structured);

const pass = { decision: "pass", summary: "meets criteria", findings: [] };
const fail = {
  decision: "fail",
  summary: "missing tests",
  findings: [{ severity: "major", detail: "no test for the error path" }],
};

/** Seed an in-review issue with a linked PR. */
const seedReviewable = async (gh: MockGitHubClient, labels: string[] = []) => {
  const n = gh.seed({ title: "Add endpoint", body: "PRD: endpoint returns 200", status: "in-review", kind: "feature", labels });
  await gh.openPullRequest({ title: "impl", body: "Closes", head: `task/${n}-x`, base: "main", linkedIssue: n });
  return n;
};

describe("parseReviewResult", () => {
  it("accepts pass and fail with findings", () => {
    expect(parseReviewResult(pass).decision).toBe("pass");
    expect(parseReviewResult(fail).findings).toHaveLength(1);
  });
  it("rejects bad decisions", () => {
    expect(() => parseReviewResult({ decision: "maybe", summary: "x", findings: [] })).toThrow(/decision/);
  });
});

describe("ReviewerAgent", () => {
  it("passes to ready-for-human", async () => {
    const gh = new MockGitHubClient();
    const n = await seedReviewable(gh);
    const out = await new ReviewerAgent(gh, runnerReturning(pass), "m", silent).reviewTask(await gh.getIssue(n));

    expect(out).toEqual({ outcome: "ready-for-human" });
    expect((await gh.getIssue(n)).status).toBe("ready-for-human");
  });

  it("bounces a first failure to needs-fixes, records findings, increments the round", async () => {
    const gh = new MockGitHubClient();
    const n = await seedReviewable(gh);
    const out = await new ReviewerAgent(gh, runnerReturning(fail), "m", silent).reviewTask(await gh.getIssue(n));

    expect(out).toEqual({ outcome: "needs-fixes", round: 1 });
    const issue = await gh.getIssue(n);
    expect(issue.status).toBe("needs-fixes");
    expect(issue.labels).toContain(fixRoundLabel(1));
    expect(await gh.getReviewFindings(n)).toContain("no test for the error path");
  });

  it("escalates to blocked once the fix-round cap is reached", async () => {
    const gh = new MockGitHubClient();
    // Already at the cap: the next failure must escalate, not bounce again.
    const n = await seedReviewable(gh, [fixRoundLabel(FIX_ROUND_CAP)]);
    const out = await new ReviewerAgent(gh, runnerReturning(fail), "m", silent).reviewTask(await gh.getIssue(n));

    expect(out).toEqual({ outcome: "blocked", reason: "fix-round cap exceeded" });
    expect((await gh.getIssue(n)).status).toBe("blocked");
  });

  it("blocks an in-review issue that has no linked PR", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ title: "orphan", status: "in-review", kind: "feature" });
    const out = await new ReviewerAgent(gh, runnerReturning(pass), "m", silent).reviewTask(await gh.getIssue(n));

    expect(out.outcome).toBe("blocked");
    expect((await gh.getIssue(n)).status).toBe("blocked");
  });

  it("drains in-review tasks and tallies outcomes", async () => {
    const gh = new MockGitHubClient();
    await seedReviewable(gh);
    await seedReviewable(gh);
    const summary = await new ReviewerAgent(gh, runnerReturning(pass), "m", silent).runOnce();
    expect(summary).toEqual({ passed: 2, bounced: 0, blocked: 0, errored: 0 });
  });
});
