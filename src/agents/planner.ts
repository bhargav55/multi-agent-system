import type { KanbanCard, PlannerAgent, PlannerInput, PlannerOutput, ScopedRequirements, TaskBrief } from "../types";

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";

const titleFromRequirement = (requirement: string): string => {
  const cleaned = requirement.replace(/[.。]+$/, "").trim();
  if (/^(add|build|create|implement|wire|ingest|update|review|deploy)\b/i.test(cleaned)) {
    return cleaned[0].toUpperCase() + cleaned.slice(1);
  }
  return `Implement ${cleaned[0]?.toLowerCase() ?? ""}${cleaned.slice(1)}`;
};

const inferImpactedAreas = (text: string): string[] => {
  const lower = text.toLowerCase();
  const areas = new Set<string>();

  if (/(frontend|browser|ui|chatbot|static|website)/.test(lower)) areas.add("frontend");
  if (/(endpoint|api|backend|server|provider|credential|secret)/.test(lower)) areas.add("backend");
  if (/(ingest|knowledge base|retrieval|qdrant|document|resume|corpus)/.test(lower)) areas.add("knowledge-base");
  if (/(test|criteria|quality|evaluation|citation)/.test(lower)) areas.add("quality");

  return areas.size > 0 ? [...areas] : ["application"];
};

const inferTestStrategy = (requirement: string, brief: TaskBrief): string[] => {
  const tests = new Set<string>(["Validate the card acceptance criteria before moving to review."]);
  const text = `${requirement}\n${brief.acceptanceCriteria.join("\n")}`.toLowerCase();

  if (/(endpoint|api|server)/.test(text)) tests.add("Add or update API handler tests for success and invalid-request paths.");
  if (/(frontend|browser|ui|chatbot|static)/.test(text)) tests.add("Validate browser-facing JavaScript and perform a local smoke test.");
  if (/(ingest|document|corpus|knowledge base|resume)/.test(text)) tests.add("Run corpus load/ingest checks and verify retrieved sources.");
  if (/(secret|credential|api key)/.test(text)) tests.add("Verify provider secrets are not exposed in frontend code or persisted card output.");

  return [...tests];
};

const implementationNotes = (requirement: string): string[] => [
  "Inspect the existing code paths before editing.",
  "Keep the implementation limited to this card's scoped requirements.",
  `Primary requirement: ${requirement}`,
];

const scopedRequirements = (requirement: string, brief: TaskBrief): ScopedRequirements => ({
  goal: requirement,
  inScope: [requirement],
  outOfScope: brief.outOfScope,
  acceptanceCriteria: brief.acceptanceCriteria,
  researchFindings: brief.researchNotes,
  implementationNotes: implementationNotes(requirement),
  impactedAreas: inferImpactedAreas(requirement),
  dependencies: [],
  testStrategy: inferTestStrategy(requirement, brief),
});

export class DeterministicPlannerAgent implements PlannerAgent {
  plan({ brief, now = new Date() }: PlannerInput): PlannerOutput {
    if (brief.requirements.length === 0) {
      throw new Error("Task brief must include at least one item under ## Requirements or ## Tasks");
    }

    const timestamp = now.toISOString();
    const cards: KanbanCard[] = brief.requirements.map((requirement, index) => {
      const sequence = String(index + 1).padStart(3, "0");
      const title = titleFromRequirement(requirement);

      return {
        id: `card-${sequence}-${slugify(title)}`,
        title,
        status: "ready",
        priority: index === 0 ? "P1" : "P2",
        sourceBrief: brief.path,
        summary: brief.context[0] ?? brief.title,
        scopedRequirements: scopedRequirements(requirement, brief),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });

    return { cards };
  }
}
