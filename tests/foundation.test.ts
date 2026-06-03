import { describe, expect, it } from "vitest";
import {
  fixRoundFromLabels,
  fixRoundLabel,
  kindFromLabel,
  kindLabel,
  loadConfig,
  statusFromLabel,
  statusLabel,
} from "../src/config";
import { MockGitHubClient } from "../src/github/mock-client";

describe("label helpers", () => {
  it("round-trips status labels", () => {
    expect(statusLabel("in-review")).toBe("status:in-review");
    expect(statusFromLabel("status:in-review")).toBe("in-review");
    expect(statusFromLabel("status:bogus")).toBeNull();
    expect(statusFromLabel("type:feature")).toBeNull();
  });

  it("round-trips kind labels", () => {
    expect(kindLabel("feature")).toBe("type:feature");
    expect(kindFromLabel("type:feature")).toBe("feature");
    expect(kindFromLabel("type:task")).toBeNull();
    expect(kindFromLabel("status:ready")).toBeNull();
  });

  it("reads the fix-round counter from labels", () => {
    expect(fixRoundFromLabels(["type:bug", "status:needs-fixes"])).toBe(0);
    expect(fixRoundFromLabels(["type:bug", fixRoundLabel(2)])).toBe(2);
  });
});

describe("loadConfig", () => {
  const base = { AGENT_ROLE: "planner", GITHUB_REPO: "acme/multi-agent-system", GITHUB_TOKEN: "t" };

  it("parses a valid environment with role defaults", () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv);
    expect(cfg.repo).toEqual({ owner: "acme", repo: "multi-agent-system" });
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.pollIntervalMs).toBe(30 * 60_000);
    expect(cfg.base).toBe("main");
  });

  it("rejects a bad role and a malformed repo", () => {
    expect(() => loadConfig({ ...base, AGENT_ROLE: "nope" } as NodeJS.ProcessEnv)).toThrow(/AGENT_ROLE/);
    expect(() => loadConfig({ ...base, GITHUB_REPO: "noslash" } as NodeJS.ProcessEnv)).toThrow(/owner\/repo/);
  });
});

describe("MockGitHubClient", () => {
  it("filters issues by status and kind", async () => {
    const gh = new MockGitHubClient();
    gh.seed({ title: "feature A", status: "needs-plan", kind: "feature" });
    gh.seed({ title: "bug B", status: "ready", kind: "bug" });

    const toPlan = await gh.listIssuesByStatus("needs-plan");
    expect(toPlan.map((i) => i.title)).toEqual(["feature A"]);

    const ready = await gh.listIssuesByStatus("ready", "bug");
    expect(ready.map((i) => i.title)).toEqual(["bug B"]);
  });

  it("commits a plan branch and reflects updates", async () => {
    const gh = new MockGitHubClient();
    await gh.openPlanBranch("task/1-x", "plans/issue-1.md", "v1", "Plan issue #1");
    expect(gh.planBranch("task/1-x")).toMatchObject({ path: "plans/issue-1.md", content: "v1" });

    await gh.openPlanBranch("task/1-x", "plans/issue-1.md", "v2", "Re-plan issue #1");
    expect(gh.planBranch("task/1-x")?.content).toBe("v2");
  });

  it("transitions status by replacing the status label", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ title: "feature", status: "ready", kind: "feature" });

    await gh.setStatus(n, "in-progress");
    const issue = await gh.getIssue(n);
    expect(issue.status).toBe("in-progress");
    expect(issue.labels.filter((l) => l.startsWith("status:"))).toEqual(["status:in-progress"]);
  });

  it("replaces the fix-round counter rather than accumulating", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ title: "feature", status: "needs-fixes", kind: "feature" });

    await gh.setFixRound(n, 1);
    await gh.setFixRound(n, 2);
    const issue = await gh.getIssue(n);
    expect(issue.labels.filter((l) => l.startsWith("fix-round:"))).toEqual(["fix-round:2"]);
    expect(fixRoundFromLabels(issue.labels)).toBe(2);
  });

  it("links a PR to its issue and exposes a diff", async () => {
    const gh = new MockGitHubClient();
    const issue = gh.seed({ title: "feature", status: "in-progress", kind: "feature" });

    const pr = await gh.openPullRequest({
      title: "implement feature",
      body: `Closes #${issue}`,
      head: `task/${issue}-thing`,
      base: "main",
      linkedIssue: issue,
    });

    expect(await gh.findPullRequestForIssue(issue)).toMatchObject({ number: pr.number });
    expect(await gh.findPullRequestForIssue(999)).toBeNull();
    expect(await gh.getPullRequestDiff(pr.number)).toContain(`task/${issue}-thing -> main`);
  });
});
