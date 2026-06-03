# PRD: PR-First, No-Issues Runtime

> Source: design grill, session of 2026-06-03. Supersedes the issue + status-label
> state machine currently committed (`2016ab1`).

## Problem Statement

The current runtime models each unit of work as a GitHub **issue** carrying a
machine of labels — `status:*` (eight mutually-exclusive states), `type:*`, and
`fix-round:N`. Three services (planner, implementer, reviewer) poll issues by
label, do work, and *write the next label* to advance the state.

This creates two problems the operator keeps hitting:

1. **Two sources of truth that drift.** The label says one thing; the PR's actual
   files and reviews say another. Advancing state is a *second* API call after the
   real work (push code, *then* `setStatus`). If a service crashes in that window,
   the label and reality disagree — and the next poll re-does work it shouldn't, or
   skips work it should do. The "crash-resilient poll loop" is undermined by mutable
   label side-state that must be kept transactionally consistent with commits, which
   GitHub does not support.

2. **A gap with no home for status.** A feature is born as an issue but a PR appears
   only later (the implementer opens it). During that gap, status can live *only* on
   the issue as labels — which is the very thing forcing the label machine to exist.

The operator wants the workflow state to *be* the work, not a fragile annotation
sitting beside it.

## Solution

Make the **pull request the unit of work from birth to merge**, and **derive all
workflow state from the PR's own contents** (its files, its native reviews, its head
SHA) instead of storing it in labels.

One PRD equals one PR. The human opens the PR by pushing a branch whose only change
is a new `prds/<slug>.md` file. That single PR then *accumulates* its own lifecycle:
the planner commits a plan into it, the implementer commits code into it, the reviewer
submits a native PR review on it, and the human merges it. There is never a "feature
without a PR," so there is never a gap that needs labels to cover it.

Each of the three services is a stateless, concurrency-1 poll loop. On every cycle it
lists open PRs and, for each, *computes* the stage from the PR's artifacts. Because the
artifact's existence is the guard (a plan file exists ⇒ planning is done; code exists ⇒
implementation is done; the head SHA is reviewed ⇒ review is done), processing is
idempotent: a service can crash anywhere and the next poll recomputes the identical
state and resumes. No "claim" status is needed and none can drift.

Exactly one label survives — `blocked` — for the single state artifacts genuinely
cannot express ("a stage ran but could not produce its artifact"). A second, purely
cosmetic `status:*` projection label is written for GitHub-UI glanceability but is
never read by any logic, so its drift is harmless.

## User Stories

1. As an operator, I want to start a feature by opening a PR that adds only its PRD
   file, so that the unit of work and its tracking object are the same thing from the start.
2. As an operator, I want the system to never depend on GitHub issues, so that I manage
   everything from the PR list I already watch.
3. As an operator, I want each feature's stage to be derived from the PR's contents, so
   that the displayed state can never silently disagree with reality.
4. As an operator, I want a service to crash mid-cycle without corrupting state, so that
   the next poll simply recomputes and resumes.
5. As an operator, I want to see every in-flight feature as an open PR, so that the open-PR
   list is my board with no extra tooling.
6. As an operator, I want an at-a-glance stage badge on each PR, so that I can triage the
   board without opening each PR — even though that badge is cosmetic.
7. As an operator, I want a PR that does not add a PRD to be completely ignored by the bot,
   so that my ordinary hotfix/docs/dependency PRs are never auto-touched.
8. As an operator, I want a PR that adds two or more PRDs, or comes from a fork, to be
   parked and flagged, so that ambiguous or unwriteable inputs fail loudly rather than
   silently misbehave.
9. As an operator, I want exactly one human gate — the merge — so that the system runs
   autonomously from PRD to ready-for-merge.
10. As an operator, I want to clear a parked (`blocked`) PR by hand after I intervene, so
    that re-entry into the workflow is an explicit human action.
11. As a planner service, I want to act on a PR that has a PRD but no plan, so that I can
    produce the plan exactly once.
12. As a planner service, I want to clone the repository read-only to explore the codebase
    before planning, so that my plan references the real architecture rather than guesses.
13. As a planner service, I want to never execute project code, so that I stay on the safe
    side of the isolation boundary while still holding write access to commit the plan.
14. As a planner service, I want to write the plan as a thick-phase, end-to-end vertical-slice
    document with per-phase acceptance criteria, so that the implementer has build order and
    the reviewer has a concrete checklist.
15. As a planner service, I want to commit the plan as one file onto the PR's branch, so that
    the plan rides inside the same PR as a versioned artifact.
16. As a planner service, I want to retry on a transient commit conflict and park on an
    un-plannable PRD, so that flaky failures self-heal while genuine ones stop.
17. As an implementer service, I want to act on a PR that has a PRD and plan but no code, so
    that I implement exactly once.
18. As an implementer service, I want to deliver all of the plan's phases inside the single
    PR, so that one PRD remains one PR.
19. As an implementer service, I want to make one local commit per phase, so that the PR's
    history reads as a sequence of meaningful, reviewable slices.
