/**
 * Reviewer service. Acts on a managed PR with code + plan whose current head SHA
 * has not been reviewed. It CAPTURES the head SHA, fetches the diff for THAT SHA,
 * reviews the cumulative diff against the union of the plan's phase acceptance
 * criteria, and submits a native review PINNED to that SHA (mandatory commitId).
 *
 * Self-healing: if the head moves while we review, our review's commitId no
 * longer equals the new head, so the next poll re-derives "review" — a stale
 * review can never count as approval of unseen code.
 *
 * Fix-loop cap (= 3), owned here: count only OUR OWN changes-requested reviews.
 * Below the cap, submit a request-changes review. On the third own CR, submit the
 * review AND apply `blocked` + an escalation comment in the same cycle. The
 * implementer-fix trigger does no counting — `blocked` is the sole enforcement.
 */

import type { AgentRunner } from "../agent/runner";
import type { GitHubClient, PullRequest } from "../github/pr-client";
import type { Logger } from "../logger";
import { deriveStage, planPath, statusProjection } from "../runtime/derive";

export const FIX_ROUND_CAP = 3;

export type ReviewResult = { decision: "approve" | "request_changes"; summary: string; findings: string[] };

const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "findings"],
  properties: {
    decision: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM_PROMPT = [
  "You are the Reviewer in an autonomous GitHub-native engineering system.",
  "You are given the cumulative diff of a pull request. The diff includes the plan file",
  "(plans/<slug>.md) with thick phases and their acceptance criteria. Review the whole",
  "feature against the UNION of all phases' acceptance criteria — not individual commits.",
  "",
  "- Set decision to \"approve\" only if every phase's acceptance criteria are met, tests",
  "  are adequate, and you found no correctness defects or scope creep.",
  "- Otherwise set decision to \"request_changes\" and list concrete, actionable findings.",
  "  Each finding states what is wrong and what to change.",
].join("\n");

export const parseReviewResult = (value: unknown): ReviewResult => {
  const v = value as Record<string, unknown> | null;
  if (v?.decision !== "approve" && v?.decision !== "request_changes") {
    throw new Error('Reviewer output must have decision "approve" or "request_changes"');
  }
  if (typeof v.summary !== "string" || v.summary.trim() === "") {
    throw new Error("Reviewer output must include a non-empty summary");
  }
  const findings = Array.isArray(v.findings) ? (v.findings.filter((f) => typeof f === "string") as string[]) : [];
  return { decision: v.decision, summary: v.summary, findings };
};

const renderReviewBody = (result: ReviewResult): string => {
  const lines = result.findings.map((f) => `- ${f}`);
  return [result.summary, "", ...(lines.length > 0 ? lines : ["- (no specific findings)"])].join("\n");
};

export type ReviewOutcome =
  | { outcome: "approved" }
  | { outcome: "changes-requested"; round: number }
  | { outcome: "blocked"; reason: string };

export class ReviewerService {
  constructor(
    private readonly gh: GitHubClient,
    private readonly runner: AgentRunner,
    private readonly model: string,
    private readonly log: Logger,
  ) {}

  /** Review one PR at its current head, pinning the review to the captured SHA. */
  async review(pr: PullRequest, slug: string, headSha: string): Promise<ReviewOutcome> {
    const log = this.log.child({ pr: pr.number, slug, headSha });

    const diff = await this.gh.getPullRequestDiff(pr.number, headSha);
    const run = await this.runner({
      system: SYSTEM_PROMPT,
      prompt: `# Pull request #${pr.number} — cumulative diff at ${headSha}\n\n(The diff includes \`${planPath(slug)}\`.)\n\n${diff}`,
      model: this.model,
      jsonSchema: REVIEW_SCHEMA,
      maxTurns: 1,
    });
    const result = parseReviewResult(run.structured);
    const body = renderReviewBody(result);

    if (result.decision === "approve") {
      await this.gh.submitReview(pr.number, { commitId: headSha, event: "APPROVE", body });
      await this.gh.setStatusProjection(pr.number, statusProjection("merge"));
      log.info("approved", { costUsd: run.costUsd });
      return { outcome: "approved" };
    }

    // request_changes: this submission is our (priorOwnCR + 1)-th changes-requested review.
    const viewer = await this.gh.getViewerLogin();
    const priorOwnCr = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED" && r.author === viewer).length;
    const thisRound = priorOwnCr + 1;

    await this.gh.submitReview(pr.number, { commitId: headSha, event: "REQUEST_CHANGES", body });

    if (thisRound >= FIX_ROUND_CAP) {
      await this.gh.addBlockedLabel(pr.number);
      await this.gh.comment(
        pr.number,
        `Requested changes ${thisRound} times (cap ${FIX_ROUND_CAP}) — escalating to a human.`,
      );
      await this.gh.setStatusProjection(pr.number, statusProjection("block-malformed"));
      log.warn("fix-round cap reached; blocking", { round: thisRound });
      return { outcome: "blocked", reason: "fix-round cap reached" };
    }

    await this.gh.setStatusProjection(pr.number, statusProjection("fix"));
    log.info("requested changes", { round: thisRound });
    return { outcome: "changes-requested", round: thisRound };
  }

  /** One poll cycle: review every PR whose head SHA has not been reviewed. */
  async runOnce(): Promise<{ approved: number; changesRequested: number; blocked: number; errored: number }> {
    const prs = await this.gh.listOpenPullRequests();
    let approved = 0;
    let changesRequested = 0;
    let blocked = 0;
    let errored = 0;

    for (const pr of prs) {
      const stage = deriveStage(pr);
      if (stage.stage !== "review") continue;
      try {
        const out = await this.review(pr, stage.slug, stage.headSha);
        if (out.outcome === "approved") approved += 1;
        else if (out.outcome === "changes-requested") changesRequested += 1;
        else blocked += 1;
      } catch (err) {
        errored += 1;
        this.log.error("review errored", { pr: pr.number, error: String(err) });
      }
    }

    this.log.info("reviewer cycle complete", { found: prs.length, approved, changesRequested, blocked, errored });
    return { approved, changesRequested, blocked, errored };
  }
}
