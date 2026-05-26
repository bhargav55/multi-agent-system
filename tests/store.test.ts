import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalKanbanStore } from "../src/kanban/store";
import type { KanbanCard } from "../src/types";

const tempRoot = async () => mkdtemp(join(tmpdir(), "multi-agent-system-"));

const card = (id: string): KanbanCard => ({
  id,
  title: "Add endpoint",
  status: "ready",
  priority: "P1",
  featureId: "KA-001",
  targetRepo: "bhargav55/knowledge-assistant",
  sourceBrief: "specs/brief.md",
  sourceSpec: "specs/brief.md",
  summary: "Build endpoint.",
  scopedRequirements: {
    goal: "Add endpoint.",
    inScope: ["Add endpoint."],
    outOfScope: [],
    acceptanceCriteria: ["Endpoint responds."],
    researchFindings: ["Use backend credentials."],
    implementationNotes: ["Inspect server first."],
    impactedAreas: ["backend"],
    dependencies: [],
    testStrategy: ["Run API tests."],
  },
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z",
});

describe("LocalKanbanStore", () => {
  it("persists board and card markdown", async () => {
    const rootDir = await tempRoot();
    const store = new LocalKanbanStore({ rootDir });

    const board = await store.addCards([card("card-001-add-endpoint")], new Date("2026-05-26T00:00:00.000Z"));

    expect(board.cards).toHaveLength(1);
    await expect(readFile(join(rootDir, ".kanban", "board.json"), "utf8")).resolves.toContain("card-001-add-endpoint");
    await expect(readFile(join(rootDir, ".kanban", "cards", "card-001-add-endpoint.md"), "utf8")).resolves.toContain("## Research Findings");
  });

  it("moves a card to a new valid status", async () => {
    const rootDir = await tempRoot();
    const store = new LocalKanbanStore({ rootDir });
    await mkdir(rootDir, { recursive: true });
    await store.addCards([card("card-001-add-endpoint")]);

    const moved = await store.moveCard("card-001-add-endpoint", "in-progress", new Date("2026-05-26T01:00:00.000Z"));

    expect(moved.status).toBe("in-progress");
    expect(moved.updatedAt).toBe("2026-05-26T01:00:00.000Z");
  });
});
