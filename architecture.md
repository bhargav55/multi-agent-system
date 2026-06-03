# Architecture

## Goal

A production-grade multi-agent workflow system where specialized agents plan,
implement, and review engineering work. **GitHub is the system of record** —
issues are the work, GitHub Projects is the board, and pull requests are the
deliverable. Agents do the work autonomously; humans validate the final
implementation before merging.

> See `interview-grill.md` for the decision record behind this design.

## Current State vs Target

The v1 runtime described below is **implemented** under `src/runtime/`,
`src/github/`, and `src/agent/`, driven by the Claude Agent SDK and built
against a mockable `GitHubClient` (so all agent logic is unit-tested without
live API calls). `src/main.ts` is the single role-dispatching entrypoint.

What remains before it runs live is **infra the human provisions** (the GitHub
App, the Railway services, and the Projects board) plus live verification of the
Octokit client against the real API. The **earlier local-first prototype**
(`src/agents/planner.ts`, `src/kanban/*`, `src/brief.ts`, the `board.json`
plumbing, and the old CLI) is retained for now and will be removed once the new
loop is proven (interview-grill.md, decision 13).

## System Boundary

```txt
GitHub issue (feature or bug) — the issue body is the human-authored PRD
  -> Planner agent      (reads the PRD, commits plans/issue-N.md to the task branch)
  -> Implementer agent  (checks out the branch, follows the plan, opens one PR)
  -> Reviewer agent      (reviews the PR against the PRD + plan + tests)
  -> Human               (final review + merge)
```

There are **no sub-issues** (decision 14): one issue is delivered as one PR.
Everything lives in a **single repository** for v1: issues, plan files, code,
and pull requests. Cross-repo orchestration is deferred.

## Source of Truth

GitHub holds all work state. There is **no separate task database**.

- **Issue** = a feature request or bug; its body is the **PRD** (human-authored).
- **Plan file** (`plans/issue-<N>.md`) = the planner's implementation plan,
  committed to the issue's task branch and carried into the PR.
- **Status label** = the workflow state (the Kanban column).
- **Pull request** = the implementer's output, linked to the issue.

GitHub Projects is a *view* over these — the human-facing Kanban board — not a
second store, so there is nothing to keep in sync.

## Status State Machine

State lives entirely on the **issue** as a `status:*` label:

```txt
needs-plan      -> a new issue (PRD) awaiting a plan
ready           -> plan committed; ready to be implemented
in-progress     -> claimed by the planner/implementer
in-review       -> PR open, awaiting the reviewer
needs-fixes      -> reviewer bounced it back (bounded retry loop)
ready-for-human  -> reviewer passed it; awaiting human review + merge
done            -> PR merged
blocked         -> needs human input
```

The reviewer↔implementer `needs-fixes` loop is **bounded** to **3 rounds**
(tracked by a `fix-round:N` label); on the 3rd failed review the reviewer sets
`blocked` and escalates to a human instead of bouncing again.

## Runtime

Three independent, always-on **Railway services**, one per agent. They never
communicate directly — they coordinate **only through GitHub status**.

```txt
Planner service      polls issues labeled "needs-plan"     (~30 min)
Implementer service  polls sub-issues in "ready"           (~2-5 min)
Reviewer service     polls PRs / sub-issues in "in-review" (~2-5 min)
```

Each service, each cycle, **drains all actionable work** (processes tasks until
none remain) so a feature can flow through multiple stages without waiting a
full poll interval between every handoff.

### Why polling, not webhooks

For an AFK system no human waits in real time, so:

- **GitHub status is the queue.** Each poll re-reads the current state.
- **Crash recovery is free.** A restarted service simply re-polls and resumes
  whatever is still in an actionable status — no in-memory task is ever lost.
- **No webhook 10-second-ack constraint**, no public ingress, no signature
  verification, no durability buffer.

At 30-minute (planner) and few-minute (implementer/reviewer) intervals, API
usage stays far under GitHub's free authenticated limit (5,000 requests/hour),
especially with conditional requests (304s are free).

### Claiming work safely

Before starting long work, a service flips the item's status out of its trigger
state (e.g. `ready -> in-progress`). The next poll's query then naturally skips
it, so a task is never started twice. A single loop per service (concurrency 1)
removes any race.

## Agent Responsibilities

### Planner Agent

Input: a GitHub issue whose body is the PRD.
Output: a structured implementation plan (overview, ordered steps, test strategy,
out-of-scope), rendered to `plans/issue-<N>.md` and committed to the issue's
`task/<N>-slug` branch via the Contents API. Then it moves the issue to `ready`.
The plan must be concrete enough for the implementer to follow without
reinterpreting the PRD.

### Implementer Agent

Input: the issue (PRD) and the plan file on the task branch.
Output: code changes on that branch, test results, and a single pull request
linked to the issue. It follows the plan and stays within its out-of-scope
boundaries; if the issue/plan can't be done it moves the issue to `blocked`.
The same agent handles `needs-fixes`: re-checks-out the branch, applies the
reviewer's findings, and pushes onto the existing PR.

### Reviewer Agent

Input: the issue (PRD), and the PR diff (which includes the plan file) + test output.
Output: findings ordered by severity and a pass/fail. On fail it moves the issue
to `needs-fixes` (re-entering the bounded loop, capped at 3); on pass it moves it
to `ready-for-human`.

## Isolation & Secrets

- Each agent is its own service, so the service boundary is the isolation
  boundary. The code-executing **implementer** cannot affect the planner or
  reviewer.
- The implementer service holds a **narrow, repo-scoped** GitHub credential
  (`contents:write`, `pull_requests:write`). A leak means "can push to this
  repo", not "controls the GitHub App".
- The **planner** also needs `contents:write` (it commits the plan file) but runs
  no untrusted code, so the core boundary — never run code with broad creds —
  holds. The reviewer and any future database credentials are never present in
  the implementer's environment.

## Observability

Start with **structured logs per service** (which agent ran, on what item,
model, token cost, status transitions, errors, timing). A shared **Postgres**
instance for historical dashboards can be added later — strictly as telemetry,
never as a second task store.

## Deferred

- **Collaboration repo** of long-form feature specs authored by PMs. If revived,
  spec changes are append-only (add a new doc linking the old one).
- **Cross-repo orchestration** — one control plane managing many source repos
  (the original `target_repo` model).
- **Webhooks** — only if instant reaction or many-repo scale is needed.
- **Postgres-backed monitoring** dashboards.

## Testing Strategy

- Planner tests verify PRD → plan generation and that the plan is committed and
  the issue moved to `ready`.
- Implementer tests use a fake workspace + injected runner (no real clone/push);
  the test gate (no PR unless tests pass) and the fix loop are covered.
- Reviewer tests use synthetic diffs and exercise the bounded fix-round loop.
- The GitHub integration is exercised against a mockable client so the agents
  remain testable without live API calls.
