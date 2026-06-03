/**
 * Thin adapter over the Claude Agent SDK's agentic loop (decision 9). Agents
 * depend on the `AgentRunner` function type, not the SDK directly, so they can
 * be unit-tested with a fake runner and no network.
 *
 * `settingSources: []` keeps each agent hermetic — it does not inherit the
 * machine's CLAUDE.md, settings, or skills.
 */

import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export type AgentRequest = {
  system: string;
  prompt: string;
  model: string;
  /** Tools auto-allowed without prompting. Omit to restrict to read-only defaults. */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Working directory for file/bash tools (the implementer's checkout). */
  cwd?: string;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  /** When set, the agent must return JSON matching this schema (in `structured`). */
  jsonSchema?: Record<string, unknown>;
  abortController?: AbortController;
};

export type AgentResult = {
  text: string;
  /** Parsed structured output when `jsonSchema` was supplied; otherwise undefined. */
  structured: unknown;
  numTurns: number;
  costUsd: number;
  durationMs: number;
};

export type AgentRunner = (req: AgentRequest) => Promise<AgentResult>;

export const sdkRunner: AgentRunner = async (req) => {
  const options: Options = {
    systemPrompt: req.system,
    model: req.model,
    cwd: req.cwd,
    allowedTools: req.allowedTools,
    disallowedTools: req.disallowedTools,
    maxTurns: req.maxTurns,
    permissionMode: req.permissionMode,
    allowDangerouslySkipPermissions: req.permissionMode === "bypassPermissions" ? true : undefined,
    settingSources: [],
    abortController: req.abortController,
    ...(req.jsonSchema ? { outputFormat: { type: "json_schema", schema: req.jsonSchema } } : {}),
  };

  let result: AgentResult | null = null;
  for await (const message of query({ prompt: req.prompt, options })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") {
      throw new Error(`Agent run did not succeed: ${message.subtype}`);
    }
    result = {
      text: message.result,
      structured: message.structured_output,
      numTurns: message.num_turns,
      costUsd: message.total_cost_usd,
      durationMs: message.duration_ms,
    };
  }
  if (!result) throw new Error("Agent run produced no result message");
  return result;
};
