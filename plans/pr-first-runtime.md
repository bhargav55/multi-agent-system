# Plan: PR-First, No-Issues Runtime

> Source PRD: `prd/pr-first-runtime.md`. Rewrites the runtime off the issue +
> status-label state machine (`2016ab1`) onto PR-derived state. Done
> interactively by a developer, not the autonomous bot; each phase is verified
> with `bunx vitest run` (and `bunx tsc --noEmit`) before moving on.

## Architectural decisions

Durable decisions that apply across all phases:

- **The seam — `GitHubClient` (PR-centric).** One interface every service depends on,
  with an in-memory mock for tests and an Octokit adapter for production. Operations:
  list open PRs (with changed files, reviews, head SHA, head/base repo); get a PR's
  diff for a specific SHA; commit a single file to a PR branch; submit a native review
  (`approve` / `request_changes`) with a **required `commitId`**; comment; set/remove
  the `blocked` label and the `status:*` projection.
- **Core data shape — `ManagedPR`.** number, headSha, headRef (branch), headRepo,
  baseRepo, url, body, changedFiles (path + added/modified status), reviews (state +
  `commit_id` + author login).
- **State derivation is a pure function** over a `ManagedPR`: a managed-gate check and
  the five trigger predicates. No I/O — exhaustively unit-testable. Every service calls
  it; it is never duplicated inline.
- **Trigger predicates** (each also requires managed ∧ not `blocked`): planner = PRD ∧
  no plan; implementer-new = PRD ∧ plan ∧ no code; reviewer = code ∧ plan ∧ head not
  reviewed (`latestReview.commit_id ≠ headSha`); implementer-fix = latest review
  `CHANGES_REQUESTED` on head.
- **Managed gate.** Managed iff the PR **adds exactly one `prds/*.md`** AND
  `headRepo === baseRepo`. 0 added PRDs ⇒ unmanaged (ignored). 2+ added PRDs or a fork
  ⇒ `blocked`. `slug` = the added PRD basename; plan path = `plans/<slug>.md`; "has code"
  = any changed file outside `prds/` and `plans/`.
- **Labels.** `blocked` (authoritative; set on any unproducible-artifact/malformed PR;
  excludes from all triggers; manual human clear). `status:*` projection (write-only,
  never read; overwritten next poll).
- **Cap = 3**, owned by the reviewer (counts only its own `CHANGES_REQUESTED` reviews);
  enforced solely via `blocked`. Implementer-fix does no counting.
- **Failure taxonomy.** Deterministic agent failure (agent `blocked`, no-op, tests red) ⇒
  `blocked`. Infra/SDK/network throw ⇒ log + retry next poll (no label).
- **Test pattern.** Inject a fake `AgentRunner` + fake `Workspace` + mock `GitHubClient`;
  no network, no SDK, no real git.
- **Reused unchanged:** Agent SDK runner, structured logger, crash-resilient poll loop,
  git workspace (rebased onto the PR head ref). Config keeps env loading only.

---

## Phase 1: Seam + state derivation

**User stories**: 2, 3, 4, 5, 6, 7, 8, 10, 28, 38, 39

### What to build

The backbone the three services hang off. Define the PR-centric `GitHubClient` interface
and the `ManagedPR` type, an in-memory mock client that can be seeded with PRs/reviews,
and the **pure derivation module**: the managed-gate check (0/1/2+ PRDs, fork, slug
extraction, "has code") and the five trigger predicates, plus the two label constants.
No service logic and no real network yet — just the seam and the function that turns a
`ManagedPR` into a stage. End-to-end "slice" = a seeded mock PR flows through derivation
to the correct stage, proven by tests.

### Acceptance criteria

- [ ] `GitHubClient` interface is PR-centric with the operations listed in the header; the
      old issue/label methods are gone from the interface.
- [ ] A `deriveStage(pr)` (pure, no I/O) returns the correct stage for: planless PRD,
      plan-but-no-code, code-with-unreviewed-head, changes-requested-on-head, approved.
- [ ] Managed gate returns: ignored (0 PRDs), managed+slug (1 added PRD), blocked-reason
      (2+ PRDs), blocked-reason (fork: `headRepo ≠ baseRepo`).
- [ ] "Has code" is true iff a changed file exists outside `prds/` and `plans/`; head-reviewed
      is `latestReview.commit_id === headSha`.
- [ ] A `blocked`-labelled PR derives to "skip" regardless of artifacts.
- [ ] Mock client supports seeding PRs, changed files, reviews, labels, and recording
      commits/reviews/labels/comments for assertions.
- [ ] `bunx vitest run` passes for the new derivation + mock tests; `bunx tsc --noEmit` clean.

---

## Phase 2: Planner service

**User stories**: 1, 9, 11, 12, 13, 14, 15, 16

### What to build

The planner end-to-end against the mock. It selects PRs whose derived stage is needs-plan,
**clones the head ref read-only** to explore (no shell/test/bypass), runs the agent (fake in
tests) to produce a thick-phase, end-to-end plan with per-phase acceptance criteria, commits
`plans/<slug>.md` to the PR branch via the client, and writes the `status:*` projection. An
un-plannable PRD ⇒ `blocked`; a transient commit conflict ⇒ retry next poll. Idempotent: a PR
that already has a plan is skipped.

### Acceptance criteria

- [ ] Planner acts only on managed, non-blocked, needs-plan PRs and skips ones that already
      have `plans/<slug>.md`.
- [ ] On success it commits exactly one file at `plans/<slug>.md` containing the
      architectural-decisions header + thick vertical-slice phases with acceptance-criteria
      checkboxes; it sets the projection label; it makes no plan-approval gate.
