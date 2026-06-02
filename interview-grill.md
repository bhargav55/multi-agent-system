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
| 1 | **Unit of work** | GitHub **issues** (features + bugs, by type/label); tasks = **sub-issues** | An issue is a uniquely-identified, natively-triggered, state-tracked work item. Removes the hardest unsolved problem of the doc-based model: detecting new/changed work without reprocessing. |
| 2 | **Source of truth + dashboard** | **GitHub** is the source of truth; **GitHub Projects** is the Kanban board (a *view*, not a second store); the custom `board.json` store is retired | A Kanban board does not need to be a separate store. Projects gives the Jira/Linear/Notion-style board companies expect, over the same issues — zero drift, zero sync code. |
| 3 | **Repo topology** | **Single repo** — issues + sub-issues + code + PRs all in one repo | Prove the full planner→implementer→reviewer loop in one place first. Cross-repo orchestration (`target_repo`) is deferred. |
| 4 | **Runtime** | **3 separate Railway services** (planner, implementer, reviewer), each authenticated as a scoped **GitHub App / token** | "Separate agents" map cleanly to separate services. The service boundary gives isolation, so no in-process sandboxing of the implementer is needed. |
| 5 | **Trigger** | **Polling** (no webhooks). Planner ~30 min; implementer + reviewer ~2–5 min. Each cycle drains all actionable work | For an AFK system nobody waits in real time. Polling makes GitHub status the queue, gives free crash-recovery (re-read on next poll), and avoids the webhook 10-second-ack problem. At 30-min intervals API usage is a rounding error (well under the free 5,000 req/hr). |
| 6 | **Coordination** | **GitHub status only** — services never talk to each other directly, no message queue, no shared task store | With polling, GitHub *is* the message bus. Each service polls for its own status, does its work, advances the status. |
| 7 | **Autonomy** | planner → implementer → reviewer fully automatic; **the only human gate is the PR merge** | Agents do the work; humans validate the final implementation before merging. |
| 8 | **Monitoring** | **Logs per service** to start; add a shared **Postgres** for historical dashboards later | Don't build telemetry infra before the loop works. Postgres, if added, is *observability* — never a second task store. |

## Lifecycle (status state machine, lives in GitHub)

```
issue "needs-plan"        → Planner     → creates sub-issues → "Ready"
sub-issue "Ready"         → Implementer → "In Progress" → opens PR → "In Review"
PR / sub-issue "In Review"→ Reviewer    → "Needs Fixes" (loop) OR "Ready for Human"
human reviews + merges    → PR merged   → "Done"
```

## Isolation & secrets

- The implementer service runs code, so it is isolated as its own service.
- It holds a **narrow, repo-scoped** GitHub credential (`contents:write`,
  `pull_requests:write`) — so a leak means "can push to this repo", not
  "controls the whole GitHub App".
- Planner / reviewer credentials and any future DB creds are never exposed to
  the code-executing implementer.

## Deferred (explicitly out of scope for v1)

- **Collaboration repo of spec docs** authored by PMs. If revived later, doc
  changes are **append-only**: add a new doc linking the old one rather than
  editing in place.
- **Cross-repo orchestration** (`target_repo`) — one control plane managing
  issues/PRs across many source repos.
- **Postgres-backed monitoring** with historical dashboards.
- **Webhooks** — only if instant reaction or many-repo scale is ever needed.

## Still to nail down

- Exact label/status names and the **bounded fix-loop** cap (max N
  reviewer↔implementer rounds before escalating to a human).
- **Agent implementation tech** — Claude Agent SDK vs. raw Claude API; exactly
  how the implementer clones, edits, tests, and pushes.
- **Which existing files survive** the pivot (`types.ts`, `brief.ts`,
  `planner.ts`, `kanban/store.ts`, `github/issues.ts`, `cli.ts`).
