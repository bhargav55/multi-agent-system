/**
 * Implementer service — the only service that EXECUTES project code (it runs the
 * agent with bypassed permissions inside a temp clone, then runs the test gate).
 *
 * New mode (stage "implement"): clone the PR head ref, drive the agent to deliver
 * ALL plan phases as one commit per phase, run the test gate on the FINAL tree,
 * and only on green push every commit in a SINGLE push. It then (re)writes the PR
 * body (what/changes/why + PRD/plan links). A crash before the push discards the
 * local commits with the temp clone, so the work re-fires cleanly from "no code".
 *
 * Fix mode (stage "fix"): build the prompt from the latest changes-requested
 * review body, add fixes as commits on top, gate, single push — moving the head
 * so the reviewer re-reviews. Never opens a PR.
 *
 * Failure taxonomy: agent reports blocked / no changes / tests red => `blocked`
 * (deterministic). Clone/push/SDK throw => no label, retried next poll.
 */

import type { AgentRunner } from "../agent/runner";
import type { GitHubClient, PullRequest } from "../github/pr-client";
import type { Logger } from "../logger";
import { deriveStage, planPath, prdPath, statusProjection } from "../runtime/derive";
import type { TestRun, Workspace } from "../runtime/workspace";

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
  "You are the Implementer in an autonomous GitHub-native engineering system.",
  "The repository is checked out in your working directory on the PR's branch. The PRD",
  "and the implementation plan (plans/<slug>.md) are already in the tree — read the plan",
  "first and follow it.",
  "",
  "Rules:",
  "- Deliver the WHOLE plan on this branch: implement every phase.",
  "- Make ONE git commit per phase as you complete it, with a clear message, so the PR",
  "  history reads as a sequence of reviewable slices. Keep tests green at each commit.",
  "- The code MUST compile and the project's tests MUST pass on the final tree.",
  "- If the plan is contradictory, impossible, or cannot be completed, set outcome to",
  "  \"blocked\" and explain why in summary instead of guessing.",
  "- Otherwise set outcome to \"implemented\"; put a concise PR summary in summary and any",
  "  reviewer-relevant caveats in notes.",
].join("\n");

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : [];

export const parseImplementResult = (value: unknown): ImplementResult => {
  const v = value as Record<string, unknown> | null;
  if (v?.outcome !== "implemented" && v?.outcome !== "blocked") {
    throw new Error('Implementer output must have outcome "implemented" or "blocked"');
  }
  if (typeof v.summary !== "string" || v.summary.trim() === "") {
    throw new Error("Implementer output must include a non-empty summary");
  }
  return { outcome: v.outcome, summary: v.summary, notes: asStringArray(v.notes) };
};

/** The PR body the implementer owns: what / changes / why + PRD and plan links. */
export const renderPrBody = (slug: string, result: ImplementResult): string => {
  const changes = result.notes.length > 0 ? result.notes.map((n) => `- ${n}`).join("\n") : `- ${result.summary}`;
  return [
    "## What",
    "",
    result.summary,
    "",
    "## Changes",
    "",
    changes,
    "",
    "## Why",
    "",
    `Delivers \`${prdPath(slug)}\` following \`${planPath(slug)}\`.`,
    "",
    "---",
    "",
    `- PRD: \`${prdPath(slug)}\``,
    `- Plan: \`${planPath(slug)}\``,
  ].join("\n");
};

export type ImplementOutcome =
  | { outcome: "implemented" }
  | { outcome: "blocked"; reason: string };

type Mode = {
  kind: "new" | "fix";
  buildPrompt: () => string;
};

export class ImplementerService {
  constructor(
    private readonly gh: GitHubClient,
    private readonly runner: AgentRunner,
    private readonly workspace: Workspace,
    private readonly model: string,
    private readonly log: Logger,
  ) {}

  private async block(pr: PullRequest, reason: string): Promise<ImplementOutcome> {
    await this.gh.addBlockedLabel(pr.number);
    await this.gh.comment(pr.number, reason);
    this.log.warn("PR blocked", { pr: pr.number, reason });
    return { outcome: "blocked", reason };
  }

