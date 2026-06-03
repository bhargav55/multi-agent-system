/**
 * Pure state derivation — the single source of truth for "what stage is this PR
 * in?". No I/O, so it is exhaustively unit-testable and every service computes
 * its trigger the same way. See prd/pr-first-runtime.md (Stage triggers).
 *
 * Lifecycle is monotonic: PRD -> +plan -> +code -> +review, so the stage
 * predicates are mutually exclusive.
 */

import type { PullRequest } from "../github/pr-client";

/** The only authoritative label. Excludes a PR from every trigger; human clears it. */
export const BLOCKED_LABEL = "blocked";

const STATUS_PREFIX = "status:";

const PRD_DIR = "prds/";
const PLAN_DIR = "plans/";

/** Path of the plan file for a slug; the planner commits exactly this. */
export const planPath = (slug: string): string => `${PLAN_DIR}${slug}.md`;

/** Path of the PRD file for a slug. */
export const prdPath = (slug: string): string => `${PRD_DIR}${slug}.md`;

/** A cosmetic projection label for a derived stage (write-only; never read). */
export const statusProjection = (stage: Stage["stage"]): string => {
  const value: Record<Stage["stage"], string> = {
    ignore: "ignored",
    "block-malformed": "blocked",
    plan: "needs-plan",
    implement: "ready",
    review: "in-review",
    fix: "needs-fixes",
    merge: "ready-for-human",
  };
  return `${STATUS_PREFIX}${value[stage]}`;
};

/** True if `label` is a cosmetic status projection (so it can be replaced wholesale). */
export const isStatusProjection = (label: string): boolean => label.startsWith(STATUS_PREFIX);

const isAddedPrd = (path: string): boolean => /^prds\/[^/]+\.md$/.test(path);

/** Slug derived from the PRD filename basename: prds/foo-bar.md -> "foo-bar". */
const slugFromPrdPath = (path: string): string => path.slice(PRD_DIR.length, -".md".length);

export type GateResult =
  | { kind: "ignored" }
  | { kind: "managed"; slug: string }
  | { kind: "blocked"; reason: string };

/**
 * The managed-PR gate: a PR is managed iff it ADDS exactly one `prds/*.md` AND
 * its head repo equals its base repo. 0 added PRDs -> ignored (a human's own
 * PR). 2+ added PRDs or a fork -> blocked.
 */
export const managedGate = (pr: PullRequest): GateResult => {
  const addedPrds = pr.changedFiles.filter((f) => f.status === "added" && isAddedPrd(f.path));
  if (addedPrds.length === 0) return { kind: "ignored" };
  if (pr.headRepo !== pr.baseRepo) return { kind: "blocked", reason: "PR is from a fork; only same-repo branches are supported." };
  if (addedPrds.length > 1) {
    return { kind: "blocked", reason: `PR adds ${addedPrds.length} PRDs; exactly one prds/*.md is required.` };
  }
  return { kind: "managed", slug: slugFromPrdPath(addedPrds[0].path) };
};

export type Stage =
  | { stage: "ignore" }
  | { stage: "block-malformed"; reason: string }
  | { stage: "plan"; slug: string }
  | { stage: "implement"; slug: string }
  | { stage: "review"; slug: string; headSha: string }
  | { stage: "fix"; slug: string }
  | { stage: "merge"; slug: string };

const DECISIVE: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED"]);

/**
 * Derive the lifecycle stage of a PR purely from its artifacts. Every service
 * acts only on the stage(s) it owns; a `blocked` PR is always `ignore`.
 */
export const deriveStage = (pr: PullRequest): Stage => {
  if (pr.labels.includes(BLOCKED_LABEL)) return { stage: "ignore" };

  const gate = managedGate(pr);
  if (gate.kind === "ignored") return { stage: "ignore" };
  if (gate.kind === "blocked") return { stage: "block-malformed", reason: gate.reason };

  const { slug } = gate;
  const hasPlan = pr.changedFiles.some((f) => f.path === planPath(slug));
  if (!hasPlan) return { stage: "plan", slug };

  const hasCode = pr.changedFiles.some((f) => !f.path.startsWith(PRD_DIR) && !f.path.startsWith(PLAN_DIR));
  if (!hasCode) return { stage: "implement", slug };

  // Code present: the load-bearing question is "is the current head reviewed?".
  const latest = [...pr.reviews].reverse().find((r) => DECISIVE.has(r.state));
  const headReviewed = latest !== undefined && latest.commitId === pr.headSha;
  if (!headReviewed) return { stage: "review", slug, headSha: pr.headSha };
  if (latest.state === "CHANGES_REQUESTED") return { stage: "fix", slug };
  if (latest.state === "APPROVED") return { stage: "merge", slug };
  return { stage: "ignore" };
};