20. As an implementer service, I want to run the project's tests and only push if they pass on
    the final tree, so that the PR never carries broken code.
21. As an implementer service, I want to push all phase commits in a single push at the end, so
    that a crash mid-implementation leaves nothing pushed and the work re-fires cleanly.
22. As an implementer service, I want to park (`blocked`) when the agent reports it cannot
    proceed, makes no changes, or the tests fail, so that deterministic failures stop instead of
    looping and burning cost.
23. As an implementer service, I want to retry on infrastructure errors (clone/push/SDK), so
    that transient faults recover on the next poll.
24. As an implementer service, I want to own the PR body and write what/changes/why plus links
    to the PRD and plan, so that the reviewer and humans have one clear description.
25. As an implementer service in fix mode, I want to act on a PR whose latest review requests
    changes on the current head, so that I address review feedback.
26. As an implementer service in fix mode, I want to build my prompt from the latest
    changes-requested review's body, so that I fix exactly what the reviewer asked.
27. As an implementer service in fix mode, I want to add my fixes as commits on top and push
    once, so that the head moves and the reviewer re-reviews.
28. As a reviewer service, I want to act on a PR that has code and a plan whose current head SHA
    has not yet been reviewed, so that I review each new head exactly once.
29. As a reviewer service, I want to capture the head SHA, fetch the diff for that SHA, and pin
    my review to that SHA, so that I can never certify code I did not read.
30. As a reviewer service, I want my review guard to self-heal when the head moves during review,
    so that a stale review never counts as an approval of new code.
31. As a reviewer service, I want to review the cumulative PR diff against the union of all
    phases' acceptance criteria, so that I judge the whole feature, not individual commits.
32. As a reviewer service, I want to count only my own changes-requested reviews toward the fix
    cap, so that a human's review never silently consumes a fix round.
33. As a reviewer service, I want to park (`blocked`) and post an escalation comment when I issue
    the third changes-requested review, so that the loop stops at the cap and a human takes over.
34. As a reviewer service, I want to leave the implementer's fix trigger free of any counting, so
    that the `blocked` label is the single enforcement point for the cap.
35. As a human reviewer, I want to optionally edit the plan or push a fix to a parked PR, so that
    I can correct the system's direction before merge.
36. As a human, I want to merge a PR once its latest review is an approval, so that merge is the
    only decision I must make.
37. As an operator, I want the implementer to be the only service that executes project code, so
    that the sandbox boundary stays narrow and well-defined.
38. As an operator, I want every service to ignore a `blocked` PR, so that a parked item stays out
    of all three loops until I clear it.
39. As an operator, I want the projection label to be overwritten on the next poll if it drifts, so
    that I never have to reconcile it by hand.
40. As an operator, I want the PRD-to-plan phases to be thick rather than thin, so that the one-PR
    delivery isn't fragmented into noise when there is no incremental human checkpoint between phases.

## Implementation Decisions

### Modules
- **`GitHubClient`** is rewritten PR-centric. It can: list open PRs with their changed files,
  reviews, head SHA, and head/base repo identity; fetch a PR's diff for a specific SHA; commit a
  single file to a PR's branch; submit a native PR review (`approve` / `request_changes`) with a
  **mandatory `commitId`**; read a PR's review history; comment; and set/remove the `blocked` label
  and the `status:*` projection. Dropped operations: `listIssuesByStatus`, `getIssue`, `setStatus`,
  `setFixRound`, `openPlanBranch`, `createSubIssue`, `requestChanges`/`getReviewFindings`,
  `openPullRequest`, `findPullRequestForIssue`.
- **Planner, implementer, reviewer** services are rewritten to compute their trigger from PR
  artifacts (below) rather than label queries.
- **Config** drops `STATUSES`, `status:*`/`type:*` labels, and `fix-round`; it keeps environment
  loading (role, repo, token, base, model, poll interval).
