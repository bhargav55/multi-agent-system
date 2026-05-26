import type { KanbanCard } from "../types";

export type GitHubIssueDraft = {
  repo: string;
  title: string;
  body: string;
  labels: string[];
};

const section = (title: string, lines: string[]): string => {
  const body = lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- None";
  return `## ${title}\n\n${body}`;
};

export const issueDraftFromCard = (card: KanbanCard): GitHubIssueDraft => {
  if (!card.targetRepo) {
    throw new Error(`Card ${card.id} does not define targetRepo`);
  }

  return {
    repo: card.targetRepo,
    title: `[${card.id}] ${card.title}`,
    labels: ["multi-agent", card.priority.toLowerCase(), card.status],
    body: [
      `Source spec: ${card.sourceSpec}`,
      card.featureId ? `Feature ID: ${card.featureId}` : undefined,
      "",
      "## Summary",
      "",
      card.summary,
      "",
      "## Goal",
      "",
      card.scopedRequirements.goal,
      "",
      section("In Scope", card.scopedRequirements.inScope),
      "",
      section("Out of Scope", card.scopedRequirements.outOfScope),
      "",
      section("Research Findings", card.scopedRequirements.researchFindings),
      "",
      section("Acceptance Criteria", card.scopedRequirements.acceptanceCriteria),
      "",
      section("Implementation Notes", card.scopedRequirements.implementationNotes),
      "",
      section("Test Strategy", card.scopedRequirements.testStrategy),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  };
};

export const issueDraftsFromCards = (cards: KanbanCard[], repo?: string): GitHubIssueDraft[] =>
  cards
    .filter((card) => repo ? card.targetRepo === repo : Boolean(card.targetRepo))
    .map(issueDraftFromCard);
