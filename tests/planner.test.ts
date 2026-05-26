import { describe, expect, it } from "vitest";
import { parseTaskBrief } from "../src/brief";
import { DeterministicPlannerAgent } from "../src/agents/planner";

describe("DeterministicPlannerAgent", () => {
  it("creates scoped implementation cards from requirements", () => {
    const brief = parseTaskBrief(
      "specs/assistant.md",
      `# Assistant

## Context

Build a production knowledge assistant.

## Research Notes

- Frontend cannot expose API keys.

## Requirements

- Add a browser-safe chatbot endpoint.
- Ingest portfolio and resume content.

## Acceptance Criteria

- No provider key is exposed.
- Answers cite sources.

## Out of Scope

- Admin dashboard.
`,
    );

    const output = new DeterministicPlannerAgent().plan({
      brief,
      now: new Date("2026-05-26T00:00:00.000Z"),
    });

    expect(output.cards).toHaveLength(2);
    expect(output.cards[0]).toMatchObject({
      id: "card-001-add-a-browser-safe-chatbot-endpoint",
      title: "Add a browser-safe chatbot endpoint",
      status: "ready",
      priority: "P1",
      sourceBrief: "specs/assistant.md",
      sourceSpec: "specs/assistant.md",
      summary: "Build a production knowledge assistant.",
      scopedRequirements: {
        goal: "Add a browser-safe chatbot endpoint.",
        inScope: ["Add a browser-safe chatbot endpoint."],
        outOfScope: ["Admin dashboard."],
        researchFindings: ["Frontend cannot expose API keys."],
        acceptanceCriteria: ["No provider key is exposed.", "Answers cite sources."],
      },
    });
    expect(output.cards[0].scopedRequirements.impactedAreas).toContain("frontend");
    expect(output.cards[0].scopedRequirements.impactedAreas).toContain("backend");
  });

  it("propagates collaboration metadata into cards", () => {
    const brief = parseTaskBrief(
      "features/assistant.md",
      `---
feature_id: KA-001
target_repo: bhargav55/knowledge-assistant
priority: P0
---

# Assistant

## Requirements

- Add GitHub issue drafts.
`,
    );

    const output = new DeterministicPlannerAgent().plan({
      brief,
      now: new Date("2026-05-26T00:00:00.000Z"),
    });

    expect(output.cards[0]).toMatchObject({
      id: "ka-001-card-001-add-github-issue-drafts",
      priority: "P0",
      featureId: "KA-001",
      targetRepo: "bhargav55/knowledge-assistant",
      sourceSpec: "features/assistant.md",
    });
  });

  it("rejects briefs without requirements", () => {
    const brief = parseTaskBrief("specs/empty.md", "# Empty");

    expect(() => new DeterministicPlannerAgent().plan({ brief })).toThrow(
      "Task brief must include at least one item",
    );
  });
});
