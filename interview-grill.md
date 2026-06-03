# Interview / Grill — Requirements Consensus

A record of the design interview that took the project from its original
local-first Kanban vision to a GitHub-native, polling-driven, multi-service
agent system. Each decision below was reached by working down the dependency
tree one branch at a time and pressure-testing the choice.

_Status: design consensus for v1. Code does not yet implement this — see
`architecture.md` "Current State vs Target" for the gap._

## Locked decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | **Unit of work** | GitHub **issues** (features + bugs, by type/label). _Revised 2026-06-03 (decision 14): no sub-issues — one issue is implemented as one PR._ | An issue is a uniquely-identified, natively-triggered, state-tracked work item. Removes the hardest unsolved problem of the doc-based model: detecting new/changed work without reprocessing. |
| 2 | **Source of truth + dashboard** | **GitHub** is the source of truth; **GitHub Projects** is the Kanban board (a *view*, not a second store); the custom `board.json` store is retired | A Kanban board does not need to be a separate store. Projects gives the Jira/Linear/Notion-style board companies expect, over the same issues — zero drift, zero sync code. |
| 3 | **Repo topology** | **Single repo** — issues + sub-issues + code + PRs all in one repo | Prove the full planner→implementer→reviewer loop in one place first. Cross-repo orchestration (`target_repo`) is deferred. |
| 4 | **Runtime** | **3 separate Railway services** (planner, implementer, reviewer), each authenticated as a scoped **GitHub App / token** | "Separate agents" map cleanly to separate services. The service boundary gives isolation, so no in-process sandboxing of the implementer is needed. |
| 5 | **Trigger** | **Polling** (no webhooks). Planner ~30 min; implementer + reviewer ~2–5 min. Each cycle drains all actionable work | For an AFK system nobody waits in real time. Polling makes GitHub status the queue, gives free crash-recovery (re-read on next poll), and avoids the webhook 10-second-ack problem. At 30-min intervals API usage is a rounding error (well under the free 5,000 req/hr). |
| 6 | **Coordination** | **GitHub status only** — services never talk to each other directly, no message queue, no shared task store | With polling, GitHub *is* the message bus. Each service polls for its own status, does its work, advances the status. |
| 7 | **Autonomy** | planner → implementer → reviewer fully automatic; **the only human gate is the PR merge** | Agents do the work; humans validate the final implementation before merging. |
| 8 | **Monitoring** | **Logs per service** to start; add a shared **Postgres** for historical dashboards later | Don't build telemetry infra before the loop works. Postgres, if added, is *observability* — never a second task store. |

## Lifecycle (status state machine, lives in GitHub)

The state lives on the **issue** (no sub-issues). The human writes the issue body
as the PRD; the planner writes the implementation plan (see decisions 14-15).

```
issue "needs-plan"  → Planner     → commits plans/issue-N.md to task branch → "Ready"
issue "Ready"       → Implementer → "In Progress" → implements on the branch → opens PR → "In Review"
issue "In Review"   → Reviewer    → "Needs Fixes" (bounded loop) OR "Ready for Human"
human reviews+merges→ PR merged   → "Done"
```

## Isolation & secrets

- The implementer service runs code, so it is isolated as its own service. It
  holds a **narrow, repo-scoped** credential (`contents:write`,
  `pull_requests:write`) — a leak means "can push to this repo", not "controls
  the whole GitHub App".
- The planner also needs `contents:write` (decision 15: it commits the plan
  file), but it does **not** execute untrusted code, so the core isolation
  boundary — never run code with broad creds — still holds.
- Reviewer credential and any future DB creds are never exposed to the
  code-executing implementer.

## Deferred (explicitly out of scope for v1)

- **Collaboration repo of spec docs** authored by PMs. If revived later, doc
  changes are **append-only**: add a new doc linking the old one rather than
  editing in place.
- **Cross-repo orchestration** (`target_repo`) — one control plane managing
  issues/PRs across many source repos.
- **Postgres-backed monitoring** with historical dashboards.
- **Webhooks** — only if instant reaction or many-repo scale is ever needed.

## Locked (resolved 2026-06-02)

| # | Question | Decision |
|---|----------|----------|
| 9 | **Agent implementation tech** | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). The implementer drives the SDK's agentic loop (file edit + bash tools) to clone, edit, test, and push; planner and reviewer use the SDK in a constrained, read-mostly mode. |
| 10 | **Label / status names** | Status is a single mutually-exclusive `status:*` label (a flip = remove the old `status:*`, add the new one). Locked set: `status:needs-plan`, `status:ready`, `status:in-progress`, `status:in-review`, `status:needs-fixes`, `status:ready-for-human`, `status:done`, `status:blocked`. Work-type labels: `type:feature`, `type:bug` (`type:task` dropped with sub-issues — decision 14). |
| 11 | **Bounded fix-loop cap** | **3** reviewer↔implementer rounds. The round count lives in GitHub as a `fix-round:N` label; on the 3rd failed review the reviewer sets `status:blocked` and escalates to a human instead of bouncing again. |
| 12 | **Target repo for v1** | **`multi-agent-system` itself** (single-repo, dogfooded — the agents operate on the repo that hosts them). |
| 13 | **Existing prototype files** | **Kept as-is for now**, built alongside the new GitHub-native runtime; the dead local-first files (`kanban/*`, `brief.ts`, the deterministic `planner.ts`, `board.json` plumbing) are removed once the new loop is proven. |

## Revised (resolved 2026-06-03)

| # | Question | Decision |
|---|----------|----------|
| 14 | **Drop sub-issues** | The unit of work is the **issue itself** (feature/bug); **one issue = one PR**. The planner no longer decomposes into sub-issues. Tradeoff accepted: no automatic parallelism/splitting — the plan phases the work *within* one PR. |
| 15 | **PRD vs plan authorship** | The **human writes the PRD** (it is the issue body). The **planner generates only the implementation plan** from it. |
| 16 | **Where the plan lives** | The plan is a **committed repo file**, `plans/issue-<N>.md`. The planner commits it (via the Contents API) onto the issue's `task/<N>-slug` branch, so it rides into the implementer's PR. Consequence: the **planner gains `contents:write`** (it still runs no untrusted code). |
| 17 | **Branch handoff** | Branch name is deterministic (`task/<N>-<slug>`). Planner creates the branch + plan; the implementer always re-checks-out that branch (new work and `needs-fixes` both), reads the plan file, and pushes code onto it; the reviewer sees plan + code in one PR diff. |

## Infra (owner: human)

GitHub App + installation, Railway services, and the GitHub Projects board with
the `status:*` field are provisioned by the human. Code is built and tested
against a **mockable GitHub client** so agents are exercised without live API
calls until the infra exists.
