/**
 * Implementer agent (decisions 4, 7, 9, 14-15). Claims a `ready` issue, checks
 * out the task branch the planner prepared (which already carries the plan
 * file), drives the SDK (bypass-permissions: edit + bash + run tests) to deliver
 * the whole issue, and — only if the project's tests pass — commits, pushes,
 * opens a PR, and moves the issue to `in-review`. Also handles `needs-fixes`:
 * re-check-out the same branch and address the reviewer's findings.
 *
 * The service boundary is the sandbox: this service holds only a narrow
 * repo-scoped token, so bypassing in-process permission prompts is intentional.
 */

import type { Status } from "../config";
import type { AgentRunner } from "../agent/runner";
import type { GitHubClient, Issue } from "../github/client";
import type { Logger } from "../logger";
import { branchForIssue, planPath } from "./naming";
import type { TestRun, Workspace } from "./workspace";

export type ImplementResult = {
  outcome: "implemented" | "blocked";
  summary: string;
  notes: string[];
};

const IMPL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "notes"],
  properties: {
    outcome: { type: "string", enum: ["implemented", "blocked"] },
    summary: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM_PROMPT = [
  "You are the Implementer agent in an autonomous GitHub-native engineering system.",
  "You are given one GitHub issue whose body is the PRD, plus an implementation plan",
  "committed in the repository (read the plan file first). The repository is checked",
  "out in your working directory.",
  "",
  "Rules:",
  "- Follow the plan and deliver the whole issue on this one branch. Stay within the",
  "  plan's scope and respect its Out of Scope.",
  "- The code you write MUST compile and the project's tests MUST pass. Add or update",
  "  tests per the plan's test strategy and run them before finishing.",
  "- If the issue or plan is underspecified, contradictory, or cannot be done, set",
  "  outcome to \"blocked\" and explain why in summary instead of guessing.",
  "- Otherwise set outcome to \"implemented\". Put a concise PR-ready summary in summary",
  "  and any reviewer-relevant caveats in notes.",
].join("\n");

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : [];

export const parseImplementResult = (value: unknown): ImplementResult => {
  const v = value as Record<string, unknown> | null;
  const outcome = v?.outcome;
  if (outcome !== "implemented" && outcome !== "blocked") {
    throw new Error('Implementer output must have outcome "implemented" or "blocked"');
  }
  if (typeof v?.summary !== "string" || v.summary.trim() === "") {
    throw new Error("Implementer output must include a non-empty summary");
  }
  return { outcome, summary: v.summary, notes: asStringArray(v.notes) };
};

const prBody = (issue: Issue, result: ImplementResult, tests: TestRun): string => {
  const notes = result.notes.length > 0 ? result.notes.map((n) => `- ${n}`).join("\n") : "- None";
  return [
    `Closes #${issue.number}`,
    "",
    `Plan: \`${planPath(issue)}\``,
    "",
    "## Summary",
    "",
    result.summary,
    "",
    "## Notes for review",
    "",
    notes,
    "",
    "## Tests",
    "",
    `\`${tests.command}\` passed.`,
  ].join("\n");
};

export type TaskOutcome =
  | { outcome: "in-review"; pr: number }
  | { outcome: "blocked"; reason: string };

export class ImplementerAgent {
  constructor(
    private readonly gh: GitHubClient,
    private readonly runner: AgentRunner,
    private readonly workspace: Workspace,
    private readonly model: string,
    private readonly log: Logger,
    private readonly base = "main",
  ) {}

  /** Fresh issue in `ready`: implement on the planner's branch, open a PR. */
  async implementIssue(issue: Issue): Promise<TaskOutcome> {
    this.log.child({ issue: issue.number }).info("implementing issue", { title: issue.title });
    return this.execute(issue, {
      revertStatus: "ready",
      mode: "new",
      buildPrompt: async () =>
        `# Issue #${issue.number}: ${issue.title}\n\n${issue.body}\n\n` +
        `Read the implementation plan at \`${planPath(issue)}\` and follow it.`,
    });
  }

  /** Issue bounced to `needs-fixes`: re-check-out the branch, address findings. */
  async applyFixes(issue: Issue): Promise<TaskOutcome> {
    this.log.child({ issue: issue.number }).info("applying review fixes", { title: issue.title });
    return this.execute(issue, {
      revertStatus: "needs-fixes",
      mode: "fix",
      buildPrompt: async () => {
        const findings = (await this.gh.getReviewFindings(issue.number)) ?? "(no recorded findings)";
        return [
          `# Issue #${issue.number}: ${issue.title}`,
          "",
          issue.body,
          "",
          `Plan: \`${planPath(issue)}\` (already in the working tree).`,
          "",
          "# Reviewer requested changes",
          "",
          "Address every point below, then make sure the project's tests pass:",
          "",
          findings,
        ].join("\n");
      },
    });
  }

  private async execute(
    issue: Issue,
    opts: { revertStatus: Status; mode: "new" | "fix"; buildPrompt: () => Promise<string> },
  ): Promise<TaskOutcome> {
    const log = this.log.child({ issue: issue.number });
    // Claim: flip out of the trigger state so a concurrent/repeat poll skips it.
    await this.gh.setStatus(issue.number, "in-progress");

    const branch = branchForIssue(issue);
    let dir: string | undefined;
    try {
      // The planner already created this branch with the plan file on it.
      ({ dir } = await this.workspace.prepareExisting(branch));

      const run = await this.runner({
        system: SYSTEM_PROMPT,
        prompt: await opts.buildPrompt(),
        model: this.model,
        cwd: dir,
        permissionMode: "bypassPermissions",
        maxTurns: 60,
        jsonSchema: IMPL_SCHEMA,
      });
      const result = parseImplementResult(run.structured);

      if (result.outcome === "blocked") {
        return this.block(issue, `Implementer could not complete the issue: ${result.summary}`);
      }
      if (!(await this.workspace.hasChanges(dir))) {
        return this.block(issue, "Implementer reported success but produced no changes.");
      }

      const tests = await this.workspace.runTests(dir);
      if (!tests.ok) {
        return this.block(issue, `Tests failed (\`${tests.command}\`):\n\n${tests.output.slice(-3000)}`);
      }

      await this.workspace.commitAll(dir, `${issue.title}\n\nCloses #${issue.number}`);
      await this.workspace.push(dir, branch);

      if (opts.mode === "new") {
        const pr = await this.gh.openPullRequest({
          title: `[#${issue.number}] ${issue.title}`,
          body: prBody(issue, result, tests),
          head: branch,
          base: this.base,
          linkedIssue: issue.number,
        });
        await this.gh.setStatus(issue.number, "in-review");
        await this.gh.comment(issue.number, `Opened ${pr.url}; \`${tests.command}\` passed.`);
        log.info("issue implemented", { pr: pr.number, costUsd: run.costUsd });
        return { outcome: "in-review", pr: pr.number };
      }

      const pr = await this.gh.findPullRequestForIssue(issue.number);
      await this.gh.setStatus(issue.number, "in-review");
      await this.gh.comment(issue.number, `Pushed fixes to ${pr ? pr.url : branch}; \`${tests.command}\` passed.`);
      log.info("fixes applied", { pr: pr?.number, costUsd: run.costUsd });
      return { outcome: "in-review", pr: pr?.number ?? 0 };
    } catch (err) {
      // Infrastructure failure (clone/push/SDK): return to the trigger state for retry.
      await this.gh.setStatus(issue.number, opts.revertStatus);
      await this.gh.comment(issue.number, `Implementation errored, returning to ${opts.revertStatus}: ${String(err)}`);
      log.error("implementation errored", { error: String(err) });
      throw err;
    } finally {
      if (dir) await this.workspace.cleanup(dir).catch(() => {});
    }
  }

  private async block(issue: Issue, reason: string): Promise<TaskOutcome> {
    await this.gh.setStatus(issue.number, "blocked");
    await this.gh.comment(issue.number, reason);
    this.log.warn("issue blocked", { issue: issue.number, reason });
    return { outcome: "blocked", reason };
  }

  /** Drain fresh `ready` issues and `needs-fixes` issues bounced back by the reviewer. */
  async runOnce(): Promise<{ implemented: number; blocked: number; errored: number }> {
    let implemented = 0;
    let blocked = 0;
    let errored = 0;

    const tally = (outcome: TaskOutcome["outcome"]) => {
      if (outcome === "in-review") implemented += 1;
      else blocked += 1;
    };

    const ready = await this.gh.listIssuesByStatus("ready");
    for (const issue of ready) {
      try {
        tally((await this.implementIssue(issue)).outcome);
      } catch {
        errored += 1; // already logged + returned to its trigger state
      }
    }

    const fixes = await this.gh.listIssuesByStatus("needs-fixes");
    for (const issue of fixes) {
      try {
        tally((await this.applyFixes(issue)).outcome);
      } catch {
        errored += 1;
      }
    }

    const found = ready.length + fixes.length;
    this.log.info("implementer cycle complete", { found, implemented, blocked, errored });
    return { implemented, blocked, errored };
  }
}
