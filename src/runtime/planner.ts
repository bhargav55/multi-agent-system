/**
 * Planner agent (decisions 7, 9, 14-15). The human-authored issue body IS the
 * PRD. The planner reads it and produces an *implementation plan*, commits that
 * plan as `plans/issue-<N>.md` onto the issue's task branch, then moves the
 * issue to `ready`. The plan file later rides into the implementer's PR.
 *
 * No claim status: the planner runs as a single sequential loop on a slow poll,
 * and only flips to `ready` after the plan is committed — so a crash mid-plan
 * leaves the issue in `needs-plan` to be retried (openPlanBranch is idempotent).
 */

import type { AgentRunner } from "../agent/runner";
import type { GitHubClient, Issue } from "../github/client";
import type { Logger } from "../logger";
import { branchForIssue, planPath } from "./naming";

export type Plan = {
  overview: string;
  steps: string[];
  testStrategy: string[];
  outOfScope: string[];
};

const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "steps", "testStrategy", "outOfScope"],
  properties: {
    overview: { type: "string" },
    steps: { type: "array", minItems: 1, items: { type: "string" } },
    testStrategy: { type: "array", items: { type: "string" } },
    outOfScope: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM_PROMPT = [
  "You are the Planner agent in an autonomous GitHub-native engineering system.",
  "You are given one GitHub issue whose body is the PRD (the what and why).",
  "Produce a concrete implementation plan a separate implementer agent will follow",
  "to deliver the whole issue in a single pull request:",
  "- overview: a short paragraph on the approach.",
  "- steps: ordered, concrete implementation steps (small vertical slices first).",
  "- testStrategy: how the change will be tested; tests must accompany the code.",
  "- outOfScope: anything explicitly NOT being done, to keep the implementer bounded.",
  "Do not write code. Return only the structured plan.",
].join("\n");

const asStringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`Planner output field "${field}" must be a string array`);
  }
  return value as string[];
};

export const parsePlan = (value: unknown): Plan => {
  const v = value as Record<string, unknown> | null;
  if (typeof v?.overview !== "string" || v.overview.trim() === "") {
    throw new Error("Planner output must include a non-empty overview");
  }
  const steps = asStringArray(v.steps, "steps");
  if (steps.length === 0) throw new Error("Planner output must include at least one step");
  return {
    overview: v.overview,
    steps,
    testStrategy: asStringArray(v.testStrategy, "testStrategy"),
    outOfScope: asStringArray(v.outOfScope, "outOfScope"),
  };
};

const section = (title: string, lines: string[]): string => {
  const body = lines.length > 0 ? lines.map((l) => `- ${l}`).join("\n") : "- None";
  return `## ${title}\n\n${body}`;
};

/** Render a plan into the Markdown committed as the plan file. */
export const renderPlan = (issue: Issue, plan: Plan): string =>
  [
    `# Implementation Plan — Issue #${issue.number}: ${issue.title}`,
    "",
    "## Overview",
    "",
    plan.overview,
    "",
    section("Steps", plan.steps),
    "",
    section("Test Strategy", plan.testStrategy),
    "",
    section("Out of Scope", plan.outOfScope),
  ].join("\n");

export class PlannerAgent {
  constructor(
    private readonly gh: GitHubClient,
    private readonly runner: AgentRunner,
    private readonly model: string,
    private readonly log: Logger,
  ) {}

  /** Plan one issue: generate the plan, commit it to the task branch, mark ready. */
  async planIssue(issue: Issue): Promise<void> {
    const log = this.log.child({ issue: issue.number });
    log.info("planning issue", { title: issue.title });

    try {
      const run = await this.runner({
        system: SYSTEM_PROMPT,
        prompt: `# Issue #${issue.number}: ${issue.title}\n\n${issue.body}`,
        model: this.model,
        jsonSchema: PLAN_SCHEMA,
        maxTurns: 1,
      });
      const plan = parsePlan(run.structured);

      const branch = branchForIssue(issue);
      const path = planPath(issue);
      await this.gh.openPlanBranch(branch, path, renderPlan(issue, plan), `Plan issue #${issue.number}`);

      // Flip to ready only after the plan is committed (so a failure is retried).
      await this.gh.setStatus(issue.number, "ready");
      await this.gh.comment(issue.number, `Implementation plan committed to \`${path}\` on \`${branch}\`. Ready to implement.`);
      log.info("planned issue", { branch, path, costUsd: run.costUsd });
    } catch (err) {
      await this.gh.comment(issue.number, `Planning failed, leaving in needs-plan: ${String(err)}`);
      log.error("planning failed", { error: String(err) });
      throw err;
    }
  }

  /** Drain every issue currently awaiting planning. */
  async runOnce(): Promise<{ planned: number; failed: number }> {
    const issues = await this.gh.listIssuesByStatus("needs-plan");
    let planned = 0;
    let failed = 0;
    for (const issue of issues) {
      try {
        await this.planIssue(issue);
        planned += 1;
      } catch {
        failed += 1; // already logged + commented
      }
    }
    this.log.info("planner cycle complete", { found: issues.length, planned, failed });
    return { planned, failed };
  }
}
