/**
 * Deterministic names shared by the planner and implementer so they agree on
 * where an issue's work lives — the planner creates the branch + plan file, the
 * implementer checks the same branch out and reads the same plan file.
 */

import type { Issue } from "../github/client";

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "issue";

export const branchForIssue = (issue: Pick<Issue, "number" | "title">): string =>
  `task/${issue.number}-${slugify(issue.title)}`;

export const planPath = (issue: Pick<Issue, "number">): string => `plans/issue-${issue.number}.md`;
