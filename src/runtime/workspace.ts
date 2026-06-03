/**
 * Filesystem + git mechanics for the Implementer, behind an interface so the
 * agent logic can be tested with a fake (no real clones, pushes, or SDK calls).
 *
 * The real `GitWorkspace` shells out to git and runs the project's own test
 * command as the deterministic gate: code the implementer writes must compile
 * and pass tests before a PR is opened.
 */

import { exec, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export type TestRun = { ok: boolean; command: string; output: string };

export interface Workspace {
  /** Clone the existing task branch (created by the planner, carrying the plan file). */
  prepareExisting(branch: string): Promise<{ dir: string }>;
  /** Run the project's test command in `dir`; ok = exit 0. */
  runTests(dir: string): Promise<TestRun>;
  /** True if the working tree has uncommitted changes (the agent edited something). */
  hasChanges(dir: string): Promise<boolean>;
  commitAll(dir: string, message: string): Promise<void>;
  push(dir: string, branch: string): Promise<void>;
  cleanup(dir: string): Promise<void>;
}

/** Decide how to run the project's tests: env override, else package.json, else default. */
export const discoverTestCommand = (
  packageJson: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (env.TEST_COMMAND) return env.TEST_COMMAND;
  const pkg = packageJson as { scripts?: Record<string, string> } | null;
  if (pkg?.scripts?.test) return "bun run test";
  return "bun test";
};

export type GitWorkspaceOptions = {
  /** Clone URL including the repo-scoped token, e.g. https://x-access-token:TOKEN@github.com/o/r.git */
  cloneUrl: string;
  authorName?: string;
  authorEmail?: string;
  env?: NodeJS.ProcessEnv;
};

export class GitWorkspace implements Workspace {
  private readonly name: string;
  private readonly email: string;

  constructor(private readonly opts: GitWorkspaceOptions) {
    this.name = opts.authorName ?? "multi-agent-bot";
    this.email = opts.authorEmail ?? "multi-agent-bot@users.noreply.github.com";
  }

  async prepareExisting(branch: string): Promise<{ dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "impl-"));
    await execFileAsync("git", ["clone", "--depth", "1", "--branch", branch, this.opts.cloneUrl, dir]);
    return { dir };
  }

  async runTests(dir: string): Promise<TestRun> {
    let pkg: unknown = null;
    try {
      pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch {
      pkg = null;
    }
    const command = discoverTestCommand(pkg, this.opts.env);
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: dir });
      return { ok: true, command, output: `${stdout}${stderr}` };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, command, output: `${e.stdout ?? ""}${e.stderr ?? String(err)}` };
    }
  }

  async hasChanges(dir: string): Promise<boolean> {
    const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--porcelain"]);
    return stdout.trim().length > 0;
  }

  async commitAll(dir: string, message: string): Promise<void> {
    await execFileAsync("git", ["-C", dir, "add", "-A"]);
    await execFileAsync("git", [
      "-C", dir,
      "-c", `user.name=${this.name}`,
      "-c", `user.email=${this.email}`,
      "commit", "-m", message,
    ]);
  }

  async push(dir: string, branch: string): Promise<void> {
    await execFileAsync("git", ["-C", dir, "push", "origin", branch]);
  }

  async cleanup(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }
}
