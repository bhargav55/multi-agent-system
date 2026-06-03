/**
 * Octokit-backed GitHubClient — the production implementation. Authenticated as
 * the scoped GitHub App / token (decision 4). State transitions are label edits;
 * the PR<->task link is discovered from the `task/<issue>-…` branch convention;
 * reviewer findings ride a marked issue comment.
 *
 * Not unit-tested here (it needs the live App + repo); the agent logic is tested
 * via MockGitHubClient against the same interface.
 */

import { Octokit } from "octokit";
import {
  kindFromLabel,
  kindLabel,
  statusFromLabel,
  statusLabel,
  fixRoundLabel,
  type RepoConfig,
  type Status,
  type WorkKind,
} from "../config";
import type { GitHubClient, Issue, PullRequest, PullRequestDraft } from "./client";

const FINDINGS_MARKER = "<!-- multi-agent:review-findings -->";

type RestLabel = string | { name?: string };

const labelNames = (labels: RestLabel[]): string[] =>
  labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);

const firstStatus = (labels: string[]): Status | null =>
  labels.map(statusFromLabel).find((s): s is Status => s !== null) ?? null;

const firstKind = (labels: string[]): WorkKind | null =>
  labels.map(kindFromLabel).find((k): k is WorkKind => k !== null) ?? null;

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly base: string;

  constructor(repo: RepoConfig, token: string, base = "main") {
    this.octokit = new Octokit({ auth: token });
    this.owner = repo.owner;
    this.repo = repo.repo;
    this.base = base;
  }

  private mapIssue(d: { number: number; title: string; body?: string | null; labels: RestLabel[]; html_url: string }): Issue {
    const labels = labelNames(d.labels);
    return {
      number: d.number,
      title: d.title,
      body: d.body ?? "",
      labels,
      status: firstStatus(labels),
      kind: firstKind(labels),
      url: d.html_url,
    };
  }

  async listIssuesByStatus(status: Status, kind?: WorkKind): Promise<Issue[]> {
    const labels = [statusLabel(status), ...(kind ? [kindLabel(kind)] : [])].join(",");
    const res = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      labels,
      per_page: 100,
    });
    return res.data.filter((d) => !d.pull_request).map((d) => this.mapIssue(d));
  }

  async getIssue(number: number): Promise<Issue> {
    const res = await this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number: number });
    return this.mapIssue(res.data);
  }

  async openPlanBranch(branch: string, planPath: string, planContent: string, message: string): Promise<void> {
    // Create the branch off the base tip if it doesn't already exist.
    const baseRef = await this.octokit.rest.git.getRef({ owner: this.owner, repo: this.repo, ref: `heads/${this.base}` });
    try {
      await this.octokit.rest.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branch}`,
        sha: baseRef.data.object.sha,
      });
    } catch {
      // Branch already exists (e.g. a re-plan); fall through and update the file.
    }

    // Look up the file's current sha on the branch (required to update, omitted to create).
    let sha: string | undefined;
    try {
      const existing = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: planPath,
        ref: branch,
      });
      if (!Array.isArray(existing.data) && "sha" in existing.data) sha = existing.data.sha;
    } catch {
      // File doesn't exist yet on the branch.
    }

    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path: planPath,
      message,
      content: Buffer.from(planContent, "utf8").toString("base64"),
      branch,
      sha,
    });
  }

  /** Replace every `prefix:*` label with `next`, leaving other labels intact. */
  private async replaceLabel(number: number, prefix: string, next: string): Promise<void> {
    const issue = await this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number: number });
    const labels = [...labelNames(issue.data.labels).filter((l) => !l.startsWith(`${prefix}:`)), next];
    await this.octokit.rest.issues.setLabels({ owner: this.owner, repo: this.repo, issue_number: number, labels });
  }

  async setStatus(number: number, status: Status): Promise<void> {
    await this.replaceLabel(number, "status", statusLabel(status));
  }

  async setFixRound(number: number, round: number): Promise<void> {
    await this.replaceLabel(number, "fix-round", fixRoundLabel(round));
  }

  async comment(number: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: number, body });
  }

  async requestChanges(issueNumber: number, findings: string): Promise<void> {
    await this.comment(issueNumber, `${FINDINGS_MARKER}\n${findings}`);
  }

  async getReviewFindings(issueNumber: number): Promise<string | null> {
    const res = await this.octokit.rest.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const marked = res.data.filter((c) => c.body?.startsWith(FINDINGS_MARKER));
    const last = marked.at(-1);
    return last?.body ? last.body.slice(FINDINGS_MARKER.length).trim() : null;
  }

  async openPullRequest(draft: PullRequestDraft): Promise<PullRequest> {
    const res = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: draft.title,
      head: draft.head,
      base: draft.base,
      body: draft.body,
    });
    if (draft.labels?.length) {
      await this.octokit.rest.issues.setLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: res.data.number,
        labels: draft.labels,
      });
    }
    return {
      number: res.data.number,
      title: res.data.title,
      body: res.data.body ?? "",
      head: res.data.head.ref,
      base: res.data.base.ref,
      labels: draft.labels ?? [],
      linkedIssue: draft.linkedIssue,
      url: res.data.html_url,
    };
  }

  async findPullRequestForIssue(issueNumber: number): Promise<PullRequest | null> {
    const res = await this.octokit.rest.pulls.list({ owner: this.owner, repo: this.repo, state: "open", per_page: 100 });
    const pr = res.data.find((p) => p.head.ref.startsWith(`task/${issueNumber}-`));
    if (!pr) return null;
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      head: pr.head.ref,
      base: pr.base.ref,
      labels: labelNames(pr.labels),
      linkedIssue: issueNumber,
      url: pr.html_url,
    };
  }

  async getPullRequestDiff(number: number): Promise<string> {
    const res = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      mediaType: { format: "diff" },
    });
    return res.data as unknown as string;
  }
}
