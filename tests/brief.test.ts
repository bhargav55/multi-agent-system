import { describe, expect, it } from "vitest";
import { parseTaskBrief } from "../src/brief";

describe("parseTaskBrief", () => {
  it("extracts structured sections from a Markdown brief", () => {
    const brief = parseTaskBrief(
      "specs/chatbot.md",
      `# Build Chatbot

## Context

The portfolio needs a knowledge assistant.

## Research Notes

- Static websites cannot hide secrets.
- Backend owns provider credentials.

## Requirements

- Add an API endpoint.
- Wire the frontend.

## Acceptance Criteria

- Answers cite sources.

## Out of Scope

- Billing.
`,
    );

    expect(brief).toMatchObject({
      path: "specs/chatbot.md",
      metadata: {},
      title: "Build Chatbot",
      context: ["The portfolio needs a knowledge assistant."],
      researchNotes: ["Static websites cannot hide secrets.", "Backend owns provider credentials."],
      requirements: ["Add an API endpoint.", "Wire the frontend."],
      acceptanceCriteria: ["Answers cite sources."],
      outOfScope: ["Billing."],
    });
  });

  it("extracts collaboration frontmatter metadata", () => {
    const brief = parseTaskBrief(
      "features/assistant.md",
      `---
feature_id: KA-001
target_repo: bhargav55/knowledge-assistant
priority: P1
owner: planner-agent
---

# Build Assistant

## Requirements

- Add scoped planning.
`,
    );

    expect(brief.metadata).toEqual({
      featureId: "KA-001",
      targetRepo: "bhargav55/knowledge-assistant",
      priority: "P1",
      owner: "planner-agent",
    });
    expect(brief.title).toBe("Build Assistant");
  });
});
