/**
 * In-memory GitHubClient for tests. Seed PRs with changed files, reviews, and
 * labels; the services run against it with no network. Records commits,
 * reviews, body writes, labels, and comments for assertions.
 */

import type {
  ChangedFile,
  GitHubClient,
  PullRequest,
  Review,
  ReviewSubmission,
} from "./pr-client";

export type SeedPR = {
  headSha?: string;
  headRef?: string;
  /** "owner/repo"; defaults make a same-repo (non-fork) PR. */
  headRepo?: string;
  baseRepo?: string;
  body?: string;
  labels?: string[];
  changedFiles?: ChangedFile[];
  reviews?: Review[];
};

export type CommittedFile = { branch: string; path: string; content: string; message: string };
export type SubmittedReview = ReviewSubmission & { number: number };

const REPO = "acme/multi-agent-system";
const BASE_URL = `https://github.com/${REPO}`;

export class MockGitHubClient implements GitHubClient {
  private prs: PullRequest[] = [];
  private diffs = new Map<string, string>();
  private nextNumber = 1;
  private viewerLogin = "agent-bot";

  readonly commits: CommittedFile[] = [];
  readonly reviews: SubmittedReview[] = [];
  readonly comments: { number: number; body: string }[] = [];

  /** Insert a PR and return its number. */
  seed(pr: SeedPR = {}): number {
    const number = this.nextNumber++;
    this.prs.push({
      number,
      headSha: pr.headSha ?? `sha-${number}`,
      headRef: pr.headRef ?? `feature/pr-${number}`,
      headRepo: pr.headRepo ?? REPO,
      baseRepo: pr.baseRepo ?? REPO,
      url: `${BASE_URL}/pull/${number}`,
      body: pr.body ?? "",
      labels: [...(pr.labels ?? [])],
      changedFiles: [...(pr.changedFiles ?? [])],
      reviews: [...(pr.reviews ?? [])],
    });
    return number;
  }

  /** Test helper: set the diff returned for a (PR, SHA). */
  setDiff(number: number, sha: string, diff: string): void {
    this.diffs.set(`${number}@${sha}`, diff);
  }

  setViewerLogin(login: string): void {
    this.viewerLogin = login;
  }

  /** Test helper: read a PR's current state. */
  get(number: number): PullRequest {
    const pr = this.find(number);
    return { ...pr, labels: [...pr.labels], changedFiles: [...pr.changedFiles], reviews: [...pr.reviews] };
  }

  private find(number: number): PullRequest {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`No PR #${number}`);
    return pr;
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    return this.prs.map((p) => ({
      ...p,
      labels: [...p.labels],
      changedFiles: [...p.changedFiles],
      reviews: [...p.reviews],
    }));
  }

  async getPullRequestDiff(number: number, sha: string): Promise<string> {
    this.find(number);
    return this.diffs.get(`${number}@${sha}`) ?? `diff for PR #${number} @ ${sha}`;
  }

  async commitFile(branch: string, path: string, content: string, message: string): Promise<void> {
    this.commits.push({ branch, path, content, message });
    // Reflect the commit onto any PR on this branch so derivation sees the new file.
    const pr = this.prs.find((p) => p.headRef === branch);
    if (pr && !pr.changedFiles.some((f) => f.path === path)) {
      pr.changedFiles.push({ path, status: "added" });
    }
  }

  async submitReview(number: number, review: ReviewSubmission): Promise<void> {
    if (!review.commitId) throw new Error("submitReview requires an explicit commitId");
    this.reviews.push({ number, ...review });
    const pr = this.find(number);
    pr.reviews.push({
      state: review.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
      commitId: review.commitId,
      author: this.viewerLogin,
      body: review.body,
    });
  }

  async setPullRequestBody(number: number, body: string): Promise<void> {
    this.find(number).body = body;
  }

  async comment(number: number, body: string): Promise<void> {
    this.find(number);
    this.comments.push({ number, body });
  }

  async addBlockedLabel(number: number): Promise<void> {
    const pr = this.find(number);
    if (!pr.labels.includes("blocked")) pr.labels.push("blocked");
  }

  async removeBlockedLabel(number: number): Promise<void> {
    const pr = this.find(number);
    pr.labels = pr.labels.filter((l) => l !== "blocked");
  }

  async setStatusProjection(number: number, status: string): Promise<void> {
    const pr = this.find(number);
    pr.labels = [...pr.labels.filter((l) => !l.startsWith("status:")), status];
  }

  async getViewerLogin(): Promise<string> {
    return this.viewerLogin;
  }
}
