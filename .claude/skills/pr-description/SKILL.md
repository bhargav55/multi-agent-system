---
name: pr-description
description: Write a complete PR description covering the issue, the changes, and the design rationale. Use whenever opening a pull request in this repo, or when asked to write or improve a PR description/body.
---

Every pull request in this repo must explain itself. When you open a PR (or are
asked to write/improve one), the body MUST cover three things, in this order:

1. **What & why** — the issue or motivation: what problem this solves and the
   goal. Link the issue with `Closes #<n>` when one exists.
2. **Changes** — a concrete, scannable list of what actually changed (files,
   behaviours, interfaces). Not a diff dump — the meaningful deltas.
3. **Design rationale** — *why this approach*: the key decisions, the
   alternatives considered, and the tradeoffs accepted. This is the part
   reviewers and future readers need most; never skip it.

Then, when applicable:

4. **Notes for review** — caveats, follow-ups, or risks the reviewer should know.
5. **Tests** — what was run and that it passed (e.g. `bun test`).

## Template

```markdown
Closes #<n>

## What & why
<one short paragraph: the problem and the goal>

## Changes
- <change>
- <change>

## Design rationale
- <decision and why; alternative rejected and the tradeoff>

## Notes for review
- <caveat / follow-up>

## Tests
`<command>` passed.
```

## Rules

- Keep it honest and specific. If a decision was forced by a constraint, say so.
- The "why" is mandatory even for small PRs — one line is fine, but state it.
- Match the depth to the change: a one-line fix needs a sentence each; a design
  change needs the alternatives and tradeoffs spelled out.

> The runtime Implementer agent already emits this structure as the PR body
> (`src/runtime/implementer.ts`). This skill is the same standard for PRs opened
> by hand, so machine- and human-authored PRs read alike.