- **Naming** derives the slug from the PRD filename basename; the plan path is `plans/<slug>.md`.
- **Survives unchanged:** the Agent SDK runner, the structured logger, the crash-resilient poll loop,
  and the git workspace (rebased onto the PR's head ref). The test gate and the self-documenting PR
  body are preserved behaviours.

### Lifecycle
A human opens a PR from a **same-repo branch** adding exactly one `prds/<slug>.md` (PRD only). The
planner commits `plans/<slug>.md`; the implementer commits code (all phases) and pushes once; the
reviewer submits a native review pinned to the head SHA; the implementer applies fixes on top until
approved or capped; the human merges on approval.

### Managed-PR gate (universal precondition for every stage)
A PR is *managed* iff it **adds exactly one `prds/*.md`** AND its head repo equals its base repo.
- 0 added PRDs ⇒ ignored entirely (a human's own PR; invisible to the bot).
- 2+ added PRDs, or a fork ⇒ `blocked` + comment.
- `slug` = the added PRD's basename.

### Stage triggers (each also requires: managed ∧ not `blocked`)
- **Planner:** PRD present ∧ no `plans/<slug>.md`.
- **Implementer (new):** PRD ∧ plan present ∧ no code (no changed file outside `prds/` and `plans/`).
- **Reviewer:** code present ∧ plan present ∧ head SHA not reviewed (latest review's `commit_id` ≠ head).
- **Implementer (fix):** latest review is `CHANGES_REQUESTED` on the current head.
- **Human:** latest review is `APPROVED` ⇒ merge.

These predicates are mutually exclusive across stages because the lifecycle is monotonic
(PRD → +plan → +code → +review). Each service runs concurrency-1.

### State model
- State is **derived** from (PR changed files + reviews + head SHA) — the single source of truth.
- **`blocked`** is the only authoritative label. Applied by any stage that runs but cannot produce its
  artifact (agent reports blocked, agent makes no changes, tests fail, malformed/fork PR). It excludes
  the PR from all triggers and is **cleared manually by a human**.
- **`status:*`** is a write-only projection for UI glanceability; it is never read by any trigger and is
  overwritten on the next poll if it drifts.

### Failure taxonomy
- Deterministic agent failures (agent `blocked`, no-op, tests red) ⇒ apply `blocked` (park).
- Infrastructure/SDK/network throws ⇒ log and retry on the next poll (no label); the missing artifact
  keeps the trigger true, so a transient fault self-heals.

### Fix-loop cap (= 3)
- The reviewer counts only its **own** `CHANGES_REQUESTED` reviews on the PR. Below the cap it submits a
  changes-requested review; on the third it submits the review **and** applies `blocked` + an escalation
  comment in the same cycle.
- The implementer-fix trigger does no counting — `blocked` is the sole enforcement.
- GitHub branch protection's "dismiss stale reviews on push" must **not** be enabled (it would flip
  prior reviews to `DISMISSED` and corrupt the count).

### Review integrity
- The reviewer captures the head SHA at the start of the cycle, fetches the diff for that exact SHA, and
  submits its review pinned to it. A head that moves during review yields `reviewed SHA ≠ head` on the
  next poll, triggering a fresh review; a stale review can therefore never count as approval of unseen code.

### Planner specifics
- Runs the `prd-to-plan` methodology **non-interactively**: no user quiz and **no plan-approval gate**
  (the only human gate is merge).
- Clones the repository **read-only** to explore (no shell, no test execution, no permission bypass),
  writes the plan, and pushes that one file. Isolation boundary intact: it reads code but never executes it.
- Plan shape: an architectural-decisions header plus **thick**, end-to-end vertical-slice phases, each with
  acceptance-criteria checkboxes. This deliberately overrides the skill's "prefer many thin slices" default,
  because all phases ship in one PR with no incremental human checkpoint.

### Implementer specifics
- Clones the PR's head ref, implements **all** phases, makes **one commit per phase** (tests kept green at
  each commit), runs the authoritative test gate on the **final tree**, and does a **single push** of all
  commits at the end. A crash before that push discards local commits with the temp clone, so the work
  re-fires cleanly from "no code."
- Sole owner of the PR body: writes what/changes/why plus permalinks to the PRD and plan.
- Fix mode builds its prompt from the latest changes-requested review body and adds fixes as commits on top.
- Never opens a PR.

## Out of Scope

- GitHub issues, sub-issues, and the `status:*` / `type:*` / `fix-round:N` label machine (removed).
- PRs authored from **forks** (parked as `blocked`; same-repo branches only, because the planner and
  implementer must write to the PR's head branch).
- Human-authored code shipped alongside the PRD in the opening PR (unsupported; humans open the PR with the
  PRD only — the reviewer additionally requires a plan to be present, so a stray code-first PR simply waits).
- A human-in-the-loop **plan-approval** gate (plans are auto-accepted; quality is caught at review/merge).
- **Auto-unpark** of a `blocked` PR on a new head commit (clearing is a manual human action).
- A **retry cap** on infrastructure errors (they retry unbounded; logs are the operational safety net).
- Fanning a multi-phase plan out into **multiple PRs** (one PRD stays one PR).
- Persisting state to a database (logs first; Postgres is a later, separate concern).

## Further Notes

- **Why labels almost entirely disappear:** seven of the eight old `status:*` values and the `fix-round`
  counter all map to a derivable fact about the PR (no plan ⇒ needs-plan; plan but no code ⇒ needs-impl;
  code with unreviewed head ⇒ needs-review; latest review changes-requested ⇒ needs-fixes; latest review
  approved ⇒ ready-for-human; merged ⇒ done; count of changes-requested ⇒ fix round). Only `blocked` has no
  artifact, so it is the only authoritative label kept.
- **The single load-bearing mechanism** is "is the current head SHA reviewed?", defined as
  `latestReview.commit_id === head`. Mandatory `commit_id` pinning on every review is what makes it
  race-safe and self-healing; it must not be left to default to "latest."
- **Security TODO (carried over, not blocking):** a GitHub PAT pasted in an earlier session still needs
  revoking; local pushes use a separate macOS Keychain credential.
- **Commit convention for this repo:** author `bhargav55 <kacharlabhargav21@gmail.com>`, no `Co-Authored-By:
  Claude` trailer.
