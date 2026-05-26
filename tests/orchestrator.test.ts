import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planBriefToKanban } from "../src/orchestrator";

describe("planBriefToKanban", () => {
  it("turns a Markdown brief into Kanban cards", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "multi-agent-system-"));
    const briefPath = join(rootDir, "brief.md");
    await writeFile(
      briefPath,
      `# Build Assistant

## Context

Build a scoped system.

## Requirements

- Create cards from Markdown.

## Acceptance Criteria

- Board JSON is written.
`,
    );

    const board = await planBriefToKanban({
      briefPath,
      rootDir,
      now: new Date("2026-05-26T00:00:00.000Z"),
    });

    expect(board.cards).toHaveLength(1);
    expect(board.cards[0].title).toBe("Create cards from Markdown");
  });
});
