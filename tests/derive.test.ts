import { describe, expect, it } from "vitest";
import type { ChangedFile, Review } from "../src/github/pr-client";
import { MockGitHubClient } from "../src/github/pr-mock";
import {
  BLOCKED_LABEL,
  deriveStage,
  managedGate,
  planPath,
  prdPath,
} from "../src/runtime/derive";

const added = (path: string): ChangedFile => ({ path, status: "added" });
const modified = (path: string): ChangedFile => ({ path, status: "modified" });

const review = (state: Review["state"], commitId: string, author = "agent-bot"): Review => ({
  state,
  commitId,
  author,
  body: "",
});

/** Build a bare PR object (defaults: same-repo, no files, no reviews). */
const pr = (over: Partial<Parameters<typeof deriveStage>[0]> = {}) => ({
  number: 1,
  headSha: "head1",
  headRef: "feature/x",
  headRepo: "acme/repo",
  baseRepo: "acme/repo",
  url: "u",
  body: "",
  labels: [],
  changedFiles: [],
  reviews: [],
  ...over,
});

describe("managedGate", () => {
  it("ignores a PR that adds no PRD", () => {
    expect(managedGate(pr({ changedFiles: [modified("src/a.ts")] }))).toEqual({ kind: "ignored" });
  });

  it("ignores when a prds file is only modified, not added", () => {
    expect(managedGate(pr({ changedFiles: [modified("prds/foo.md")] }))).toEqual({ kind: "ignored" });
  });

  it("derives slug from the added PRD basename", () => {
    expect(managedGate(pr({ changedFiles: [added("prds/foo-bar.md")] }))).toEqual({
      kind: "managed",
      slug: "foo-bar",
    });
  });

  it("blocks a PR adding two or more PRDs", () => {
    const g = managedGate(pr({ changedFiles: [added("prds/a.md"), added("prds/b.md")] }));
    expect(g.kind).toBe("blocked");
  });

  it("blocks a fork (headRepo !== baseRepo) even with one PRD", () => {
    const g = managedGate(pr({ changedFiles: [added("prds/a.md")], headRepo: "fork/repo", baseRepo: "acme/repo" }));
    expect(g.kind).toBe("blocked");
  });
});

describe("deriveStage", () => {
  it("PRD with no plan -> plan", () => {
    expect(deriveStage(pr({ changedFiles: [added("prds/x.md")] }))).toEqual({ stage: "plan", slug: "x" });
  });

  it("PRD + plan but no code -> implement", () => {
    const files = [added("prds/x.md"), added(planPath("x"))];
    expect(deriveStage(pr({ changedFiles: files }))).toEqual({ stage: "implement", slug: "x" });
  });

  it("code present, head unreviewed -> review (pinned to head)", () => {
    const files = [added("prds/x.md"), added(planPath("x")), added("src/x.ts")];
    expect(deriveStage(pr({ changedFiles: files, headSha: "head1" }))).toEqual({
      stage: "review",
      slug: "x",
      headSha: "head1",
    });
  });

  it("stale review on an old SHA -> review again (self-healing)", () => {
    const files = [added("prds/x.md"), added(planPath("x")), added("src/x.ts")];
    const reviews = [review("APPROVED", "oldsha")];
    expect(deriveStage(pr({ changedFiles: files, headSha: "head2", reviews })).stage).toBe("review");
  });

  it("changes-requested on head -> fix", () => {
    const files = [added("prds/x.md"), added(planPath("x")), added("src/x.ts")];
    const reviews = [review("CHANGES_REQUESTED", "head1")];
    expect(deriveStage(pr({ changedFiles: files, headSha: "head1", reviews }))).toEqual({ stage: "fix", slug: "x" });
  });

  it("approved on head -> merge", () => {
    const files = [added("prds/x.md"), added(planPath("x")), added("src/x.ts")];
    const reviews = [review("APPROVED", "head1")];
    expect(deriveStage(pr({ changedFiles: files, headSha: "head1", reviews }))).toEqual({ stage: "merge", slug: "x" });
  });

  it("uses the latest decisive review, ignoring later COMMENTED noise", () => {
    const files = [added("prds/x.md"), added(planPath("x")), added("src/x.ts")];
    const reviews = [review("APPROVED", "head1"), review("COMMENTED", "head1")];
    expect(deriveStage(pr({ changedFiles: files, headSha: "head1", reviews })).stage).toBe("merge");
  });

  it("a blocked PR derives to ignore regardless of artifacts", () => {
    const files = [added("prds/x.md")];
    expect(deriveStage(pr({ changedFiles: files, labels: [BLOCKED_LABEL] }))).toEqual({ stage: "ignore" });
  });

  it("malformed (2 PRDs) -> block-malformed with a reason", () => {
    const out = deriveStage(pr({ changedFiles: [added("prds/a.md"), added("prds/b.md")] }));
    expect(out.stage).toBe("block-malformed");
  });

  it("plan path and prd path helpers are consistent", () => {
    expect(planPath("slug")).toBe("plans/slug.md");
    expect(prdPath("slug")).toBe("prds/slug.md");
  });
});

describe("MockGitHubClient", () => {
  it("seeds PRs and lists them with artifacts", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ changedFiles: [added("prds/x.md")], labels: ["blocked"] });
    const [listed] = await gh.listOpenPullRequests();
    expect(listed.number).toBe(n);
    expect(listed.changedFiles).toEqual([added("prds/x.md")]);
    expect(listed.labels).toContain("blocked");
  });

  it("records commits and reflects the new file onto the PR branch", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ headRef: "feature/x", changedFiles: [added("prds/x.md")] });
    await gh.commitFile("feature/x", planPath("x"), "plan", "Plan x");
    expect(gh.commits).toEqual([{ branch: "feature/x", path: planPath("x"), content: "plan", message: "Plan x" }]);
    expect(gh.get(n).changedFiles.some((f) => f.path === planPath("x"))).toBe(true);
  });

  it("records reviews, appends them to the PR, and requires a commitId", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed();
    await gh.submitReview(n, { commitId: "head1", event: "APPROVE", body: "lgtm" });
    expect(gh.reviews).toEqual([{ number: n, commitId: "head1", event: "APPROVE", body: "lgtm" }]);
    expect(gh.get(n).reviews[0]).toEqual({ state: "APPROVED", commitId: "head1", author: "agent-bot", body: "lgtm" });
    await expect(gh.submitReview(n, { commitId: "", event: "APPROVE", body: "" })).rejects.toThrow(/commitId/);
  });

  it("records labels, body, and comments", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed();
    await gh.addBlockedLabel(n);
    await gh.setStatusProjection(n, "status:needs-plan");
    await gh.setPullRequestBody(n, "the body");
    await gh.comment(n, "a comment");
    const got = gh.get(n);
    expect(got.labels).toEqual(expect.arrayContaining(["blocked", "status:needs-plan"]));
    expect(got.body).toBe("the body");
    expect(gh.comments).toEqual([{ number: n, body: "a comment" }]);
  });
});
