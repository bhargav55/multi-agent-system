import { describe, expect, it } from "vitest";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/agent/runner";
import type { ChangedFile } from "../src/github/pr-client";
import { MockGitHubClient } from "../src/github/pr-mock";
import { createLogger } from "../src/logger";
import { planPath } from "../src/runtime/derive";
import type { Workspace } from "../src/runtime/workspace";
import { PlannerService, parsePlanResult } from "../src/services/planner";

const silent = createLogger({}, { out: () => {}, err: () => {} });
const added = (path: string): ChangedFile => ({ path, status: "added" });

const result = (structured: unknown): AgentResult => ({
  text: "",
  structured,
  numTurns: 1,
  costUsd: 0.01,
  durationMs: 10,
});

/** A runner that records the last request and returns a fixed structured output. */
const capturingRunner = (structured: unknown) => {
  const calls: AgentRequest[] = [];
  const runner: AgentRunner = async (req) => {
    calls.push(req);
    return result(structured);
  };
  return { runner, calls };
};

/** A fake workspace that hands out a fixed dir and records clone/cleanup. */
const fakeWorkspace = () => {
  const ws: Workspace & { cloned: string[]; cleaned: string[] } = {
    cloned: [],
    cleaned: [],
    async prepareExisting(branch: string) {
      this.cloned.push(branch);
      return { dir: "/tmp/clone" };
    },
    async runTests() {
      throw new Error("planner must not run tests");
    },
    async hasChanges() {
      return false;
    },
    async currentSha() {
      return "sha";
    },
    async commitAll() {
      throw new Error("planner must not commit via git");
    },
    async push() {
      throw new Error("planner must not push");
    },
    async cleanup(dir: string) {
      this.cleaned.push(dir);
    },
  };
  return ws;
};

const planned = {
  outcome: "planned",
  decisions: ["Use the existing seam"],
  phases: [{ name: "Slice one", whatToBuild: "Build the thing.", acceptanceCriteria: ["It works", "Tests pass"] }],
};

describe("parsePlanResult", () => {
  it("accepts a planned result with phases", () => {
    const r = parsePlanResult(planned);
    expect(r.outcome).toBe("planned");
  });
  it("accepts a blocked result", () => {
    expect(parsePlanResult({ outcome: "blocked", reason: "impossible" })).toEqual({
      outcome: "blocked",
      reason: "impossible",
    });
  });
  it("rejects a planned result with no phases", () => {
    expect(() => parsePlanResult({ outcome: "planned", phases: [] })).toThrow(/at least one phase/);
  });
  it("rejects a phase with no acceptance criteria", () => {
    expect(() =>
      parsePlanResult({ outcome: "planned", phases: [{ name: "x", whatToBuild: "y", acceptanceCriteria: [] }] }),
    ).toThrow(/acceptance criterion/);
  });
});

describe("PlannerService", () => {
  it("commits exactly one plan file with header + phase checkboxes and sets the projection", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ headRef: "feature/x", body: "PRD body", changedFiles: [added("prds/x.md")] });
    const { runner } = capturingRunner(planned);

    const out = await new PlannerService(gh, runner, fakeWorkspace(), "m", silent).runOnce();

    expect(out).toEqual({ planned: 1, blocked: 0, errored: 0 });
    expect(gh.commits).toHaveLength(1);
    const commit = gh.commits[0];
    expect(commit).toMatchObject({ branch: "feature/x", path: planPath("x") });
    expect(commit.content).toContain("## Architectural decisions");
    expect(commit.content).toContain("## Phase 1: Slice one");
    expect(commit.content).toContain("- [ ] It works");
    expect(gh.get(n).labels).toContain("status:ready");
  });

  it("explores read-only: read tools allowed, mutating tools disallowed, no bypass", async () => {
    const gh = new MockGitHubClient();
    gh.seed({ headRef: "feature/x", body: "PRD", changedFiles: [added("prds/x.md")] });
    const { runner, calls } = capturingRunner(planned);
    const ws = fakeWorkspace();

    await new PlannerService(gh, runner, ws, "m", silent).runOnce();

    expect(ws.cloned).toEqual(["feature/x"]);
    expect(ws.cleaned).toEqual(["/tmp/clone"]);
    const req = calls[0];
    expect(req.cwd).toBe("/tmp/clone");
    expect(req.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(req.disallowedTools).toContain("Bash");
    expect(req.permissionMode).toBeUndefined();
  });

  it("skips a PR that already has a plan", async () => {
    const gh = new MockGitHubClient();
    gh.seed({ headRef: "feature/x", changedFiles: [added("prds/x.md"), added(planPath("x"))] });
    const { runner, calls } = capturingRunner(planned);

    const out = await new PlannerService(gh, runner, fakeWorkspace(), "m", silent).runOnce();

    expect(calls).toHaveLength(0);
    expect(out.planned).toBe(0);
  });

  it("blocks an un-plannable PRD with a comment and no commit", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ changedFiles: [added("prds/x.md")] });
    const { runner } = capturingRunner({ outcome: "blocked", reason: "contradictory" });

    const out = await new PlannerService(gh, runner, fakeWorkspace(), "m", silent).runOnce();

    expect(out.blocked).toBe(1);
    expect(gh.get(n).labels).toContain("blocked");
    expect(gh.commits).toHaveLength(0);
    expect(gh.comments.some((c) => c.body.includes("contradictory"))).toBe(true);
  });

  it("parks a malformed PR (two PRDs) without running the agent", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ changedFiles: [added("prds/a.md"), added("prds/b.md")] });
    const { runner, calls } = capturingRunner(planned);

    const out = await new PlannerService(gh, runner, fakeWorkspace(), "m", silent).runOnce();

    expect(out.blocked).toBe(1);
    expect(calls).toHaveLength(0);
    expect(gh.get(n).labels).toContain("blocked");
  });

  it("does not label on an infra error and leaves the PR to re-fire", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ changedFiles: [added("prds/x.md")] });
    gh.commitFile = async () => {
      throw new Error("network down");
    };
    const { runner } = capturingRunner(planned);

    const out = await new PlannerService(gh, runner, fakeWorkspace(), "m", silent).runOnce();

    expect(out).toEqual({ planned: 0, blocked: 0, errored: 1 });
    expect(gh.get(n).labels).not.toContain("blocked");
  });
});
