import { describe, expect, it } from "vitest";
import { issueDraftFromCard } from "../src/github/issues";
import type { KanbanCard } from "../src/types";

const card: KanbanCard = {
  id: "ka-001-card-001-add-endpoint",
  title: "Add endpoint",
  status: "ready",
  priority: "P1",
  featureId: "KA-001",
  targetRepo: "bhargav55/knowledge-assistant",
  sourceBrief: "features/assistant.md",
  sourceSpec: "features/assistant.md",
  summary: "Build a scoped endpoint.",
  scopedRequirements: {
    goal: "Add endpoint.",
    inScope: ["Add endpoint."],
    outOfScope: ["Billing."],
    acceptanceCriteria: ["Endpoint responds."],
    researchFindings: ["Backend owns credentials."],
    implementationNotes: ["Inspect server first."],
    impactedAreas: ["backend"],
    dependencies: [],
    testStrategy: ["Run API tests."],
  },
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z",
};

describe("issueDraftFromCard", () => {
  it("creates an issue-ready payload from a card", () => {
    expect(issueDraftFromCard(card)).toMatchObject({
      repo: "bhargav55/knowledge-assistant",
      title: "[ka-001-card-001-add-endpoint] Add endpoint",
      labels: ["multi-agent", "p1", "ready"],
    });
    expect(issueDraftFromCard(card).body).toContain("Source spec: features/assistant.md");
    expect(issueDraftFromCard(card).body).toContain("## Acceptance Criteria");
  });
});
