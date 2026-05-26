import type { KanbanCard } from "../types";

const list = (items: string[]): string => {
  if (items.length === 0) return "- None";
  return items.map((item) => `- ${item}`).join("\n");
};

export const cardToMarkdown = (card: KanbanCard): string => `# ${card.title}

## Metadata

- ID: ${card.id}
- Status: ${card.status}
- Priority: ${card.priority}
- Source brief: ${card.sourceBrief}
- Created: ${card.createdAt}
- Updated: ${card.updatedAt}

## Summary

${card.summary}

## Goal

${card.scopedRequirements.goal}

## In Scope

${list(card.scopedRequirements.inScope)}

## Out of Scope

${list(card.scopedRequirements.outOfScope)}

## Research Findings

${list(card.scopedRequirements.researchFindings)}

## Acceptance Criteria

${list(card.scopedRequirements.acceptanceCriteria)}

## Implementation Notes

${list(card.scopedRequirements.implementationNotes)}

## Impacted Areas

${list(card.scopedRequirements.impactedAreas)}

## Dependencies

${list(card.scopedRequirements.dependencies)}

## Test Strategy

${list(card.scopedRequirements.testStrategy)}
`;
