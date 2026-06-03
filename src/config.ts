/**
 * Shared configuration for the PR-first multi-agent runtime.
 *
 * There is no label state machine: workflow state is DERIVED from each PR's own
 * artifacts (see runtime/derive.ts). Config is just environment loading — the
 * service's role, the repo, the token, the base branch, the model, and the poll
 * cadence.
 */

export type AgentRole = "planner" | "implementer" | "reviewer";

/** Poll cadence per service: the planner is slow, the workers are fast. */
export const POLL_INTERVAL_MS: Record<AgentRole, number> = {
  planner: 30 * 60_000,
  implementer: 3 * 60_000,
  reviewer: 3 * 60_000,
};

/** Default model per role: the stronger model for the code-writing implementer. */
export const DEFAULT_MODEL: Record<AgentRole, string> = {
  planner: "claude-sonnet-4-6",
  implementer: "claude-opus-4-8",
  reviewer: "claude-sonnet-4-6",
};

export type RepoConfig = { owner: string; repo: string };

export type RuntimeConfig = {
  role: AgentRole;
  repo: RepoConfig;
  githubToken: string;
  model: string;
  pollIntervalMs: number;
  /** Default branch PRs target (and the planner/reviewer diff against). */
  base: string;
};

/**
 * Build runtime config for a service from the environment. Each service sets
 * AGENT_ROLE and a repo-scoped GITHUB_TOKEN; everything else has a default.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): RuntimeConfig => {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };

  const role = required("AGENT_ROLE") as AgentRole;
  if (role !== "planner" && role !== "implementer" && role !== "reviewer") {
    throw new Error(`Invalid AGENT_ROLE: ${role}`);
  }
  const [owner, repo] = required("GITHUB_REPO").split("/");
  if (!owner || !repo) throw new Error(`GITHUB_REPO must be "owner/repo", got: ${env.GITHUB_REPO}`);

  return {
    role,
    repo: { owner, repo },
    githubToken: required("GITHUB_TOKEN"),
    model: env.AGENT_MODEL ?? DEFAULT_MODEL[role],
    pollIntervalMs: env.POLL_INTERVAL_MS ? Number(env.POLL_INTERVAL_MS) : POLL_INTERVAL_MS[role],
    base: env.GITHUB_BASE ?? "main",
  };
};