  private async execute(pr: PullRequest, slug: string, mode: Mode): Promise<ImplementOutcome> {
    const log = this.log.child({ pr: pr.number, slug, mode: mode.kind });
    let dir: string | undefined;
    try {
      ({ dir } = await this.workspace.prepareExisting(pr.headRef));

      const run = await this.runner({
        system: SYSTEM_PROMPT,
        prompt: mode.buildPrompt(),
        model: this.model,
        cwd: dir,
        permissionMode: "bypassPermissions",
        maxTurns: 80,
        jsonSchema: IMPL_SCHEMA,
      });
      const result = parseImplementResult(run.structured);

      if (result.outcome === "blocked") {
        return this.block(pr, `Implementer could not complete the work: ${result.summary}`);
      }

      // Did the agent actually produce work? (commits on top, or uncommitted edits).
      const committed = (await this.workspace.currentSha(dir)) !== pr.headSha;
      const dirty = await this.workspace.hasChanges(dir);
      if (!committed && !dirty) {
        return this.block(pr, "Implementer reported success but produced no changes.");
      }
      // Capture any uncommitted leftovers as a final commit so the gate sees the whole tree.
      if (dirty) await this.workspace.commitAll(dir, `Implement ${slug}`);

      const tests: TestRun = await this.workspace.runTests(dir);
      if (!tests.ok) {
        return this.block(pr, `Tests failed (\`${tests.command}\`):\n\n${tests.output.slice(-3000)}`);
      }

      // Single push of all commits, only after the gate passes.
      await this.workspace.push(dir, pr.headRef);

      if (mode.kind === "new") {
        await this.gh.setPullRequestBody(pr.number, renderPrBody(slug, result));
      }
      await this.gh.setStatusProjection(pr.number, statusProjection("review"));
      log.info("pushed implementation", { tests: tests.command, costUsd: run.costUsd });
      return { outcome: "implemented" };
    } finally {
      if (dir) await this.workspace.cleanup(dir).catch(() => {});
    }
  }

  /** New mode: implement all plan phases for a needs-impl PR. */
  async implement(pr: PullRequest, slug: string): Promise<ImplementOutcome> {
    this.log.child({ pr: pr.number }).info("implementing PR", { slug });
    return this.execute(pr, slug, {
      kind: "new",
      buildPrompt: () =>
        [
          `Implement the plan for PRD \`${prdPath(slug)}\`.`,
          `Read \`${planPath(slug)}\` and deliver every phase on this branch.`,
        ].join("\n"),
    });
  }

  /** Fix mode: address the latest changes-requested review on a PR. */
  async fix(pr: PullRequest, slug: string): Promise<ImplementOutcome> {
    this.log.child({ pr: pr.number }).info("applying review fixes", { slug });
    const lastCr = [...pr.reviews].reverse().find((r) => r.state === "CHANGES_REQUESTED");
    const findings = lastCr?.body?.trim() || "(no recorded findings)";
    return this.execute(pr, slug, {
      kind: "fix",
      buildPrompt: () =>
        [
          `Address the reviewer's requested changes on PRD \`${prdPath(slug)}\`.`,
          `The plan is at \`${planPath(slug)}\`.`,
          "",
          "# Reviewer requested changes",
          "",
          "Fix every point below, then make sure the project's tests pass:",
          "",
          findings,
        ].join("\n"),
    });
  }

  /** One poll cycle: implement needs-impl PRs and fix changes-requested PRs. */
  async runOnce(): Promise<{ implemented: number; blocked: number; errored: number }> {
    const prs = await this.gh.listOpenPullRequests();
    let implemented = 0;
    let blocked = 0;
    let errored = 0;

    const tally = (out: ImplementOutcome) => {
      if (out.outcome === "implemented") implemented += 1;
      else blocked += 1;
    };

    for (const pr of prs) {
      const stage = deriveStage(pr);
      try {
        if (stage.stage === "implement") tally(await this.implement(pr, stage.slug));
        else if (stage.stage === "fix") tally(await this.fix(pr, stage.slug));
      } catch (err) {
        // Infra/SDK throw: no label, retry next poll (the trigger stays true).
        errored += 1;
        this.log.error("implementation errored", { pr: pr.number, error: String(err) });
      }
    }

    this.log.info("implementer cycle complete", { found: prs.length, implemented, blocked, errored });
    return { implemented, blocked, errored };
  }
}
