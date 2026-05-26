import { readFile } from "node:fs/promises";
import type { TaskBrief } from "./types";

type SectionName = "context" | "researchNotes" | "requirements" | "acceptanceCriteria" | "outOfScope";

const SECTION_ALIASES: Record<string, SectionName> = {
  context: "context",
  "research notes": "researchNotes",
  research: "researchNotes",
  requirements: "requirements",
  tasks: "requirements",
  "acceptance criteria": "acceptanceCriteria",
  acceptance: "acceptanceCriteria",
  "out of scope": "outOfScope",
  "non goals": "outOfScope",
  "non-goals": "outOfScope",
};

const emptyBrief = (path: string, rawMarkdown: string): TaskBrief => ({
  path,
  title: "Untitled Task Brief",
  context: [],
  researchNotes: [],
  requirements: [],
  acceptanceCriteria: [],
  outOfScope: [],
  rawMarkdown,
});

const cleanHeading = (line: string): string => line.replace(/^#+\s*/, "").trim();

const cleanListItem = (line: string): string =>
  line
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .trim();

const isContentLine = (line: string): boolean => cleanListItem(line).length > 0;

export const parseTaskBrief = (path: string, rawMarkdown: string): TaskBrief => {
  const brief = emptyBrief(path, rawMarkdown);
  let activeSection: SectionName | undefined;

  for (const line of rawMarkdown.split(/\r?\n/)) {
    if (line.startsWith("# ")) {
      brief.title = cleanHeading(line);
      activeSection = undefined;
      continue;
    }

    if (line.startsWith("## ")) {
      activeSection = SECTION_ALIASES[cleanHeading(line).toLowerCase()];
      continue;
    }

    if (!activeSection || !isContentLine(line)) continue;
    brief[activeSection].push(cleanListItem(line));
  }

  return brief;
};

export const loadTaskBrief = async (path: string): Promise<TaskBrief> => {
  const rawMarkdown = await readFile(path, "utf8");
  return parseTaskBrief(path, rawMarkdown);
};
