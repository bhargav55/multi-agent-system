# Multi-Agent System

A production-oriented multi-agent workflow system where specialized agents
**plan, implement, and review** engineering work, with **the pull request as the
unit of work** from birth to merge. A human opens a PR that adds only a PRD file;
a planner commits a plan into it; an implementer commits code into it; a reviewer
submits a native PR review on it; the human merges. The open-PR list is the
board — there are no issues and no status state machine to keep in sync.

This is intentionally not a demo chatbot. It is built around state that **is the
work** rather than an annotation sitting beside it: every service derives what to
do purely from a PR's own artifacts (its changed files, its native reviews, its
head SHA), so a service can crash anywhere and the next poll recomputes the
identical state and resumes.

> **Design docs:** `architecture.md` (how it works) and `interview-grill.md` (the
> decision record behind it). Full spec: `prd/pr-first-runtime.md` and
> `plans/pr-first-runtime.md`.

## Lifecycle

```txt
Human opens a PR adding only prds/<slug>.md   (the PRD — what & why)
  -> Planner service      commits plans/<slug>.md into the PR
  -> Implementer service  commits code (all plan phases) and pushes once
  -> Reviewer service      submits a native review pinned to the head SHA
  -> Implementer (fix)    addresses changes-requested, pushes again  (loop, cap 3)
  -> Human                merges once the latest review is an approval
```

One PRD equals one PR. There is never a "feature without a PR", so there is no
gap that needs labels to cover it.

## Derived state, not stored state

Each service is a stateless, concurrency-1 poll loop. Every cycle it lists open
PRs and, for each, **computes** the stage from the PR's artifacts:

| Stage | Trigger (also requires: managed ∧ not `blocked`) | Owner |
|-------|--------------------------------------------------|-------|
| plan | PRD present ∧ no `plans/<slug>.md` | planner |
| implement | PRD ∧ plan present ∧ no code | implementer |
| review | code ∧ plan present ∧ head SHA not reviewed | reviewer |
| fix | latest review is `CHANGES_REQUESTED` on the current head | implementer |
| merge | latest review is `APPROVED` | human |

A PR is **managed** iff it adds exactly one `prds/*.md` **and** its head repo
equals its base repo. A PR that adds no PRD is ignored entirely (your ordinary
hotfix/docs PRs are never touched); a PR that adds 2+ PRDs or comes from a fork
is parked with the `blocked` label.

Because the artifact's existence is the guard, processing is idempotent and the
predicates are mutually exclusive (the lifecycle is monotonic: PRD → +plan →
+code → +review).

## Labels

Only **one label is authoritative: `blocked`** — applied by any stage that runs
but cannot produce its artifact (agent reports blocked, agent makes no changes,
tests fail, malformed/fork PR). It excludes the PR from every trigger and is
**cleared manually by a human**. A second, cosmetic `status:*` projection label
is written for at-a-glance triage but is never read by any logic, so its drift is
harmless.

## Runtime

One binary, three roles. Each service sets `AGENT_ROLE` and runs its own poll
loop; services share no state and never talk to each other.

```bash
bun install

# run one role as an always-on poll loop
AGENT_ROLE=planner GITHUB_REPO=owner/repo GITHUB_TOKEN=… bun run src/main.ts

# run a single cycle and exit (manual testing / external cron)
AGENT_ROLE=reviewer GITHUB_REPO=owner/repo GITHUB_TOKEN=… bun run src/main.ts --once
```

Environment: `AGENT_ROLE` (`planner`|`implementer`|`reviewer`), `GITHUB_REPO`
(`owner/repo`), `GITHUB_TOKEN` (repo-scoped). Optional: `AGENT_MODEL`,
`POLL_INTERVAL_MS`, `GITHUB_BASE` (default `main`).

### Dry run (real SDK, no GitHub)

Exercise a service against a seeded in-memory PR using the real Claude Agent SDK
(needs `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`):

```bash
bun run scripts/dry-run.ts planner
bun run scripts/dry-run.ts reviewer
```

## Development

```bash
bun run test        # vitest: derivation + the three services against the mock client
bun run typecheck   # tsc --noEmit
```

All service logic is tested against an in-memory `GitHubClient` mock with an
injected fake agent runner and fake workspace — no network, no SDK, no real git.

## Production Principles

- State **is** the work: derived from the PR's files, reviews, and head SHA — it
  can never silently disagree with reality.
- Crash-safe by construction: idempotent stages, single push at the end of
  implementation, SHA-pinned reviews.
- The implementer is the only service that executes project code, keeping the
  sandbox boundary narrow.
- Exactly one human gate: the merge.
