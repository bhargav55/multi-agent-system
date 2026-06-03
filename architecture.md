# Architecture

## Goal

A production-grade multi-agent workflow system where specialized agents plan,
implement, and review engineering work. **The pull request is the unit of work
from birth to merge**, and all workflow state is **derived from the PR's own
contents** (its changed files, its native reviews, its head SHA) rather than
stored in labels. Agents do the work autonomously; the only human gate is the
merge.

> See `interview-grill.md` for the decision record and `prd/pr-first-runtime.md`
> for the full specification.

## Why PR-first (and not issues + status labels)

An earlier iteration modelled each unit of work as an issue carrying a machine of
`status:*` / `type:*` / `fix-round:N` labels; services polled by label and *wrote
the next label* to advance state. That created two sources of truth that drift:
advancing state was a second API call after the real work (push code, *then* set
the label), and a crash in that window left the label and reality disagreeing.

PR-first removes the drift: the artifact's existence **is** the state. A plan file
exists ⇒ planning is done; code exists ⇒ implementation is done; the head SHA is
reviewed ⇒ review is done. There is no second write to keep consistent, and no
"feature without a PR" gap that labels had to cover.

## System Boundary

```txt
A human opens a PR from a same-repo branch adding exactly one prds/<slug>.md
  -> Planner service      reads the PRD, commits plans/<slug>.md into the PR
  -> Implementer service  commits code (all plan phases), pushes once
  -> Reviewer service      submits a native review pinned to the head SHA
  -> Human                merges once the latest review is an approval
```

