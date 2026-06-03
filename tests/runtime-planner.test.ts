import { describe, expect, it } from "vitest";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/agent/runner";
import { MockGitHubClient } from "../src/github/mock-client";
import { createLogger } from "../src/logger";
import { PlannerAgent, parsePlan, renderPlan } from "../src/runtime/planner";
import { branchForIssue, planPath } from "../src/runtime/naming";

const silent = createLogger({}, { out: () => {}, err: () => {} });

const result = (structured: unknown): AgentResult => ({
  text: JSON.stringify(structured),
  structured,
  numTurns: 1,
  costUsd: 0.01,
  durationMs: 10,
});

const runnerReturning = (structured: unknown): { runner: AgentRunner; calls: AgentRequest[] } => {
  const calls: AgentRequest[] = [];
  return { calls, runner: async (req) => (calls.push(req), result(structured)) };
};

const plan = {
  overview: "Add a health endpoint and wire it into the router.",
  steps: ["Add GET /health handler returning {status:'ok'}", "Register the route", "Add a handler test"],
  testStrategy: ["unit test the 200 response"],
  outOfScope: ["auth"],
};

describe("parsePlan", () => {
  it("accepts a well-formed plan", () => {
    expect(parsePlan(plan).steps).toHaveLength(3);
  });
  it("rejects empty or malformed plans", () => {
    expect(() => parsePlan({ overview: "", steps: ["x"], testStrategy: [], outOfScope: [] })).toThrow(/overview/);
    expect(() => parsePlan({ overview: "ok", steps: [], testStrategy: [], outOfScope: [] })).toThrow(/step/);
    expect(() => parsePlan({})).toThrow();
  });
});

describe("renderPlan", () => {
  it("renders the plan to markdown sections", () => {
    const md = renderPlan({ number: 7, title: "Health", body: "", labels: [], status: null, kind: null, url: "" }, plan);
    expect(md).toContain("# Implementation Plan — Issue #7: Health");
    expect(md).toContain("## Steps");
    expect(md).toContain("## Out of Scope");
  });
});

describe("PlannerAgent", () => {
  it("commits the plan to the task branch and marks the issue ready", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ title: "Health checks", body: "Add health", status: "needs-plan", kind: "feature" });
    const { runner, calls } = runnerReturning(plan);

    await new PlannerAgent(gh, runner, "claude-sonnet-4-6", silent).planIssue(await gh.getIssue(n));

    expect(calls[0].jsonSchema).toBeDefined();
    expect(calls[0].model).toBe("claude-sonnet-4-6");

    const issue = await gh.getIssue(n);
    expect(issue.status).toBe("ready");

    const branch = branchForIssue(issue);
    const committed = gh.planBranch(branch);
    expect(committed?.path).toBe(planPath(issue));
    expect(committed?.content).toContain("## Steps");
  });

  it("drains all needs-plan issues in one cycle", async () => {
    const gh = new MockGitHubClient();
    gh.seed({ title: "F1", status: "needs-plan", kind: "feature" });
    gh.seed({ title: "F2", status: "needs-plan", kind: "bug" });
    gh.seed({ title: "already ready", status: "ready", kind: "feature" });
    const { runner } = runnerReturning(plan);

    const summary = await new PlannerAgent(gh, runner, "m", silent).runOnce();
    expect(summary).toEqual({ planned: 2, failed: 0 });
    expect((await gh.listIssuesByStatus("needs-plan")).length).toBe(0);
  });

  it("leaves the issue in needs-plan when planning fails", async () => {
    const gh = new MockGitHubClient();
    const n = gh.seed({ title: "F", status: "needs-plan", kind: "feature" });
    const failing: AgentRunner = async () => result({ overview: "x", steps: [] }); // invalid -> parse throws

    const agent = new PlannerAgent(gh, failing, "m", silent);
    await expect(agent.planIssue(await gh.getIssue(n))).rejects.toThrow();
    expect((await gh.getIssue(n)).status).toBe("needs-plan");
  });
});
