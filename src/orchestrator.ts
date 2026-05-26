import { loadTaskBrief } from "./brief";
import { DeterministicPlannerAgent } from "./agents/planner";
import { LocalKanbanStore } from "./kanban/store";
import type { Board, PlannerAgent } from "./types";

export type PlanBriefInput = {
  briefPath: string;
  rootDir?: string;
  planner?: PlannerAgent;
  now?: Date;
};

export const planBriefToKanban = async ({
  briefPath,
  rootDir = process.cwd(),
  planner = new DeterministicPlannerAgent(),
  now = new Date(),
}: PlanBriefInput): Promise<Board> => {
  const brief = await loadTaskBrief(briefPath);
  const output = await planner.plan({ brief, now });
  const store = new LocalKanbanStore({ rootDir });
  return store.addCards(output.cards, now);
};
