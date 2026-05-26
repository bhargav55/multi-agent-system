# Multi-Agent System

A production-oriented TypeScript multi-agent workflow system for turning Markdown task briefs into scoped Kanban cards, then driving implementation and review through specialized agents.

This is intentionally not a demo chatbot. The system is built around durable task state, typed agent contracts, auditable card files, and a simple local-first execution model that can later sync to GitHub Projects, Linear, Jira, or another work tracker.

## Core Workflow

```txt
Markdown task brief
-> Planner Agent researches and scopes the work
-> Kanban cards are created with implementation-ready requirements
-> GitHub issue drafts are generated for the target source-code repo
-> Implementer Agent picks a card and executes only that scope
-> Reviewer Agent checks the diff against acceptance criteria
-> Orchestrator moves the card forward or back to Needs Fixes
```

## Collaboration Repo Model

Use a collaboration repo as the source of truth for feature specs and architecture docs. Source-code repos stay focused on implementation.

```txt
multi-agent-collaboration/
  features/
    knowledge-assistant-crawler.md
  architecture/
  decisions/
  research/

knowledge-assistant/
multi-agent-system/
bhargav-portfolio-poc/
```

Each feature spec declares the source-code repo that should receive GitHub issues:

```yaml
---
feature_id: KA-001
target_repo: bhargav55/knowledge-assistant
priority: P1
owner: planner-agent
---
```

The planner reads the collaboration spec, creates Kanban cards, and preserves `target_repo` on every card. Issue creation can then use the card as the contract for implementation.

## Why Multi-Agent

The agents have different responsibilities:

- Planner Agent: researches the brief, decomposes the work, defines scoped requirements, constraints, acceptance criteria, and test strategy.
- Implementer Agent: reads one card at a time and executes the scoped requirements without expanding the task.
- Reviewer Agent: reviews the implementation against the card, tests, risks, and acceptance criteria.

This separation is useful because planning, implementation, and review benefit from different model choices and different prompts.

Recommended model classes:

```txt
Planner Agent     -> Opus-class model
Implementer Agent -> Sonnet-class model
Reviewer Agent    -> GPT-5.5-class model
```

Model names are configuration, not hardcoded business logic.

## Kanban

The first version is local-first:

```txt
.kanban/board.json
.kanban/cards/*.md
```

Columns:

```txt
Backlog
Ready
In Progress
In Review
Needs Fixes
Done
Blocked
```

Each card contains the planner's scoped requirements:

- goal
- in-scope requirements
- out-of-scope boundaries
- research findings
- acceptance criteria
- implementation notes
- impacted areas
- dependencies
- test strategy

The implementer should treat the card as the execution contract.

## Commands

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

The command currently prints issue-ready JSON. Live GitHub issue creation will be added after the card and issue payload contracts are stable.

## Markdown Brief Format

Use headings and checklists. The deterministic planner works without an LLM and keeps the card model stable.

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

## Current Scope

Implemented now:

- Typed Kanban card model.
- Local JSON/Markdown Kanban store.
- Planner agent contract.
- Deterministic planner that creates scoped cards from Markdown briefs.
- CLI for `plan`, `board`, `next`, and `move`.
- GitHub issue draft generation from cards with `target_repo`.
- Tests for planning and Kanban persistence.

Next:

- Add live GitHub issue creation and issue sync.
- Add LLM-backed Planner Agent behind the same interface.
- Add Implementer Agent contract and execution harness.
- Add Reviewer Agent contract with diff/test input.
- Add run traces and model/provider configuration.

## Production Principles

- Durable state before automation.
- Agent outputs are typed and persisted.
- The implementer works from a card, not the original vague brief.
- Review checks the card's acceptance criteria, not general vibes.
- External integrations come after the local state model is stable.
