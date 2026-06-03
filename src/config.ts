/**
 * Shared configuration for the GitHub-native multi-agent runtime.
 *
 * GitHub is the single source of truth. Workflow state lives in a single
 * mutually-exclusive `status:*` label per work item; work type is a `type:*`
 * label; the bounded fix loop is tracked by a `fix-round:N` label.
 * See interview-grill.md (decisions 9-13) and architecture.md.
 */

export const STATUSES = [
  "needs-plan",
  "ready",
  "in-progress",
  "in-review",
  "needs-fixes",
  "ready-for-human",
  "done",
  "blocked",
] as const;

export type Status = (typeof STATUSES)[number];

export const statusLabel = (status: Status): string => `status:${status}`;
export const STATUS_LABELS: string[] = STATUSES.map(statusLabel);

/** Parse a `status:*` label back to a Status, or null if it isn't one. */
export const statusFromLabel = (label: string): Status | null => {
  if (!label.startsWith("status:")) return null;
  const value = label.slice("status:".length);
  return (STATUSES as readonly string[]).includes(value) ? (value as Status) : null;
};

export const WORK_KINDS = ["feature", "bug"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const kindLabel = (kind: WorkKind): string => `type:${kind}`;

export const kindFromLabel = (label: string): WorkKind | null => {
  if (!label.startsWith("type:")) return null;
  const value = label.slice("type:".length);
  return (WORK_KINDS as readonly string[]).includes(value) ? (value as WorkKind) : null;
};

/** Max reviewer<->implementer rounds before escalating to a human (decision 11). */
export const FIX_ROUND_CAP = 3;

export const fixRoundLabel = (round: number): string => `fix-round:${round}`;

export const fixRoundFromLabels = (labels: string[]): number => {
  for (const label of labels) {
    if (label.startsWith("fix-round:")) {
      const n = Number.parseInt(label.slice("fix-round:".length), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
};

export type AgentRole = "planner" | "implementer" | "reviewer";

/** Poll cadence per service (decision 5): planner is slow, workers are fast. */
export const POLL_INTERVAL_MS: Record<AgentRole, number> = {
  planner: 30 * 60_000,
  implementer: 3 * 60_000,
  reviewer: 3 * 60_000,
};

/** Default model per role: stronger model for the code-writing implementer. */
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
  /** Default branch PRs target and plan branches fork from. */
  base: string;
};

/**
 * Build runtime config for a service from the environment. Each Railway service
 * sets AGENT_ROLE and a repo-scoped GITHUB_TOKEN; everything else has a default.
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
