# Architecture

## Goal

A production-grade multi-agent workflow system where specialized agents plan,
implement, and review engineering work. **GitHub is the system of record** —
issues are the work, GitHub Projects is the board, and pull requests are the
deliverable. Agents do the work autonomously; humans validate the final
implementation before merging.

> See `interview-grill.md` for the decision record behind this design.

## Current State vs Target

This document describes the **target v1 architecture** agreed in the design
interview. The code in `src/` currently implements an **earlier local-first
prototype**: a deterministic Markdown-brief planner writing to a local
`.kanban/board.json` store. The pivot below replaces the local store with
GitHub as the source of truth and introduces the implementer and reviewer
agents. The migration (which files survive, what is rewritten) is still being
scoped.

## System Boundary

```txt
GitHub issue (feature or bug)
  -> Planner agent      (reads issue, writes sub-issues with scoped requirements)
  -> GitHub sub-issues  ("tasks", tracked on a GitHub Projects board)
  -> Implementer agent  (claims a task, writes code, opens a PR)
  -> Reviewer agent      (reviews the PR against acceptance criteria)
  -> Human               (final review + merge)
```

Everything lives in a **single repository** for v1: issues, sub-issues, code,
and pull requests. Cross-repo orchestration is deferred.

## Source of Truth

GitHub holds all work state. There is **no separate task database**.

- **Issue** = a feature request or bug.
- **Sub-issue** = one implementable task under a feature.
- **Project status field / labels** = the workflow state (the Kanban columns).
- **Pull request** = the implementer's output, linked to its sub-issue.

GitHub Projects is a *view* over these — the human-facing Kanban board — not a
second store, so there is nothing to keep in sync.

## Status State Machine

State lives entirely in GitHub status (Project field + labels):

```txt
needs-plan      -> a new issue awaiting planning
ready           -> a sub-issue ready to be implemented
in-progress     -> claimed by the implementer
in-review       -> PR open, awaiting the reviewer
needs-fixes      -> reviewer bounced it back (bounded retry loop)
ready-for-human  -> reviewer passed it; awaiting human review + merge
done            -> PR merged
blocked         -> needs human input
```

The reviewer↔implementer `needs-fixes` loop is **bounded** (a maximum number of
fix attempts) before escalating to a human, so it cannot spin forever. The exact
cap is still to be decided.

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

Input: a GitHub issue (+ repository context).
Output: one or more **sub-issues**, each with a scoped goal, in/out-of-scope
boundaries, acceptance criteria, and a test strategy. The planner may reason
broadly, but each sub-issue must be concrete enough to implement without
reinterpreting the original issue.

### Implementer Agent

Input: one sub-issue (+ repository context).
Output: code changes on a branch, test results, and a pull request linked to the
sub-issue. The implementer stays inside the task scope; new scope creates a
follow-up sub-issue or moves the task to `blocked`.

### Reviewer Agent

Input: the pull request, its diff, test output, and the sub-issue's acceptance
criteria.
Output: findings ordered by severity and a pass/fail. On fail it moves the task
to `needs-fixes` (re-entering the bounded loop); on pass it moves it to
`ready-for-human`.

## Isolation & Secrets

- Each agent is its own service, so the service boundary is the isolation
  boundary. The code-executing **implementer** cannot affect the planner or
  reviewer.
- The implementer service holds a **narrow, repo-scoped** GitHub credential
  (`contents:write`, `pull_requests:write`). A leak means "can push to this
  repo", not "controls the GitHub App".
- Planner/reviewer credentials and any future database credentials are never
  present in the implementer's environment.

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

- Planner tests verify issue → sub-issue decomposition and scoped requirements.
- Implementer tests use temporary Git repos and deterministic tool runners.
- Reviewer tests use synthetic diffs and known acceptance criteria.
- The GitHub integration is exercised against a mockable client so the agents
  remain testable without live API calls.
