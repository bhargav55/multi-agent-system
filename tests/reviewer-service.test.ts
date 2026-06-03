import { describe, expect, it } from "vitest";
import type { AgentResult, AgentRunner } from "../src/agent/runner";
import type { ChangedFile, Review } from "../src/github/pr-client";
import { MockGitHubClient } from "../src/github/pr-mock";
import { createLogger } from "../src/logger";
import { planPath } from "../src/runtime/derive";
import { FIX_ROUND_CAP, ReviewerService, parseReviewResult } from "../src/services/reviewer";

const silent = createLogger({}, { out: () => {}, err: () => {} });
const added = (path: string): ChangedFile => ({ path, status: "added" });

const result = (structured: unknown): AgentResult => ({
  text: "",
  structured,
  numTurns: 1,
  costUsd: 0.02,
  durationMs: 10,
});
const runnerReturning = (structured: unknown): AgentRunner => async () => result(structured);

const review = (commitId: string, author: string): Review => ({
  state: "CHANGES_REQUESTED",
  commitId,
  author,
  body: "fix it",
});

const approve = { decision: "approve", summary: "meets all acceptance criteria", findings: [] };
const requestChanges = { decision: "request_changes", summary: "missing tests", findings: ["add an error-path test"] };

/** Seed a needs-review PR (code + plan, head unreviewed), with optional prior reviews. */
const seedReview = (gh: MockGitHubClient, reviews: Review[] = [], headSha = "head1") =>
  gh.seed({
    headRef: "feature/x",
    headSha,
    changedFiles: [added("prds/x.md"), added(planPath("x")), added("src/x.ts")],
    reviews,
  });

describe("parseReviewResult", () => {
  it("accepts approve and request_changes", () => {
    expect(parseReviewResult(approve).decision).toBe("approve");
    expect(parseReviewResult(requestChanges).findings).toHaveLength(1);
  });
  it("rejects an unknown decision", () => {
    expect(() => parseReviewResult({ decision: "maybe", summary: "x", findings: [] })).toThrow(/decision/);
  });
});

describe("ReviewerService", () => {
  it("approves with a review pinned to the captured head SHA and sets the projection", async () => {
    const gh = new MockGitHubClient();
    const n = seedReview(gh);
    const out = await new ReviewerService(gh, runnerReturning(approve), "m", silent).runOnce();

    expect(out).toEqual({ approved: 1, changesRequested: 0, blocked: 0, errored: 0 });
    expect(gh.reviews).toEqual([{ number: n, commitId: "head1", event: "APPROVE", body: expect.any(String) }]);
    expect(gh.get(n).labels).toContain("status:ready-for-human");
  });

  it("requests changes below the cap, pins the SHA, and applies no label", async () => {
    const gh = new MockGitHubClient();
    const n = seedReview(gh);
    const out = await new ReviewerService(gh, runnerReturning(requestChanges), "m", silent).runOnce();

    expect(out.changesRequested).toBe(1);
    expect(gh.reviews[0]).toMatchObject({ number: n, commitId: "head1", event: "REQUEST_CHANGES" });
    expect(gh.get(n).labels).not.toContain("blocked");
    expect(gh.get(n).labels).toContain("status:needs-fixes");
  });

  it("blocks on the third own changes-requested review and still submits it", async () => {
    const gh = new MockGitHubClient();
    // Two prior OWN changes-requested reviews on older SHAs (so head is still unreviewed).
    const prior = [review("old1", "agent-bot"), review("old2", "agent-bot")];
    const n = seedReview(gh, prior, "head3");
    const out = await new ReviewerService(gh, runnerReturning(requestChanges), "m", silent).review(
      gh.get(n),
      "x",
      "head3",
    );

    expect(out).toEqual({ outcome: "blocked", reason: "fix-round cap reached" });
    expect(gh.reviews).toHaveLength(1); // the third CR was submitted
    expect(gh.reviews[0]).toMatchObject({ commitId: "head3", event: "REQUEST_CHANGES" });
    expect(gh.get(n).labels).toContain("blocked");
    expect(gh.comments.some((c) => c.body.includes(`cap ${FIX_ROUND_CAP}`))).toBe(true);
  });

  it("does not count a human's changes-requested review toward the cap", async () => {
    const gh = new MockGitHubClient();
    // Two CR reviews authored by a human — these must not consume fix rounds.
    const prior = [review("old1", "human-dev"), review("old2", "human-dev")];
    const n = seedReview(gh, prior, "head3");
    const out = await new ReviewerService(gh, runnerReturning(requestChanges), "m", silent).review(
      gh.get(n),
      "x",
      "head3",
    );

    expect(out).toEqual({ outcome: "changes-requested", round: 1 });
    expect(gh.get(n).labels).not.toContain("blocked");
  });

  it("fetches the diff for the exact captured SHA", async () => {
    const gh = new MockGitHubClient();
    const n = seedReview(gh);
    gh.setDiff(n, "head1", "the diff at head1");
    let seenPrompt = "";
    const runner: AgentRunner = async (req) => {
      seenPrompt = req.prompt;
      return result(approve);
    };
    await new ReviewerService(gh, runner, "m", silent).runOnce();
    expect(seenPrompt).toContain("the diff at head1");
  });
});
