import { describe, expect, it } from "vitest";
import type { AgentResult, AgentRunner } from "../src/agent/runner";
import { MockGitHubClient } from "../src/github/mock-client";
import { createLogger } from "../src/logger";
import { ImplementerAgent, parseImplementResult } from "../src/runtime/implementer";
import { branchForIssue } from "../src/runtime/naming";
import { discoverTestCommand, type TestRun, type Workspace } from "../src/runtime/workspace";

const silent = createLogger({}, { out: () => {}, err: () => {} });

const result = (structured: unknown): AgentResult => ({
  text: "",
  structured,
  numTurns: 1,
  costUsd: 0.05,
  durationMs: 10,
});

const runnerReturning = (structured: unknown): AgentRunner => async () => result(structured);

class FakeWorkspace implements Workspace {
  prepared?: string;
  committed?: string;
  pushed?: string;
  cleaned = false;
  constructor(private readonly opts: { changes?: boolean; tests?: TestRun; prepareError?: boolean } = {}) {}
  async prepareExisting(branch: string) {
    if (this.opts.prepareError) throw new Error("clone failed");
    this.prepared = branch;
    return { dir: "/tmp/fake" };
  }
  async runTests(): Promise<TestRun> {
    return this.opts.tests ?? { ok: true, command: "bun test", output: "ok" };
  }
  async hasChanges() {
    return this.opts.changes ?? true;
  }
  async commitAll(_dir: string, message: string) {
    this.committed = message;
  }
  async push(_dir: string, branch: string) {
    this.pushed = branch;
  }
  async cleanup() {
    this.cleaned = true;
  }
}

const implemented = { outcome: "implemented", summary: "Added the thing", notes: ["watch X"] };

/** Seed a ready feature whose plan branch the planner already prepared. */
const seedReady = async (gh: MockGitHubClient, title = "Add health endpoint") => {
  const n = gh.seed({ title, body: "Expose a health check", status: "ready", kind: "feature" });
  await gh.openPlanBranch(branchForIssue({ number: n, title }), `plans/issue-${n}.md`, "# plan", "Plan");
  return n;
};

describe("parseImplementResult", () => {
  it("accepts implemented and blocked outcomes", () => {
    expect(parseImplementResult(implemented).outcome).toBe("implemented");
    expect(parseImplementResult({ outcome: "blocked", summary: "too vague", notes: [] }).outcome).toBe("blocked");
  });
  it("rejects bad outcomes and empty summaries", () => {
    expect(() => parseImplementResult({ outcome: "done", summary: "x", notes: [] })).toThrow(/outcome/);
    expect(() => parseImplementResult({ outcome: "implemented", summary: "", notes: [] })).toThrow(/summary/);
  });
});

describe("discoverTestCommand", () => {
  it("prefers env override, then package script, then default", () => {
    expect(discoverTestCommand(null, { TEST_COMMAND: "make test" } as NodeJS.ProcessEnv)).toBe("make test");
    expect(discoverTestCommand({ scripts: { test: "vitest" } }, {} as NodeJS.ProcessEnv)).toBe("bun run test");
    expect(discoverTestCommand({ scripts: {} }, {} as NodeJS.ProcessEnv)).toBe("bun test");
  });
});

