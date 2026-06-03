/**
 * Planner service. Acts on a managed PR that has a PRD but no plan: clones the
 * head ref READ-ONLY to explore the codebase (read tools only — no bash, no test
 * run, no permission bypass), runs the prd-to-plan methodology non-interactively
 * (no quiz, no plan-approval gate), and commits a single `plans/<slug>.md` file
 * onto the PR branch. The plan uses THICK end-to-end vertical-slice phases with
 * per-phase acceptance criteria, because all phases ship in one PR with no
 * incremental human checkpoint.
 *
 * Idempotent: a PR that already has a plan derives to a different stage and is
 * skipped. A crash before the commit leaves the PR in needs-plan to re-fire.
 */

import type { AgentRunner } from "../agent/runner";
import type { GitHubClient, PullRequest } from "../github/pr-client";
import type { Logger } from "../logger";
import { deriveStage, planPath, prdPath, statusProjection } from "../runtime/derive";
import type { Workspace } from "../runtime/workspace";

export type PlanPhase = { name: string; whatToBuild: string; acceptanceCriteria: string[] };
export type PlanResult =
  | { outcome: "planned"; decisions: string[]; phases: PlanPhase[] }
  | { outcome: "blocked"; reason: string };

const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: { type: "string", enum: ["planned", "blocked"] },
    reason: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    phases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "whatToBuild", "acceptanceCriteria"],
        properties: {
          name: { type: "string" },
          whatToBuild: { type: "string" },
          acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  "You are the Planner in an autonomous GitHub-native engineering system.",
  "You are given one PRD (the what and why). The repository is checked out in your",
  "working directory; explore it with the read-only tools to ground the plan in the",
  "real architecture. Do NOT write code, run commands, or run tests — read only.",
  "",
  "Produce an implementation plan a separate implementer will follow to deliver the",
  "WHOLE PRD inside a single pull request. Because every phase ships in that one PR",
  "with no human checkpoint between phases, make the phases THICK, end-to-end vertical",
  "slices (not many thin slices): each phase is a coherent, shippable increment.",
  "",
  "Return structured output:",
  "- outcome: \"planned\" normally; \"blocked\" with a reason ONLY if the PRD is",
  "  un-plannable (contradictory, impossible, or far too underspecified to plan).",
  "- decisions: durable architectural decisions that apply across phases.",
  "- phases: ordered thick phases. Each has a name, a whatToBuild paragraph, and",
  "  acceptanceCriteria (concrete, checkable statements). Give the implementer build",
  "  order and the reviewer a concrete checklist.",
].join("\n");

/** Read-only tools the planner agent may use to explore (no bash/edit/write). */
const READONLY_TOOLS = ["Read", "Grep", "Glob"];
const MUTATING_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit"];

export const parsePlanResult = (value: unknown): PlanResult => {
  const v = value as Record<string, unknown> | null;
  if (v?.outcome === "blocked") {
    const reason = typeof v.reason === "string" && v.reason.trim() ? v.reason : "Planner reported the PRD is un-plannable.";
    return { outcome: "blocked", reason };
  }
  if (v?.outcome !== "planned") {
    throw new Error('Planner output must have outcome "planned" or "blocked"');
  }
  const phases = Array.isArray(v.phases) ? (v.phases as Record<string, unknown>[]) : [];
  if (phases.length === 0) throw new Error("Planner output must include at least one phase");
  const parsed: PlanPhase[] = phases.map((p, i) => {
    const ac = Array.isArray(p.acceptanceCriteria) ? p.acceptanceCriteria.filter((c) => typeof c === "string") : [];
    if (typeof p.name !== "string" || typeof p.whatToBuild !== "string" || ac.length === 0) {
      throw new Error(`Phase ${i + 1} must have a name, whatToBuild, and at least one acceptance criterion`);
    }
    return { name: p.name, whatToBuild: p.whatToBuild, acceptanceCriteria: ac as string[] };
  });
  const decisions = Array.isArray(v.decisions) ? (v.decisions.filter((d) => typeof d === "string") as string[]) : [];
  return { outcome: "planned", decisions, phases: parsed };
};

