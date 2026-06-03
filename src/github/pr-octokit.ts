/**
 * Octokit-backed GitHubClient — the production PR-centric implementation. Not
 * unit-tested here (it needs a live token + repo); the service logic is tested
 * against MockGitHubClient behind the same interface.
 *
 * Every review is submitted with an explicit commit_id (never defaulting to
 * latest) so the head-reviewed guard in deriveStage stays race-safe.
 */

import { Octokit } from "octokit";
import type { RepoConfig } from "../config";
import type {
  ChangedFile,
  ChangedFileStatus,
  GitHubClient,
  PullRequest,
  Review,
  ReviewState,
  ReviewSubmission,
} from "./pr-client";

type RestLabel = string | { name?: string };

const labelNames = (labels: RestLabel[]): string[] =>
  labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);

const mapStatus = (s: string): ChangedFileStatus =>
  s === "added" || s === "removed" || s === "modified" || s === "renamed" ? s : "changed";

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly base: string;
  private viewerLogin?: string;

  constructor(repo: RepoConfig, token: string, base = "main") {
    this.octokit = new Octokit({ auth: token });
    this.owner = repo.owner;
    this.repo = repo.repo;
    this.base = base;
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const baseRepo = `${this.owner}/${this.repo}`;
    const list = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });

    const prs: PullRequest[] = [];
    for (const pr of list.data) {
      const [files, reviews] = await Promise.all([
        this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
          owner: this.owner,
          repo: this.repo,
          pull_number: pr.number,
          per_page: 100,
        }),
        this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
          owner: this.owner,
          repo: this.repo,
          pull_number: pr.number,
          per_page: 100,
        }),
      ]);

      const changedFiles: ChangedFile[] = files.map((f) => ({ path: f.filename, status: mapStatus(f.status) }));
      const mapped: Review[] = reviews.map((r) => ({
        state: (r.state ?? "PENDING") as ReviewState,
        commitId: r.commit_id ?? "",
        author: r.user?.login ?? "",
        body: r.body ?? "",
      }));

      prs.push({
        number: pr.number,
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        headRepo: pr.head.repo?.full_name ?? "",
        baseRepo: pr.base.repo?.full_name ?? baseRepo,
        url: pr.html_url,
        body: pr.body ?? "",
        labels: labelNames(pr.labels),
        changedFiles,
        reviews: mapped,
      });
    }
    return prs;
  }

  async getPullRequestDiff(_number: number, sha: string): Promise<string> {
    // Pin the diff to the exact SHA: cumulative changes of `sha` against the base branch.
    const res = await this.octokit.rest.repos.compareCommitsWithBasehead({
      owner: this.owner,
      repo: this.repo,
      basehead: `${this.base}...${sha}`,
      mediaType: { format: "diff" },
    });
    return res.data as unknown as string;
  }

  async commitFile(branch: string, path: string, content: string, message: string): Promise<void> {
    let sha: string | undefined;
    try {
      const existing = await this.octokit.rest.repos.getContent({ owner: this.owner, repo: this.repo, path, ref: branch });
      if (!Array.isArray(existing.data) && "sha" in existing.data) sha = existing.data.sha;
    } catch {
      // File doesn't exist yet on the branch.
    }
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path,
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      sha,
    });
  }

  async submitReview(number: number, review: ReviewSubmission): Promise<void> {
    if (!review.commitId) throw new Error("submitReview requires an explicit commitId");
    await this.octokit.rest.pulls.createReview({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      commit_id: review.commitId,
      event: review.event,
      body: review.body,
    });
  }

  async setPullRequestBody(number: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({ owner: this.owner, repo: this.repo, pull_number: number, body });
  }

  async comment(number: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: number, body });
  }

  async addBlockedLabel(number: number): Promise<void> {
    await this.octokit.rest.issues.addLabels({ owner: this.owner, repo: this.repo, issue_number: number, labels: ["blocked"] });
  }

  async removeBlockedLabel(number: number): Promise<void> {
    await this.octokit.rest.issues
      .removeLabel({ owner: this.owner, repo: this.repo, issue_number: number, name: "blocked" })
      .catch(() => {});
  }

  async setStatusProjection(number: number, status: string): Promise<void> {
    const issue = await this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number: number });
    const labels = [...labelNames(issue.data.labels).filter((l) => !l.startsWith("status:")), status];
    await this.octokit.rest.issues.setLabels({ owner: this.owner, repo: this.repo, issue_number: number, labels });
  }

  async getViewerLogin(): Promise<string> {
    if (this.viewerLogin) return this.viewerLogin;
    const res = await this.octokit.rest.users.getAuthenticated();
    this.viewerLogin = res.data.login;
    return this.viewerLogin;
  }
}
