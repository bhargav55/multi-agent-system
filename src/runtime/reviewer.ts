/**
 * Reviewer agent (decisions 7, 9, 11). Reviews the PR for each `in-review` task
 * against its acceptance criteria and decides pass/fail:
 *   - pass -> `ready-for-human` (awaiting the human merge gate)
 *   - fail -> `needs-fixes` and bump the `fix-round:N` counter, UNLESS the
 *     bounded cap is reached, in which case escalate to `blocked`.
 *
 * No claim status is needed: each service runs a single sequential poll loop
 * (concurrency 1), so a task is never reviewed twice within a cycle.
 */

import { FIX_ROUND_CAP, fixRoundFromLabels } from "../config";
import type { AgentRunner } from "../agent/runner";
import type { GitHubClient, Issue } from "../github/client";
import type { Logger } from "../logger";

export type Severity = "blocker" | "major" | "minor" | "nit";
export type ReviewFinding = { severity: Severity; detail: string };
export type ReviewResult = { decision: "pass" | "fail"; summary: string; findings: ReviewFinding[] };

const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "findings"],
  properties: {
    decision: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "detail"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          detail: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  "You are the Reviewer agent in an autonomous GitHub-native engineering system.",
  "You are given an issue whose body is the PRD, and the diff of the pull request that",
  "implements it. The diff includes the implementation plan file (plans/issue-<N>.md).",
  "Review the diff against the PRD and the plan, checking that the work delivers the",
  "PRD, follows the plan, has proper tests, and is free of correctness defects and",
  "scope creep.",
  "",
  "- Set decision to \"pass\" only if the PRD is satisfied, tests are adequate, and you",
  "  found no blocker- or major-severity problems.",
  "- Otherwise set decision to \"fail\" and list concrete, actionable findings ordered",
  "  by severity. Each finding must say what is wrong and what to change.",
].join("\n");

export const parseReviewResult = (value: unknown): ReviewResult => {
  const v = value as Record<string, unknown> | null;
  if (v?.decision !== "pass" && v?.decision !== "fail") {
    throw new Error('Reviewer output must have decision "pass" or "fail"');
  }
  if (typeof v.summary !== "string" || v.summary.trim() === "") {
    throw new Error("Reviewer output must include a non-empty summary");
  }
  const findings = Array.isArray(v.findings)
    ? (v.findings as Record<string, unknown>[]).map((f) => ({
        severity: f.severity as Severity,
        detail: String(f.detail ?? ""),
      }))
    : [];
  return { decision: v.decision, summary: v.summary, findings };
};

const renderFindings = (result: ReviewResult): string => {
  const lines = result.findings.map((f) => `- **${f.severity}**: ${f.detail}`);
  return [result.summary, "", ...(lines.length > 0 ? lines : ["- (no specific findings provided)"])].join("\n");
};

export type ReviewOutcome =
  | { outcome: "ready-for-human" }
  | { outcome: "needs-fixes"; round: number }
  | { outcome: "blocked"; reason: string };

export class ReviewerAgent {
  constructor(
    private readonly gh: GitHubClient,
    private readonly runner: AgentRunner,
    private readonly model: string,
    private readonly log: Logger,
  ) {}

  async reviewTask(issue: Issue): Promise<ReviewOutcome> {
    const log = this.log.child({ issue: issue.number });

    const pr = await this.gh.findPullRequestForIssue(issue.number);
    if (!pr) {
      await this.gh.setStatus(issue.number, "blocked");
      await this.gh.comment(issue.number, "In review but no linked pull request found; needs a human.");
      log.warn("in-review task has no PR", {});
      return { outcome: "blocked", reason: "no linked PR" };
    }

    const diff = await this.gh.getPullRequestDiff(pr.number);
    const run = await this.runner({
      system: SYSTEM_PROMPT,
      prompt: `# Issue #${issue.number} (PRD): ${issue.title}\n\n${issue.body}\n\n# Pull request #${pr.number} diff (includes the plan)\n\n${diff}`,
      model: this.model,
      jsonSchema: REVIEW_SCHEMA,
      maxTurns: 1,
    });
    const result = parseReviewResult(run.structured);

    if (result.decision === "pass") {
      await this.gh.setStatus(issue.number, "ready-for-human");
      await this.gh.comment(issue.number, `Review passed. ${result.summary}`);
      log.info("review passed", { pr: pr.number, costUsd: run.costUsd });
      return { outcome: "ready-for-human" };
    }

    const nextRound = fixRoundFromLabels(issue.labels) + 1;
    const findings = renderFindings(result);

    if (nextRound > FIX_ROUND_CAP) {
      await this.gh.setStatus(issue.number, "blocked");
      await this.gh.comment(
        issue.number,
        `Review failed after ${FIX_ROUND_CAP} fix rounds — escalating to a human.\n\n${findings}`,
      );
      log.warn("fix-round cap exceeded; escalating", { pr: pr.number });
      return { outcome: "blocked", reason: "fix-round cap exceeded" };
    }

    await this.gh.setFixRound(issue.number, nextRound);
    await this.gh.requestChanges(issue.number, findings);
    await this.gh.setStatus(issue.number, "needs-fixes");
    log.info("review requested changes", { pr: pr.number, round: nextRound });
    return { outcome: "needs-fixes", round: nextRound };
  }

  /** Drain every issue currently awaiting review. */
  async runOnce(): Promise<{ passed: number; bounced: number; blocked: number; errored: number }> {
    const tasks = await this.gh.listIssuesByStatus("in-review");
    let passed = 0;
    let bounced = 0;
    let blocked = 0;
    let errored = 0;
    for (const task of tasks) {
      try {
        const r = await this.reviewTask(task);
        if (r.outcome === "ready-for-human") passed += 1;
        else if (r.outcome === "needs-fixes") bounced += 1;
        else blocked += 1;
      } catch (err) {
        errored += 1;
        this.log.error("review errored", { issue: task.number, error: String(err) });
      }
    }
    this.log.info("reviewer cycle complete", { found: tasks.length, passed, bounced, blocked, errored });
    return { passed, bounced, blocked, errored };
  }
}
