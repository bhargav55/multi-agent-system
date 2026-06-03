import { describe, expect, it } from "vitest";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/agent/runner";
import type { ChangedFile, Review } from "../src/github/pr-client";
import { MockGitHubClient } from "../src/github/pr-mock";
import { createLogger } from "../src/logger";
import { planPath } from "../src/runtime/derive";
import type { TestRun, Workspace } from "../src/runtime/workspace";
import { ImplementerService, parseImplementResult } from "../src/services/implementer";

const silent = createLogger({}, { out: () => {}, err: () => {} });
const added = (path: string): ChangedFile => ({ path, status: "added" });

const result = (structured: unknown): AgentResult => ({
  text: "",
  structured,
  numTurns: 1,
  costUsd: 0.05,
  durationMs: 10,
});

const capturingRunner = (structured: unknown) => {
  const calls: AgentRequest[] = [];
  const runner: AgentRunner = async (req) => {
    calls.push(req);
    return result(structured);
  };
  return { runner, calls };
};

type FakeOpts = {
  movedSha?: string; // currentSha after the agent runs; differs from headSha => commits made
  changes?: boolean; // uncommitted leftovers
  tests?: TestRun;
  prepareError?: boolean;
};

class FakeWorkspace implements Workspace {
  prepared?: string;
  commits: string[] = [];
  pushes: string[] = [];
  cleaned = false;
  constructor(private readonly opts: FakeOpts = {}) {}
  async prepareExisting(branch: string) {
    if (this.opts.prepareError) throw new Error("clone failed");
    this.prepared = branch;
    return { dir: "/tmp/impl" };
  }
  async runTests(): Promise<TestRun> {
    return this.opts.tests ?? { ok: true, command: "bun run test", output: "ok" };
  }
  async hasChanges() {
    return this.opts.changes ?? false;
  }
  async currentSha() {
    return this.opts.movedSha ?? "moved-sha";
  }
  async commitAll(_dir: string, message: string) {
    this.commits.push(message);
  }
  async push(_dir: string, branch: string) {
    this.pushes.push(branch);
  }
  async cleanup() {
    this.cleaned = true;
  }
}

const implemented = { outcome: "implemented", summary: "Added the thing", notes: ["watch X"] };

const review = (state: Review["state"], commitId: string, body = "", author = "agent-bot"): Review => ({
  state,
  commitId,
  author,
  body,
});

/** Seed a needs-impl PR (PRD + plan, no code). */
const seedImpl = (gh: MockGitHubClient) =>
  gh.seed({ headRef: "feature/x", headSha: "head1", changedFiles: [added("prds/x.md"), added(planPath("x"))] });

describe("parseImplementResult", () => {
  it("accepts implemented and blocked", () => {
    expect(parseImplementResult(implemented).outcome).toBe("implemented");
    expect(parseImplementResult({ outcome: "blocked", summary: "no", notes: [] }).outcome).toBe("blocked");
  });
  it("rejects an empty summary", () => {
    expect(() => parseImplementResult({ outcome: "implemented", summary: "", notes: [] })).toThrow(/summary/);
  });
});

describe("ImplementerService — new mode", () => {
  it("pushes once after the gate passes and owns the PR body with PRD/plan links", async () => {
    const gh = new MockGitHubClient();
    const n = seedImpl(gh);
    const ws = new FakeWorkspace();
    const { runner } = capturingRunner(implemented);

    const out = await new ImplementerService(gh, runner, ws, "m", silent).runOnce();

    expect(out).toEqual({ implemented: 1, blocked: 0, errored: 0 });
    expect(ws.pushes).toEqual(["feature/x"]);
    const body = gh.get(n).body;
    expect(body).toContain("## What");
    expect(body).toContain("`prds/x.md`");
    expect(body).toContain("`plans/x.md`");
    expect(gh.get(n).labels).toContain("status:in-review");
    expect(gh.get(n).labels).not.toContain("blocked");
  });

  it("blocks and never pushes when the agent makes no changes", async () => {
    const gh = new MockGitHubClient();
    const n = seedImpl(gh);
    const ws = new FakeWorkspace({ movedSha: "head1", changes: false }); // sha unchanged, clean tree
    const { runner } = capturingRunner(implemented);

    const out = await new ImplementerService(gh, runner, ws, "m", silent).runOnce();

    expect(out.blocked).toBe(1);
    expect(ws.pushes).toEqual([]);
    expect(gh.get(n).labels).toContain("blocked");
  });

  it("blocks and never pushes when tests fail on the final tree", async () => {
    const gh = new MockGitHubClient();
    const n = seedImpl(gh);
    const ws = new FakeWorkspace({ tests: { ok: false, command: "bun run test", output: "boom" } });
    const { runner } = capturingRunner(implemented);

    const out = await new ImplementerService(gh, runner, ws, "m", silent).runOnce();

    expect(out.blocked).toBe(1);
    expect(ws.pushes).toEqual([]);
    expect(gh.get(n).labels).toContain("blocked");
  });

  it("blocks when the agent reports blocked", async () => {
    const gh = new MockGitHubClient();
    const n = seedImpl(gh);
    const { runner } = capturingRunner({ outcome: "blocked", summary: "plan contradicts itself", notes: [] });

    const out = await new ImplementerService(gh, runner, new FakeWorkspace(), "m", silent).runOnce();

    expect(out.blocked).toBe(1);
    expect(gh.get(n).labels).toContain("blocked");
  });

  it("does not label on an infra (clone) error and retries next poll", async () => {
    const gh = new MockGitHubClient();
    const n = seedImpl(gh);
    const ws = new FakeWorkspace({ prepareError: true });
    const { runner } = capturingRunner(implemented);

    const out = await new ImplementerService(gh, runner, ws, "m", silent).runOnce();

    expect(out).toEqual({ implemented: 0, blocked: 0, errored: 1 });
    expect(gh.get(n).labels).not.toContain("blocked");
  });

  it("commits leftover uncommitted changes before gating", async () => {
    const gh = new MockGitHubClient();
    seedImpl(gh);
    const ws = new FakeWorkspace({ changes: true });
    const { runner } = capturingRunner(implemented);

    await new ImplementerService(gh, runner, ws, "m", silent).runOnce();

    expect(ws.commits).toEqual(["Implement x"]);
    expect(ws.pushes).toEqual(["feature/x"]);
  });
});

describe("ImplementerService — fix mode", () => {
  it("builds the prompt from the latest changes-requested review body and pushes once", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({
      headRef: "feature/x",
      headSha: "head2",
      changedFiles: [added("prds/x.md"), added(planPath("x")), added("src/x.ts")],
      reviews: [review("CHANGES_REQUESTED", "head2", "Please add a test for the error path.")],
    });
    const ws = new FakeWorkspace();
    const { runner, calls } = capturingRunner(implemented);

    const out = await new ImplementerService(gh, runner, ws, "m", silent).runOnce();

    expect(out).toEqual({ implemented: 1, blocked: 0, errored: 0 });
    expect(calls[0].prompt).toContain("Please add a test for the error path.");
    expect(ws.pushes).toEqual(["feature/x"]);
    // Fix mode does not rewrite the body it already owns.
    expect(gh.get(n).body).toBe("");
  });
});
