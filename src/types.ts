export const CARD_STATUSES = [
  "backlog",
  "ready",
  "in-progress",
  "in-review",
  "needs-fixes",
  "done",
  "blocked",
] as const;

export type CardStatus = (typeof CARD_STATUSES)[number];

export type CardPriority = "P0" | "P1" | "P2" | "P3";

export type ScopedRequirements = {
  goal: string;
  inScope: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  researchFindings: string[];
  implementationNotes: string[];
  impactedAreas: string[];
  dependencies: string[];
  testStrategy: string[];
};

export type KanbanCard = {
  id: string;
  title: string;
  status: CardStatus;
  priority: CardPriority;
  sourceBrief: string;
  summary: string;
  scopedRequirements: ScopedRequirements;
  createdAt: string;
  updatedAt: string;
};

export type Board = {
  version: 1;
  cards: KanbanCard[];
  updatedAt: string;
};

export type TaskBrief = {
  path: string;
  title: string;
  context: string[];
  researchNotes: string[];
  requirements: string[];
  acceptanceCriteria: string[];
  outOfScope: string[];
  rawMarkdown: string;
};

export type PlannerInput = {
  brief: TaskBrief;
  now?: Date;
};

export type PlannerOutput = {
  cards: KanbanCard[];
};

export type PlannerAgent = {
  plan(input: PlannerInput): Promise<PlannerOutput> | PlannerOutput;
};
