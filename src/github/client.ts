/**
 * The GitHub operations the agents depend on, behind one interface so the
 * planner/implementer/reviewer can be tested against an in-memory mock without
 * any live API calls (testing strategy in architecture.md).
 *
 * Workflow state lives on the *issue* as labels. A pull request is the
 * implementer's linked output, not a separate state store.
 */

import type { Status, WorkKind } from "../config";

export type Issue = {
  number: number;
  title: string;
  /** The human-authored PRD: what/why for this feature or bug. */
  body: string;
  labels: string[];
  status: Status | null;
  kind: WorkKind | null;
  url: string;
};

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  labels: string[];
  /** Issue this PR implements. */
  linkedIssue: number | null;
  url: string;
};

export type PullRequestDraft = {
  title: string;
  body: string;
  head: string;
  base: string;
  linkedIssue: number;
  labels?: string[];
};

export interface GitHubClient {
  /** Issues currently in `status`, optionally filtered by work type. */
  listIssuesByStatus(status: Status, kind?: WorkKind): Promise<Issue[]>;

  getIssue(number: number): Promise<Issue>;

  /**
   * Create (or update) the issue's task branch and commit the implementation
   * plan onto it, so the plan is a versioned file that later rides into the PR.
   */
  openPlanBranch(branch: string, planPath: string, planContent: string, message: string): Promise<void>;

  /** Replace the item's `status:*` label (the workflow state transition). */
  setStatus(number: number, status: Status): Promise<void>;

  /** Replace the item's `fix-round:N` label (bounded reviewer loop counter). */
  setFixRound(number: number, round: number): Promise<void>;

  comment(number: number, body: string): Promise<void>;

  /** Record reviewer findings for a task (the handoff to the implementer's fix loop). */
  requestChanges(issueNumber: number, findings: string): Promise<void>;

  /** The latest reviewer findings recorded for a task, or null if none. */
  getReviewFindings(issueNumber: number): Promise<string | null>;

  openPullRequest(draft: PullRequestDraft): Promise<PullRequest>;

  /** The open PR implementing `issueNumber`, or null if none exists yet. */
  findPullRequestForIssue(issueNumber: number): Promise<PullRequest | null>;

  getPullRequestDiff(number: number): Promise<string>;
}
