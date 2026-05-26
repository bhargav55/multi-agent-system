# Architecture

## Goal

Build a production-grade multi-agent workflow system where specialized agents plan, implement, and review engineering work through a Kanban-backed task model.

The system starts local-first because local files are easy to version, test, audit, and migrate. Integrations with GitHub Projects, Linear, Jira, or hosted databases can be added later behind the same store interface.

## System Boundary

```txt
Task brief markdown
  -> Orchestrator
  -> Planner Agent
  -> Kanban Store
  -> Implementer Agent
  -> Reviewer Agent
```

The first milestone implements planning and Kanban state. Implementation and review are represented as contracts and will be added after the card schema is stable.

## Agent Responsibilities

### Planner Agent

Input:

- Markdown task brief.
- Optional repository context.
- Optional research notes.

Output:

- One or more Kanban cards.
- Each card contains scoped requirements, research findings, acceptance criteria, constraints, impacted areas, dependencies, and test strategy.

The planner is allowed to reason broadly, but its output must be concrete enough for the implementer to execute without reinterpreting the original brief.

### Implementer Agent

Input:

- One Kanban card.
- Repository context.
- Allowed commands/tools.

Output:

- Code changes.
- Test results.
- Implementation notes.
- Any blocker that prevents completion.

The implementer must stay inside the card scope. New scope should create a new card or move the card to Blocked.

### Reviewer Agent

Input:

- Kanban card.
- Git diff.
- Test output.
- Implementation notes.

Output:

- Findings ordered by severity.
- Pass/fail against acceptance criteria.
- Required fixes or approval.

## Kanban State Model

Cards are durable records. They are stored as both machine-readable board state and human-readable Markdown files.

```txt
.kanban/board.json
.kanban/cards/card-001-add-chatbot-endpoint.md
```

`board.json` is the index. Card Markdown is the reviewable task artifact.

Statuses:

```txt
backlog
ready
in-progress
in-review
needs-fixes
done
blocked
```

## Card Contract

Each card contains:

- `id`
- `title`
- `status`
- `priority`
- `sourceBrief`
- `summary`
- `scopedRequirements`
- `researchFindings`
- `acceptanceCriteria`
- `implementationNotes`
- `impactedAreas`
- `dependencies`
- `testStrategy`
- `createdAt`
- `updatedAt`

The card is the contract between planner, implementer, and reviewer.

## Planner Strategy

The first implementation uses a deterministic planner:

- parse Markdown headings
- collect context and research notes
- turn requirement bullets into cards
- attach shared acceptance criteria and constraints
- infer impacted areas and test strategy from keywords

This is deliberate. Stable state and tests come before LLM planning. An LLM-backed planner can later implement the same `PlannerAgent` interface.

## Provider Configuration

Model selection is configuration:

```txt
PLANNER_MODEL=opus-class-model
IMPLEMENTER_MODEL=sonnet-class-model
REVIEWER_MODEL=gpt-5.5-class-model
```

Provider integrations must not leak into card storage or orchestration logic.

## Failure Handling

- Invalid brief: fail before writing state.
- Duplicate generated card title: deterministic IDs still remain unique.
- Planner uncertainty: create a Blocked card with explicit missing context.
- Implementer discovers new scope: create follow-up card, do not silently expand scope.
- Reviewer rejects work: move card to `needs-fixes` with findings.

## Observability

Future run traces should record:

- agent name
- model/provider
- input card/spec hash
- output card IDs
- commands run
- tests run
- status transitions
- errors

The local-first version exposes state through `.kanban` files and CLI output.

## Testing Strategy

- Planner tests verify Markdown brief decomposition and scoped requirements.
- Store tests verify board persistence and status transitions.
- Future implementer tests should use temporary Git repos and deterministic tool runners.
- Future reviewer tests should use synthetic diffs and known acceptance criteria.