- [ ] The planner clone is read-only (no test run, no bash, no permission bypass) in the code path.
- [ ] Agent-reported "cannot plan" ⇒ `blocked` + comment; an infra/commit error ⇒ no label,
      logged, re-attempted next cycle.
- [ ] Planner tests drive these paths with a fake runner + mock client; suite + typecheck green.

---

## Phase 3: Implementer service (new + fix)

**User stories**: 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 37

### What to build

The only code-executing service, end-to-end against fakes, covering both modes. **New mode**
(needs-impl): clone the PR head ref, run the agent (bypass perms) to deliver all plan phases as
**one commit per phase**, run the test gate on the **final tree**, and on green do a **single
push** of all commits; then (re)write the PR body with what/changes/why + PRD/plan links and set
the projection. **Fix mode** (changes-requested on head): build the prompt from the latest
changes-requested review body, apply fixes as commits on top, gate, single push. Deterministic
failures (agent `blocked`, no changes, tests red) ⇒ `blocked`; infra throws ⇒ retry. Never opens
a PR.

### Acceptance criteria

- [ ] New mode acts only on managed, non-blocked, needs-impl PRs; fix mode only on
      changes-requested-on-head, non-blocked PRs.
- [ ] On success the implementer pushes exactly once (all phase commits together) and only after
      the test gate passes on the final tree; a crash before push leaves nothing pushed.
- [ ] No-op (no working-tree changes), agent-`blocked`, or failed tests ⇒ `blocked` + comment;
      clone/push/SDK error ⇒ no label, logged, retried.
- [ ] The implementer is the sole writer of the PR body and includes links to `prds/<slug>.md`
      and `plans/<slug>.md`.
- [ ] Fix-mode prompt is constructed from the latest `CHANGES_REQUESTED` review body; fixes land
      as commits on top and move the head.
- [ ] Implementer never calls an "open PR" operation.
- [ ] Tests cover new-success, no-op→blocked, tests-fail→blocked, infra-retry, and fix-mode with a
      fabricated changes-requested review; suite + typecheck green.

---

## Phase 4: Reviewer service

**User stories**: 28, 29, 30, 31, 32, 33, 34

### What to build

The reviewer end-to-end against the mock. It selects needs-review PRs, **captures the head SHA**,
fetches the diff **for that SHA**, runs the agent against the cumulative diff + the union of the
plan's acceptance criteria, and submits a native review **pinned to that SHA** (`approve` /
`request_changes`). It counts only its **own** prior `CHANGES_REQUESTED` reviews; on the third it
submits the changes-requested review **and** applies `blocked` + an escalation comment in the same
cycle. The guard self-heals when the head moves mid-review.

### Acceptance criteria

- [ ] Reviewer acts only on managed, non-blocked PRs with code + plan + unreviewed head; skips when
      `latestReview.commit_id === headSha`.
- [ ] Every submitted review carries an explicit `commitId` equal to the SHA the diff was fetched for
      (no default-to-latest).
- [ ] Approve path sets the projection to ready-for-human and submits an `approve` review.
- [ ] Changes-requested below the cap submits a `request_changes` review and no label.
- [ ] The third own-CR submits the review **and** applies `blocked` + escalation comment in one cycle;
      a human's review never counts toward the cap.
- [ ] Tests cover approve, below-cap CR, third-CR→blocked, and a moved-head re-review; suite +
      typecheck green.

---

## Phase 5: Real wiring + removal of the issue era

**User stories**: 36 (and making Phases 1–4 run for real)

### What to build

Swap the mock for reality and delete the dead design. Implement the Octokit PR-centric client behind
the Phase 1 interface; rewrite `main` role-dispatch to construct the new client + service; clean
`config` down to env loading (drop `STATUSES`, `status:*`/`type:*` labels, `fix-round`); update the
dry-run script to seed PR-first scenarios; and **remove the issue/kanban-era modules and their tests**
(e.g. `src/github/issues.ts`, `src/kanban/*`, `src/orchestrator.ts`, `src/brief.ts`,
`src/agents/planner.ts`, `src/cli.ts`/`src/types.ts` if unused, and tests `brief`, `foundation`,
`issues`, `orchestrator`, `planner`, `store`), guided by the compiler so nothing live breaks.

### Acceptance criteria

- [ ] `main` builds the correct service per `AGENT_ROLE` against the Octokit client.
- [ ] The Octokit client implements every interface method, including review submission with `commitId`
      and single-file commit to a PR branch.
- [ ] `config` no longer exports statuses/status-labels/kind-labels/fix-round; env loading still works.
- [ ] The dry-run script exercises the PR-first lifecycle against the mock.
- [ ] All issue/kanban-era source and test files are deleted; no remaining import references them.
- [ ] Full `bunx vitest run` is green and `bunx tsc --noEmit` is clean with the old files gone.

---

## Phase 6: Documentation

**User stories**: — (documents the whole system)

### What to build

Bring the prose in line with the implemented runtime. Rewrite `README.md` and `architecture.md` to the
PR-first model (lifecycle, triggers, derived state, the single `blocked` label, the projection), and
append new numbered decisions (18+) to `interview-grill.md` capturing this third iteration: no issues;
PR as the unit of work from birth; state derived from PR contents + native reviews; single `blocked`
label; SHA-pinned reviews; reviewer-owned cap; planner read-only clone; thick phases / commit-per-phase /
push-once.

### Acceptance criteria

- [ ] `README.md` and `architecture.md` describe the PR-first lifecycle and contain no stale references
      to issues, `status:*`/`type:*` labels, or `fix-round`.
- [ ] `interview-grill.md` retains decisions 1–17 and adds the new decisions for this iteration.
- [ ] The documented `GitHubClient` surface and trigger table match the shipped code.
