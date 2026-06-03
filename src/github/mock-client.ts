/**
 * In-memory GitHubClient for tests. Models the label-based state machine so
 * agent logic (status transitions, plan-branch creation, PR linking, fix-round
 * counting) can be exercised deterministically with no network.
 */

import { fixRoundLabel, kindLabel, statusFromLabel, statusLabel, type Status } from "../config";
import type { GitHubClient, Issue, PullRequest, PullRequestDraft } from "./client";

const REPO = "https://github.com/acme/multi-agent-system";

/** Drop every label matching `prefix:` and add `next` in its place. */
const replacePrefixedLabel = (labels: string[], prefix: string, next: string): string[] => [
  ...labels.filter((l) => !l.startsWith(`${prefix}:`)),
  next,
];

export type SeedIssue = {
  title: string;
  body?: string;
  status?: Status;
  kind?: Issue["kind"];
  labels?: string[];
};

export type PlanBranch = { branch: string; path: string; content: string };

export class MockGitHubClient implements GitHubClient {
  private issues: Issue[] = [];
  private pulls: PullRequest[] = [];
  private reviewFindings = new Map<number, string>();
  private diffs = new Map<number, string>();
  private planBranches: PlanBranch[] = [];
  private nextNumber = 1;

  /** Test helper: set the diff a PR's getPullRequestDiff should return. */
  setDiff(prNumber: number, diff: string): void {
    this.diffs.set(prNumber, diff);
  }

  /** Test helper: inspect plan branches the planner committed. */
  planBranch(branch: string): PlanBranch | undefined {
    return this.planBranches.find((p) => p.branch === branch);
  }

  /** Test helper: insert an issue and return its assigned number. */
  seed(issue: SeedIssue): number {
    const number = this.nextNumber++;
    const labels = [
      ...(issue.labels ?? []),
      ...(issue.status ? [statusLabel(issue.status)] : []),
      ...(issue.kind ? [kindLabel(issue.kind)] : []),
    ];
    this.issues.push({
      number,
      title: issue.title,
      body: issue.body ?? "",
      labels,
      status: issue.status ?? null,
      kind: issue.kind ?? null,
      url: `${REPO}/issues/${number}`,
    });
    return number;
  }

  private find(number: number): Issue {
    const issue = this.issues.find((i) => i.number === number);
    if (!issue) throw new Error(`No issue #${number}`);
    return issue;
  }

  async listIssuesByStatus(status: Status, kind?: Issue["kind"]): Promise<Issue[]> {
    return this.issues
      .filter((i) => i.status === status && (kind ? i.kind === kind : true))
      .map((i) => ({ ...i, labels: [...i.labels] }));
  }

  async getIssue(number: number): Promise<Issue> {
    const issue = this.find(number);
    return { ...issue, labels: [...issue.labels] };
  }

  async openPlanBranch(branch: string, planPath: string, planContent: string, _message?: string): Promise<void> {
    const existing = this.planBranches.find((p) => p.branch === branch);
    if (existing) {
      existing.path = planPath;
      existing.content = planContent;
    } else {
      this.planBranches.push({ branch, path: planPath, content: planContent });
    }
  }

  async setStatus(number: number, status: Status): Promise<void> {
    const issue = this.find(number);
    issue.labels = replacePrefixedLabel(issue.labels, "status", statusLabel(status));
    issue.status = statusFromLabel(statusLabel(status));
  }

  async setFixRound(number: number, round: number): Promise<void> {
    const issue = this.find(number);
    issue.labels = replacePrefixedLabel(issue.labels, "fix-round", fixRoundLabel(round));
  }

  async comment(number: number, body: string): Promise<void> {
    this.find(number); // assert target exists; comments aren't asserted on in tests
    void body;
  }

  async requestChanges(issueNumber: number, findings: string): Promise<void> {
    this.find(issueNumber);
    this.reviewFindings.set(issueNumber, findings);
  }

  async getReviewFindings(issueNumber: number): Promise<string | null> {
    return this.reviewFindings.get(issueNumber) ?? null;
  }

  async openPullRequest(draft: PullRequestDraft): Promise<PullRequest> {
    const number = this.nextNumber++;
    const pr: PullRequest = {
      number,
      title: draft.title,
      body: draft.body,
      head: draft.head,
      base: draft.base,
      labels: draft.labels ?? [],
      linkedIssue: draft.linkedIssue,
      url: `${REPO}/pull/${number}`,
    };
    this.pulls.push(pr);
    return { ...pr };
  }

  async findPullRequestForIssue(issueNumber: number): Promise<PullRequest | null> {
    const pr = this.pulls.find((p) => p.linkedIssue === issueNumber);
    return pr ? { ...pr } : null;
  }

  async getPullRequestDiff(number: number): Promise<string> {
    const pr = this.pulls.find((p) => p.number === number);
    if (!pr) throw new Error(`No PR #${number}`);
    return this.diffs.get(number) ?? `diff for PR #${number} (${pr.head} -> ${pr.base})`;
  }
}
