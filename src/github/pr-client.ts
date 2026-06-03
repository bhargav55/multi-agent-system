/**
 * The PR-centric GitHub seam. One interface every service depends on, with an
 * in-memory mock for tests (pr-mock.ts) and an Octokit adapter for production
 * (pr-octokit.ts). Workflow state is NOT stored here — it is *derived* from a
 * PR's own artifacts (changed files + reviews + head SHA) by `deriveStage`
 * (runtime/derive.ts). See prd/pr-first-runtime.md.
 */

export type ChangedFileStatus = "added" | "modified" | "removed" | "renamed" | "changed";

export type ChangedFile = {
  path: string;
  status: ChangedFileStatus;
};

/** Native PR review states we care about. Reviews are returned chronologically. */
export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export type Review = {
  state: ReviewState;
  /** The SHA the review was pinned to. Load-bearing: head-reviewed = commitId === headSha. */
  commitId: string;
  /** Login of the review's author, so the reviewer can count only its own reviews. */
  author: string;
  /** The review's body (the reviewer's findings; consumed by implementer fix mode). */
  body: string;
};

/**
 * A pull request as the runtime observes it: its identity plus the artifacts
 * state is derived from. (The plan calls this the `ManagedPR` shape; not every
 * listed PR is managed — the managed gate decides that from these fields.)
 */
export type PullRequest = {
  number: number;
  /** Tip commit SHA of the PR's head branch. */
  headSha: string;
  /** The PR's head branch name (services clone and commit to this). */
  headRef: string;
  /** "owner/repo" of the head; a fork has headRepo !== baseRepo. */
  headRepo: string;
  /** "owner/repo" of the base. */
  baseRepo: string;
  url: string;
  body: string;
  labels: string[];
  changedFiles: ChangedFile[];
  /** Native reviews in chronological (submission) order. */
  reviews: Review[];
};

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES";

export type ReviewSubmission = {
  /** MANDATORY. Pins the review to a SHA so a stale review never certifies new code. */
  commitId: string;
  event: ReviewEvent;
  body: string;
};

export interface GitHubClient {
  /** All open PRs with their changed files, reviews, head SHA, and head/base repo identity. */
  listOpenPullRequests(): Promise<PullRequest[]>;

  /** The cumulative diff of a PR computed for a specific SHA (so we review exactly what we read). */
  getPullRequestDiff(number: number, sha: string): Promise<string>;

  /** Commit a single file onto the PR's head branch (the planner's plan commit). */
  commitFile(branch: string, path: string, content: string, message: string): Promise<void>;

  /** Submit a native PR review pinned to `commitId` (required — never defaults to latest). */
  submitReview(number: number, review: ReviewSubmission): Promise<void>;

  /** Overwrite the PR body (the implementer is its sole owner). */
  setPullRequestBody(number: number, body: string): Promise<void>;

  comment(number: number, body: string): Promise<void>;

  /** Park a PR. The only authoritative label; cleared manually by a human. */
  addBlockedLabel(number: number): Promise<void>;
  removeBlockedLabel(number: number): Promise<void>;

  /** Write the cosmetic `status:*` projection label (never read by any trigger). */
  setStatusProjection(number: number, status: string): Promise<void>;

  /** The authenticated bot's login, so the reviewer can identify its own reviews. */
  getViewerLogin(): Promise<string>;
}
