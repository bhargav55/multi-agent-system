import { readFile } from "node:fs/promises";
import type { CardPriority, TaskBrief } from "./types";

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
  metadata: {},
  title: "Untitled Task Brief",
  context: [],
  researchNotes: [],
  requirements: [],
  acceptanceCriteria: [],
  outOfScope: [],
  rawMarkdown,
});

const cleanHeading = (line: string): string => line.replace(/^#+\s*/, "").trim();

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;

const parsePriority = (value: string): CardPriority | undefined => {
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
  return undefined;
};

const parseFrontmatter = (rawMarkdown: string): { metadata: TaskBrief["metadata"]; body: string } => {
  const match = rawMarkdown.match(FRONTMATTER_PATTERN);
  if (!match) return { metadata: {}, body: rawMarkdown };

  const metadata: TaskBrief["metadata"] = {};
  for (const line of match[1].split(/\r?\n/)) {
    const [, rawKey, rawValue] = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/) ?? [];
    if (!rawKey || !rawValue) continue;

    const key = rawKey.trim().toLowerCase().replace(/-/g, "_");
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (key === "feature_id") metadata.featureId = value;
    if (key === "target_repo") metadata.targetRepo = value;
    if (key === "owner") metadata.owner = value;
    if (key === "priority") metadata.priority = parsePriority(value);
  }

  return { metadata, body: rawMarkdown.slice(match[0].length) };
};

const cleanListItem = (line: string): string =>
  line
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .trim();

const isContentLine = (line: string): boolean => cleanListItem(line).length > 0;

export const parseTaskBrief = (path: string, rawMarkdown: string): TaskBrief => {
  const { metadata, body } = parseFrontmatter(rawMarkdown);
  const brief = {
    ...emptyBrief(path, rawMarkdown),
    metadata,
  };
  let activeSection: SectionName | undefined;

  for (const line of body.split(/\r?\n/)) {
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