describe("ImplementerAgent", () => {
  it("implements on the plan branch, tests, pushes, and opens a PR", async () => {
    const gh = new MockGitHubClient();
    const n = await seedReady(gh);
    const ws = new FakeWorkspace();

    const out = await new ImplementerAgent(gh, runnerReturning(implemented), ws, "claude-opus-4-8", silent).implementIssue(
      await gh.getIssue(n),
    );

    expect(out.outcome).toBe("in-review");
    expect(ws.prepared).toBe(`task/${n}-add-health-endpoint`);
    expect(ws.pushed).toBe(`task/${n}-add-health-endpoint`);
    expect(ws.committed).toContain(`Closes #${n}`);
    expect(ws.cleaned).toBe(true);
    expect((await gh.getIssue(n)).status).toBe("in-review");
    const pr = await gh.findPullRequestForIssue(n);
    expect(pr?.body).toContain("`bun test` passed.");
    expect(pr?.body).toContain(`plans/issue-${n}.md`);
  });

  it("blocks when the agent reports blocked", async () => {
    const gh = new MockGitHubClient();
    const n = await seedReady(gh);
    const ws = new FakeWorkspace();
    const agent = new ImplementerAgent(gh, runnerReturning({ outcome: "blocked", summary: "ambiguous", notes: [] }), ws, "m", silent);

    const out = await agent.implementIssue(await gh.getIssue(n));
    expect(out.outcome).toBe("blocked");
    expect((await gh.getIssue(n)).status).toBe("blocked");
    expect(ws.pushed).toBeUndefined();
    expect(await gh.findPullRequestForIssue(n)).toBeNull();
  });

  it("blocks when no changes were produced", async () => {
    const gh = new MockGitHubClient();
    const n = await seedReady(gh);
    const ws = new FakeWorkspace({ changes: false });
    const out = await new ImplementerAgent(gh, runnerReturning(implemented), ws, "m", silent).implementIssue(await gh.getIssue(n));

    expect(out.outcome).toBe("blocked");
    expect((await gh.getIssue(n)).status).toBe("blocked");
    expect(ws.pushed).toBeUndefined();
  });

  it("blocks (no PR) when the project's tests fail", async () => {
    const gh = new MockGitHubClient();
    const n = await seedReady(gh);
    const ws = new FakeWorkspace({ tests: { ok: false, command: "bun test", output: "1 failed" } });
    const out = await new ImplementerAgent(gh, runnerReturning(implemented), ws, "m", silent).implementIssue(await gh.getIssue(n));

    expect(out.outcome).toBe("blocked");
    expect((await gh.getIssue(n)).status).toBe("blocked");
    expect(ws.pushed).toBeUndefined();
    expect(await gh.findPullRequestForIssue(n)).toBeNull();
  });

  it("returns the issue to ready on an infrastructure error", async () => {
    const gh = new MockGitHubClient();
    const n = await seedReady(gh);
    const ws = new FakeWorkspace({ prepareError: true });
    const agent = new ImplementerAgent(gh, runnerReturning(implemented), ws, "m", silent);

    await expect(agent.implementIssue(await gh.getIssue(n))).rejects.toThrow(/clone failed/);
    expect((await gh.getIssue(n)).status).toBe("ready");
  });

  it("applies review fixes on the existing branch and returns to in-review", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ title: "Add health endpoint", body: "PRD", status: "needs-fixes", kind: "feature" });
    const branch = branchForIssue({ number: n, title: "Add health endpoint" });
    await gh.openPullRequest({ title: "impl", body: "Closes", head: branch, base: "main", linkedIssue: n });
    await gh.requestChanges(n, "- **major**: handle the error path");
    const ws = new FakeWorkspace();

    const out = await new ImplementerAgent(gh, runnerReturning(implemented), ws, "m", silent).applyFixes(await gh.getIssue(n));

    expect(out.outcome).toBe("in-review");
    expect(ws.pushed).toBe(branch);
    expect((await gh.getIssue(n)).status).toBe("in-review");
  });

  it("returns a fix issue to needs-fixes on an infrastructure error", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ title: "t", body: "PRD", status: "needs-fixes", kind: "feature" });
    const ws = new FakeWorkspace({ prepareError: true });

    await expect(new ImplementerAgent(gh, runnerReturning(implemented), ws, "m", silent).applyFixes(await gh.getIssue(n))).rejects.toThrow();
    expect((await gh.getIssue(n)).status).toBe("needs-fixes");
  });

  it("drains both ready and needs-fixes issues in one cycle", async () => {
    const gh = new MockGitHubClient();
    await seedReady(gh);
    const fix = gh.seed({ title: "second", body: "PRD", status: "needs-fixes", kind: "bug" });
    await gh.openPullRequest({ title: "impl", body: "x", head: branchForIssue({ number: fix, title: "second" }), base: "main", linkedIssue: fix });
    const agent = new ImplementerAgent(gh, runnerReturning(implemented), new FakeWorkspace(), "m", silent);

    const summary = await agent.runOnce();
    expect(summary).toEqual({ implemented: 2, blocked: 0, errored: 0 });
  });
});
