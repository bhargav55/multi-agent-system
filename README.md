# Multi-Agent System

A production-oriented multi-agent workflow system where specialized agents
**plan, implement, and review** engineering work, with **GitHub as the system of
record**. Features and bugs are filed as GitHub issues; a planner decomposes
them into tasks (sub-issues); an implementer writes the code and opens a pull
request; a reviewer checks it against acceptance criteria. Humans validate the
final implementation before merging.

This is intentionally not a demo chatbot. The system is built around durable
work state, typed agent contracts, and a clear hand-off model.

> **Design docs:** `architecture.md` (target architecture) and
> `interview-grill.md` (the decision record behind it).

## Status

The current `src/` code is an **earlier local-first prototype**: a deterministic
Markdown-brief planner that writes Kanban cards to a local `.kanban/board.json`
store, plus GitHub issue-draft generation. The project is **pivoting** to the
GitHub-native, multi-service design described in `architecture.md`. The CLI
below still works for the prototype; the new agent services are being built.

## Target Workflow

```txt
GitHub issue (feature or bug)
  -> Planner agent      creates sub-issues with scoped requirements + acceptance criteria
  -> Implementer agent  claims a task, writes code, opens a PR
  -> Reviewer agent      reviews the PR (bounded fix loop), then marks it ready for a human
  -> Human               final review + merge
```

- **Source of truth:** GitHub. **Board:** GitHub Projects (a view over issues).
- **Runtime:** three always-on Railway services (planner / implementer /
  reviewer) that coordinate purely through GitHub status — no queue, no
  inter-service calls.
- **Trigger:** polling (planner ~30 min; implementer/reviewer ~2-5 min), each
  cycle draining all actionable work.
- **Autonomy:** the full loop runs automatically; the only human gate is the PR
  merge.

See `architecture.md` for the status state machine, isolation/secrets model, and
deferred items (collaboration repo, cross-repo orchestration, webhooks,
Postgres-backed monitoring).

## Current Prototype (local-first CLI)

The existing code turns a Markdown brief into local Kanban cards.

Install:

```bash
bun install
```

Create cards from a Markdown brief:

```bash
bun run src/cli.ts plan specs/example.md
```

Inspect board:

```bash
bun run src/cli.ts board
```

Show next ready card:

```bash
bun run src/cli.ts next
```

Move a card:

```bash
bun run src/cli.ts move card-001 in-progress
```

Generate GitHub issue drafts from cards:

```bash
bun run src/cli.ts issue-drafts bhargav55/knowledge-assistant
```

The command currently prints issue-ready JSON. Live GitHub issue creation is
part of the pivot to the GitHub-native design.

## Markdown Brief Format

Use headings and checklists. The deterministic planner works without an LLM and
keeps the card model stable.

```md
---
feature_id: KA-001
target_repo: bhargav55/knowledge-assistant
priority: P1
owner: planner-agent
---

# Build Portfolio Chatbot

## Context

The portfolio needs a production chatbot backed by a knowledge base.

## Research Notes

- Static sites cannot hide API URLs.
- Backend must own provider credentials.

## Requirements

- Add a browser-safe chatbot endpoint.
- Ingest portfolio and resume content.
- Wire the frontend to the endpoint.

## Acceptance Criteria

- The chatbot answers questions about Nunchi experience.
- Answers cite retrieved sources.
- No OpenAI key is exposed in frontend code.

## Out of Scope

- Multi-tenant billing.
- Admin UI.
```

## Production Principles

- Durable state before automation. GitHub is the system of record.
- Agent outputs are typed and persisted as issues / sub-issues / PRs.
- The implementer works from a scoped task, not the original vague brief.
- Review checks acceptance criteria, not general vibes.
- Humans validate the final implementation before merge.