/** Render a planned result into the Markdown committed as `plans/<slug>.md`. */
export const renderPlan = (slug: string, plan: Extract<PlanResult, { outcome: "planned" }>): string => {
  const decisions =
    plan.decisions.length > 0 ? plan.decisions.map((d) => `- ${d}`).join("\n") : "- None recorded.";
  const phases = plan.phases
    .map((p, i) => {
      const ac = p.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n");
      return [`## Phase ${i + 1}: ${p.name}`, "", "### What to build", "", p.whatToBuild, "", "### Acceptance criteria", "", ac].join("\n");
    })
    .join("\n\n");
  return [
    `# Plan: ${slug}`,
    "",
    `> Generated by the planner from \`${prdPath(slug)}\`. Thick end-to-end phases;`,
    "> all phases ship in one PR.",
    "",
    "## Architectural decisions",
    "",
    decisions,
    "",
    phases,
    "",
  ].join("\n");
};

export type PlanOutcome = { outcome: "planned" } | { outcome: "blocked"; reason: string };

export class PlannerService {
  constructor(
    private readonly gh: GitHubClient,
    private readonly runner: AgentRunner,
    private readonly workspace: Workspace,
    private readonly model: string,
    private readonly log: Logger,
  ) {}

  /** Plan one PR: explore read-only, generate the plan, commit it to the PR branch. */
  async plan(pr: PullRequest, slug: string): Promise<PlanOutcome> {
    const log = this.log.child({ pr: pr.number, slug });
    log.info("planning PR");

    let dir: string | undefined;
    try {
      ({ dir } = await this.workspace.prepareExisting(pr.headRef));

      const run = await this.runner({
        system: SYSTEM_PROMPT,
        prompt: `# PRD (\`${prdPath(slug)}\`)\n\n${pr.body}`,
        model: this.model,
        cwd: dir,
        allowedTools: READONLY_TOOLS,
        disallowedTools: MUTATING_TOOLS,
        maxTurns: 40,
        jsonSchema: PLAN_SCHEMA,
      });
      const result = parsePlanResult(run.structured);

      if (result.outcome === "blocked") {
        await this.gh.addBlockedLabel(pr.number);
        await this.gh.comment(pr.number, `Planner could not plan this PRD: ${result.reason}`);
        log.warn("PR blocked: un-plannable", { reason: result.reason });
        return { outcome: "blocked", reason: result.reason };
      }

      const path = planPath(slug);
      await this.gh.commitFile(pr.headRef, path, renderPlan(slug, result), `Plan ${slug}`);
      await this.gh.setStatusProjection(pr.number, statusProjection("implement"));
      log.info("planned PR", { path, phases: result.phases.length, costUsd: run.costUsd });
      return { outcome: "planned" };
    } finally {
      if (dir) await this.workspace.cleanup(dir).catch(() => {});
    }
  }

  /** One poll cycle: plan every needs-plan PR; park malformed PRs. */
  async runOnce(): Promise<{ planned: number; blocked: number; errored: number }> {
    const prs = await this.gh.listOpenPullRequests();
    let planned = 0;
    let blocked = 0;
    let errored = 0;

    for (const pr of prs) {
      const stage = deriveStage(pr);
      try {
        if (stage.stage === "block-malformed") {
          await this.gh.addBlockedLabel(pr.number);
          await this.gh.comment(pr.number, stage.reason);
          this.log.warn("PR blocked: malformed", { pr: pr.number, reason: stage.reason });
          blocked += 1;
          continue;
        }
        if (stage.stage !== "plan") continue;
        const out = await this.plan(pr, stage.slug);
        if (out.outcome === "planned") planned += 1;
        else blocked += 1;
      } catch (err) {
        // Infrastructure/SDK error: no label, retry next poll (the missing plan keeps the trigger true).
        errored += 1;
        this.log.error("planning errored", { pr: pr.number, error: String(err) });
      }
    }

    this.log.info("planner cycle complete", { found: prs.length, planned, blocked, errored });
    return { planned, blocked, errored };
  }
}