One PRD = one PR. Everything lives in a **single repository**; cross-repo
orchestration is deferred. PRs from forks are unsupported (the planner and
implementer must write to the PR's head branch) and are parked as `blocked`.

## State derivation

State is a **pure function** of a PR — a managed-gate check plus five trigger
predicates, with no I/O (`src/runtime/derive.ts`). Every service computes its
trigger the same way; it is never duplicated inline.

### Managed-PR gate (universal precondition)

A PR is *managed* iff it **adds exactly one `prds/*.md`** AND `headRepo ===
baseRepo`.

- 0 added PRDs ⇒ ignored entirely (a human's own PR; invisible to the bot).
- 2+ added PRDs, or a fork ⇒ `blocked` + comment (owned by the planner — the
  first service to encounter a fresh PR).
- `slug` = the added PRD's basename; plan path = `plans/<slug>.md`; "has code" =
  any changed file outside `prds/` and `plans/`.

### Stage triggers (each also requires: managed ∧ not `blocked`)

```txt
plan        PRD present ∧ no plans/<slug>.md
implement   PRD ∧ plan present ∧ no code
review      code ∧ plan present ∧ head SHA not reviewed
            (latest decisive review's commit_id ≠ head SHA)
fix         latest review is CHANGES_REQUESTED on the current head
merge        latest review is APPROVED            (human)
```

These are mutually exclusive because the lifecycle is monotonic (PRD → +plan →
+code → +review). The single load-bearing mechanism is "is the current head
reviewed?", defined as `latestReview.commit_id === headSha`.

## Labels

- **`blocked`** is the only authoritative label. Applied by any stage that runs
  but cannot produce its artifact (agent reports blocked, agent makes no changes,
  tests fail, malformed/fork PR). It excludes the PR from all triggers and is
  **cleared manually by a human** — re-entry into the workflow is an explicit
  human action.
- **`status:*`** is a write-only projection for UI glanceability. No trigger ever
  reads it; it is overwritten on the next poll if it drifts.

## Runtime

One binary, three roles (`src/main.ts` dispatches on `AGENT_ROLE`). Three
independent, always-on poll loops that never communicate directly — each lists
open PRs and derives what to do.

```txt
Planner service      ~30 min   (slow; planning is expensive and rare)
Implementer service  ~2-5 min
Reviewer service     ~2-5 min
```

Each service runs **concurrency 1**. No "claim" status is needed and none can
drift: because the trigger is the missing artifact, a crash mid-cycle simply
leaves the artifact missing, and the next poll recomputes the identical stage and
resumes.

## Failure taxonomy

- **Deterministic agent failures** (agent reports blocked, makes no changes,
  tests red, malformed PR) ⇒ apply `blocked` (park). These would only loop and
  burn cost if retried.
- **Infrastructure / SDK / network throws** ⇒ log and retry on the next poll (no
  label). The missing artifact keeps the trigger true, so a transient fault
  self-heals. There is no retry cap; logs are the operational safety net.

## Agent responsibilities

### Planner

Input: a managed PR whose body is the PRD. It **clones the head ref read-only**
(read tools only — no bash, no test execution, no permission bypass) to ground
the plan in the real architecture, runs the prd-to-plan methodology
non-interactively (no quiz, **no plan-approval gate**), and commits a single
`plans/<slug>.md` via the Contents API. The plan is an architectural-decisions
header plus **thick**, end-to-end vertical-slice phases, each with
acceptance-criteria checkboxes — deliberately overriding the usual "many thin
slices" default, because all phases ship in one PR with no human checkpoint
between them.

### Implementer

The **only service that executes project code**. New mode: clone the PR head ref,
drive the agent (bypassed permissions) to deliver all plan phases as **one commit
per phase**, run the project's test gate on the **final tree**, and only on green
do a **single push** of all commits. A crash before that push discards the local
commits with the temp clone, so the work re-fires cleanly from "no code". It is
the **sole owner of the PR body** (what / changes / why + links to the PRD and
plan). Fix mode: build the prompt from the latest changes-requested review body,
add fixes as commits on top, gate, single push — moving the head so the reviewer
re-reviews. It never opens a PR.

### Reviewer

Acts on a PR whose current head SHA has not been reviewed. It **captures the head
SHA**, fetches the diff **for that exact SHA**, reviews the cumulative diff
against the **union of all phases' acceptance criteria**, and submits a native
review **pinned to that SHA** (a mandatory `commitId`, never defaulting to
"latest"). If the head moves during review, the review's `commitId` no longer
equals the new head, so the next poll re-derives `review` — a stale review can
never count as approval of unseen code.

The reviewer↔implementer fix loop is **bounded to 3 rounds**, enforced solely via
`blocked`. The reviewer counts only its **own** `CHANGES_REQUESTED` reviews (a
human's review never consumes a round); on the third own changes-requested review
it submits the review **and** applies `blocked` + an escalation comment in the
same cycle. The implementer-fix trigger does no counting.

> GitHub branch protection's "dismiss stale reviews on push" must **not** be
> enabled — it would flip prior reviews to `DISMISSED` and corrupt the count.

## The seam

Every service depends on one `GitHubClient` interface (`src/github/pr-client.ts`)
with an in-memory mock (`pr-mock.ts`) for tests and an Octokit adapter
(`pr-octokit.ts`) for production. Operations:

- `listOpenPullRequests()` — open PRs with changed files, reviews, head SHA, and
  head/base repo identity.
- `getPullRequestDiff(number, sha)` — the cumulative diff pinned to a SHA.
- `commitFile(branch, path, content, message)` — single-file commit to a PR branch.
- `submitReview(number, { commitId, event, body })` — native review with a
  **required** `commitId`.
- `setPullRequestBody`, `comment`, `addBlockedLabel` / `removeBlockedLabel`,
  `setStatusProjection`, `getViewerLogin`.

Reused unchanged from earlier iterations: the Agent SDK runner
(`src/agent/runner.ts`), the structured logger (`src/logger.ts`), the
crash-resilient poll loop (`src/runtime/loop.ts`), and the git workspace
(`src/runtime/workspace.ts`).

## Isolation & secrets

- Each agent is its own service, so the service boundary is the isolation
  boundary. The code-executing **implementer** cannot affect the planner or
  reviewer.
- The implementer holds a **narrow, repo-scoped** credential (`contents:write`,
  `pull_requests:write`). A leak means "can push to this repo", not "controls the
  whole App".
- The **planner** also needs `contents:write` (it commits the plan file) but runs
  no untrusted code — it reads the codebase but never executes it — so the core
  boundary holds.

## Observability

Structured logs per service (which service ran, on what PR, model, token cost,
stage transitions, errors, timing). A shared Postgres for historical dashboards
can be added later — strictly as telemetry, never as a second state store.

## Testing strategy

- Derivation: the managed gate and all five predicates are exhaustively
  unit-tested as a pure function.
- Planner / implementer / reviewer: each is driven end-to-end against the mock
  client with an injected fake agent runner and fake workspace — no network, no
  SDK, no real git. Coverage includes blocked-vs-retry taxonomy, the test gate
  and single push, fix mode from a fabricated changes-requested review, and the
  cap → blocked escalation.
- The Octokit client is not unit-tested (it needs a live token + repo); it
  implements the same interface the mock does.

## Deferred

- GitHub issues, sub-issues, and the `status:*` / `type:*` / `fix-round:N` label
  machine (removed).
- PRs authored from forks (parked as `blocked`; same-repo branches only).
- A human-in-the-loop plan-approval gate (plans are auto-accepted; quality is
  caught at review/merge).
- Auto-unpark of a `blocked` PR (clearing is a manual human action).
- Fanning a multi-phase plan out into multiple PRs (one PRD stays one PR).
- Cross-repo orchestration, webhooks, and Postgres-backed monitoring.
