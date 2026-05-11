#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const SERVER_NAME = "agent-worker-mcp";
const SERVER_VERSION = "0.2.0";
const DEFAULT_COMMON_WORKER_AGENTS = [
  "claude",
  "gemini",
  "codex",
  "opencode",
  "qwen",
  "kimi",
  "cursor",
  "copilot",
  "droid",
  "pi",
  "openclaw",
];

type ApprovalMode = "all" | "reads" | "deny";
type RunMode = "exec" | "session";

type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_path?: string;
  stderr_path?: string;
  stdout_tail: string;
  stderr_tail: string;
};

type PolicyViolation = {
  type: "forbidden_file_modified" | "outside_allowed_files";
  file: string;
  pattern?: string;
};

type StructuredTestCommand = {
  cmd: string;
  args: string[];
};

type WorkerRunOptions = {
  cwd: string;
  worker_agent: string;
  task_id: string;
  prompt_file: string;
  run_cwd: string;
  session?: string;
  mode: RunMode;
  approval: ApprovalMode;
  json_strict: boolean;
  no_wait: boolean;
  timeout_ms: number;
  capture_diff: boolean;
  test_command?: string | StructuredTestCommand;
  run_label: "run" | "revision";
  allowed_files?: string[];
  forbidden_files?: string[];
  revision_count?: number;
  worktree_path?: string | null;
  existing_result?: any | null;
};

const TaskIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.-]+$/, "Use only letters, numbers, dot, underscore, and dash.");

const WorkerAgentSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Worker agent name must be a simple acpx registry key.");

function getEnv(name: string, fallbackName?: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallbackName) {
    const fallback = process.env[fallbackName]?.trim();
    if (fallback) return fallback;
  }
  return undefined;
}

function defaultWorkerAgent(): string {
  return getEnv("DEFAULT_WORKER_AGENT", "DEFAULT_ACPX_AGENT") ?? "claude";
}

function defaultTimeoutMs(): number {
  const seconds = Number.parseInt(process.env.WORKER_MAX_TIMEOUT_SECONDS ?? "3600", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000;
}

function defaultMaxOutputBytes(): number {
  const bytes = Number.parseInt(process.env.WORKER_MAX_OUTPUT_BYTES ?? "200000", 10);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 200_000;
}

const envApproval = ["all", "reads", "deny"].includes(process.env.ACPX_APPROVAL ?? "")
  ? (process.env.ACPX_APPROVAL as ApprovalMode)
  : "all";
const ApprovalSchema = z.enum(["all", "reads", "deny"]).default(envApproval);
const RunModeSchema = z.enum(["exec", "session"]).default("exec");

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function getAcpxCommand(): { command: string; args_prefix: string[] } {
  const raw = process.env.ACPX_BIN?.trim();
  if (!raw || raw === "acpx") return { command: "acpx", args_prefix: [] };
  if (raw === "npx") return { command: "npx", args_prefix: ["-y", "acpx@latest"] };

  // Also allow ACPX_BIN="npx -y acpx@latest" for convenience.
  const parts = raw.split(/\s+/).filter(Boolean);
  return { command: parts[0], args_prefix: parts.slice(1) };
}

function getAllowedWorkerAgents(): Set<string> | null {
  const raw = getEnv("ALLOWED_WORKER_AGENTS", "ALLOWED_ACPX_AGENTS");
  if (!raw || raw === "*") return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function assertAllowedWorkerAgent(worker_agent: string) {
  const allowed = getAllowedWorkerAgents();
  if (allowed && !allowed.has(worker_agent)) {
    throw new Error(
      `Worker agent '${worker_agent}' is not allowed. Set ALLOWED_WORKER_AGENTS or choose one of: ${[
        ...allowed,
      ].join(", ")}`,
    );
  }
}

function tailBufferAppend(current: string, chunk: Buffer, maxBytes = 24_000): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return next.slice(Math.max(0, next.length - maxBytes));
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingParent(p: string): Promise<string> {
  let cur = p;
  while (!(await exists(cur))) {
    const next = path.dirname(cur);
    if (next === cur) return cur;
    cur = next;
  }
  const st = await stat(cur);
  return st.isDirectory() ? cur : path.dirname(cur);
}

async function assertInside(base: string, target: string) {
  const baseReal = await realpath(base);
  const parent = await nearestExistingParent(target);
  const parentReal = await realpath(parent);

  if (parentReal !== baseReal && !parentReal.startsWith(baseReal + path.sep)) {
    throw new Error(`Path escapes base directory: ${target}`);
  }
}

async function resolveInside(root: string, maybeRelative: string): Promise<string> {
  const resolved = path.resolve(root, maybeRelative);
  await assertInside(root, resolved);
  return resolved;
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  stdout_path?: string;
  stderr_path?: string;
  timeout_ms?: number;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}): Promise<CommandResult> {
  if (params.stdout_path) await ensureDir(path.dirname(params.stdout_path));
  if (params.stderr_path) await ensureDir(path.dirname(params.stderr_path));

  const started = Date.now();
  let stdout_tail = "";
  let stderr_tail = "";
  let timed_out = false;

  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env ?? process.env,
    shell: params.shell ?? false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutStream = params.stdout_path ? createWriteStream(params.stdout_path) : undefined;
  const stderrStream = params.stderr_path ? createWriteStream(params.stderr_path) : undefined;

  child.stdout.on("data", (chunk: Buffer) => {
    stdout_tail = tailBufferAppend(stdout_tail, chunk);
    stdoutStream?.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr_tail = tailBufferAppend(stderr_tail, chunk);
    stderrStream?.write(chunk);
  });

  const timer = params.timeout_ms
    ? setTimeout(() => {
        timed_out = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }, params.timeout_ms)
    : undefined;

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  if (timer) clearTimeout(timer);
  await Promise.all([
    stdoutStream ? new Promise<void>((resolve) => stdoutStream.end(resolve)) : Promise.resolve(),
    stderrStream ? new Promise<void>((resolve) => stderrStream.end(resolve)) : Promise.resolve(),
  ]);

  return {
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    exit_code: code,
    signal,
    timed_out,
    duration_ms: Date.now() - started,
    stdout_path: params.stdout_path,
    stderr_path: params.stderr_path,
    stdout_tail,
    stderr_tail,
  };
}

async function repoRootFrom(input?: string): Promise<string> {
  const candidate = await realpath(path.resolve(input ?? process.cwd()));
  const result = await runCommand({
    command: "git",
    args: ["-C", candidate, "rev-parse", "--show-toplevel"],
    cwd: candidate,
    timeout_ms: 60_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(`cwd is not a git repository: ${candidate}\n${result.stderr_tail}`);
  }
  return realpath(result.stdout_tail.trim());
}

function approvalFlag(mode: ApprovalMode): string {
  switch (mode) {
    case "all":
      return "--approve-all";
    case "reads":
      return "--approve-reads";
    case "deny":
      return "--deny-all";
  }
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

function matchesGlob(file: string, pattern: string): boolean {
  const normalizedFile = file.split(path.sep).join("/");
  const normalizedPattern = pattern.split(path.sep).join("/");
  return globToRegExp(normalizedPattern).test(normalizedFile);
}

function evaluatePolicy(params: {
  changed_files: string[];
  allowed_files?: string[];
  forbidden_files?: string[];
}) {
  const violations: PolicyViolation[] = [];

  for (const file of params.changed_files) {
    for (const pattern of params.forbidden_files ?? []) {
      if (matchesGlob(file, pattern)) {
        violations.push({ type: "forbidden_file_modified", file, pattern });
      }
    }

    if (params.allowed_files?.length) {
      const allowed = params.allowed_files.some((pattern) => matchesGlob(file, pattern));
      if (!allowed) violations.push({ type: "outside_allowed_files", file });
    }
  }

  return {
    forbidden_file_modified: violations.some((v) => v.type === "forbidden_file_modified"),
    outside_allowed_files: violations.some((v) => v.type === "outside_allowed_files"),
    violations,
  };
}

async function createWorktreeIfNeeded(
  root: string,
  task_id: string,
  isolate_worktree: boolean,
  force_recreate = false,
): Promise<string | null> {
  if (!isolate_worktree) return null;
  const worktreePath = path.join(root, ".agent", "worktrees", task_id);
  await assertInside(root, worktreePath);

  if (await exists(worktreePath)) {
    if (force_recreate) {
      await runCommand({
        command: "git",
        args: ["-C", root, "worktree", "remove", "--force", worktreePath],
        cwd: root,
        timeout_ms: 60_000,
      });
    } else {
      return worktreePath;
    }
  }

  await ensureDir(path.dirname(worktreePath));

  // Generate unique branch name; handle existing branch
  let branchName = `agent/${task_id}`;
  const branchCheck = await runCommand({
    command: "git",
    args: ["-C", root, "rev-parse", "--verify", branchName],
    cwd: root,
    timeout_ms: 30_000,
  });
  if (branchCheck.exit_code === 0) {
    const ts = Date.now();
    branchName = `agent/${task_id}-${ts}`;
  }

  const result = await runCommand({
    command: "git",
    args: ["-C", root, "worktree", "add", worktreePath, "-b", branchName, "HEAD"],
    cwd: root,
    timeout_ms: 120_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(`Failed to create git worktree: ${result.stderr_tail}`);
  }
  return worktreePath;
}

async function captureGitArtifacts(root: string, run_cwd: string, resultDir: string, task_id: string) {
  const diff_path = path.join(resultDir, `${task_id}.diff`);
  const cached_diff_path = path.join(resultDir, `${task_id}.cached.diff`);
  const status_path = path.join(resultDir, `${task_id}.status.txt`);
  const untracked_path = path.join(resultDir, `${task_id}.untracked.txt`);
  const changed_files_path = path.join(resultDir, `${task_id}.changed-files.txt`);

  const status = await runCommand({
    command: "git",
    args: ["-C", run_cwd, "status", "--porcelain=v1"],
    cwd: root,
    stdout_path: status_path,
    stderr_path: path.join(resultDir, `${task_id}.git-status.stderr.log`),
    timeout_ms: 60_000,
  });

  const diff = await runCommand({
    command: "git",
    args: ["-C", run_cwd, "diff", "--binary"],
    cwd: root,
    stdout_path: diff_path,
    stderr_path: path.join(resultDir, `${task_id}.git-diff.stderr.log`),
    timeout_ms: 120_000,
  });

  const cachedDiff = await runCommand({
    command: "git",
    args: ["-C", run_cwd, "diff", "--cached", "--binary"],
    cwd: root,
    stdout_path: cached_diff_path,
    stderr_path: path.join(resultDir, `${task_id}.git-cached-diff.stderr.log`),
    timeout_ms: 120_000,
  });

  const untracked = await runCommand({
    command: "git",
    args: ["-C", run_cwd, "ls-files", "--others", "--exclude-standard"],
    cwd: root,
    stdout_path: untracked_path,
    stderr_path: path.join(resultDir, `${task_id}.git-untracked.stderr.log`),
    timeout_ms: 60_000,
  });

  const diffNameOnly = await runCommand({
    command: "git",
    args: ["-C", run_cwd, "diff", "--name-only"],
    cwd: root,
    timeout_ms: 60_000,
  });

  const cachedNameOnly = await runCommand({
    command: "git",
    args: ["-C", run_cwd, "diff", "--cached", "--name-only"],
    cwd: root,
    timeout_ms: 60_000,
  });

  // Merge changed files from all sources
  const changedSet = new Set<string>();
  for (const name of diffNameOnly.stdout_tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    changedSet.add(name);
  }
  for (const name of cachedNameOnly.stdout_tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    changedSet.add(name);
  }
  for (const name of untracked.stdout_tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    changedSet.add(name);
  }

  const changed_files = [...changedSet];
  await writeFile(changed_files_path, changed_files.join("\n") + (changed_files.length ? "\n" : ""));

  return {
    diff_path,
    cached_diff_path,
    status_path,
    untracked_path,
    changed_files_path,
    changed_files,
    status,
    diff,
    cachedDiff,
    untracked,
  };
}

async function readTextIfExists(file: string, maxChars = 30_000): Promise<string | null> {
  if (!(await exists(file))) return null;
  const text = await readFile(file, "utf8");
  if (text.length <= maxChars) return text;
  const headChars = Math.min(4_000, Math.floor(maxChars / 2));
  const tailChars = Math.max(0, maxChars - headChars);
  return text.slice(0, headChars) + `\n\n... [truncated ${text.length - maxChars} chars] ...\n\n` + text.slice(-tailChars);
}

function taskMarkdown(params: {
  task_id: string;
  worker_agent: string;
  instructions: string;
  allowed_files?: string[];
  forbidden_files?: string[];
}) {
  const allowed = params.allowed_files?.length
    ? params.allowed_files.map((f) => `- ${f}`).join("\n")
    : "- Not specified";
  const forbidden = params.forbidden_files?.length
    ? params.forbidden_files.map((f) => `- ${f}`).join("\n")
    : "- Not specified";
  return `# Task: ${params.task_id}\n\n## Worker Agent\n\n${params.worker_agent}\n\n## Instructions\n\n${params.instructions}\n\n## Allowed Files\n\n${allowed}\n\n## Forbidden Files\n\n${forbidden}\n\n## Acceptance Criteria\n\n- Complete the requested implementation.\n- Keep changes minimal and focused.\n- Do not modify forbidden files.\n- Run or support the requested tests when applicable.\n- Return a concise summary of changes, tests run, and remaining risks.\n`;
}

async function loadExistingResult(root: string, task_id: string): Promise<any | null> {
  const resultPath = path.join(root, ".agent", "results", `${task_id}.result.json`);
  const text = await readTextIfExists(resultPath, 2_000_000);
  return text ? JSON.parse(text) : null;
}

type WorkerEventSummary = {
  stop_reason: string | null;
  final_message: string | null;
  tool_calls: string[];
  error_event: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};

function parseWorkerEvents(eventsText: string | null): WorkerEventSummary {
  const summary: WorkerEventSummary = {
    stop_reason: null,
    final_message: null,
    tool_calls: [],
    error_event: null,
    duration_ms: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
  };

  if (!eventsText) return summary;

  const lines = eventsText.split(/\r?\n/).filter(Boolean);
  const messageChunks: string[] = [];
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // acpx JSON-RPC format: session/update notifications
      if (event.method === "session/update" && event.params?.update) {
        const update = event.params.update;
        const su = update.sessionUpdate;

        if (su === "agent_message_chunk" && update.content?.type === "text") {
          messageChunks.push(update.content.text ?? "");
        }
        if (su === "tool_call" || su === "tool_use") {
          summary.tool_calls.push(update.name ?? update.tool ?? "unknown");
        }
        if (su === "usage_update") {
          if (update.cost) {
            summary.cost_usd = update.cost.amount ?? null;
          }
        }
      }

      // Generic event format: {type: "result", ...} or {type: "done", ...}
      if (event.type === "result" || event.type === "done") {
        summary.stop_reason = event.stop_reason ?? event.subtype ?? event.stopReason ?? null;
        if (event.final_message || event.message || event.text) {
          summary.final_message = event.final_message ?? event.message ?? event.text ?? null;
        }
      }
      if (event.type === "tool_call" || event.type === "tool_use") {
        summary.tool_calls.push(event.name ?? event.tool ?? "unknown");
      }
      if (event.type === "error") {
        summary.error_event = event.message ?? event.error ?? JSON.stringify(event);
      }

      // acpx JSON-RPC format: final response with stopReason + usage
      if (event.id != null && event.result?.stopReason) {
        summary.stop_reason = event.result.stopReason;
        if (event.result.usage) {
          summary.input_tokens = event.result.usage.inputTokens ?? null;
          summary.output_tokens = event.result.usage.outputTokens ?? null;
        }
      }

      // Track timestamps for duration calculation
      if (event.timestamp) {
        const ts = new Date(event.timestamp).getTime();
        if (Number.isFinite(ts)) {
          if (firstTimestamp === null) firstTimestamp = ts;
          lastTimestamp = ts;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  // Assemble final message from chunks
  if (messageChunks.length > 0) {
    summary.final_message = messageChunks.join("");
  }

  if (firstTimestamp !== null && lastTimestamp !== null && lastTimestamp > firstTimestamp) {
    summary.duration_ms = lastTimestamp - firstTimestamp;
  }

  return summary;
}

async function runWorkerInternal(options: WorkerRunOptions) {
  assertAllowedWorkerAgent(options.worker_agent);

  const root = await repoRootFrom(options.cwd);
  const agentDir = path.join(root, ".agent");
  const resultDir = path.join(agentDir, "results");
  await ensureDir(resultDir);

  const prompt_file = await resolveInside(root, options.prompt_file);
  const run_cwd = await realpath(options.run_cwd);
  await assertInside(options.worktree_path ? path.dirname(options.worktree_path) : root, run_cwd);

  const existing = options.existing_result;
  const isRevision = options.run_label === "revision";

  const { command, args_prefix } = getAcpxCommand();
  const events_path = path.join(resultDir, `${options.task_id}.${options.run_label}.events.ndjson`);
  const stderr_path = path.join(resultDir, `${options.task_id}.${options.run_label}.stderr.log`);

  // Build result skeleton before acpx so we can write even on failure
  const result_path = path.join(resultDir, `${options.task_id}.result.json`);
  const now = new Date().toISOString();
  const initial_created_at = existing?.created_at ?? now;

  let acpx: CommandResult;
  let test: CommandResult | undefined;
  let git: Awaited<ReturnType<typeof captureGitArtifacts>> | undefined;
  let eventsSummary: WorkerEventSummary | null = null;

  try {
    const args = [
      ...args_prefix,
      "--cwd",
      run_cwd,
      "--format",
      "json",
      "--timeout",
      String(Math.ceil(options.timeout_ms / 1000)),
    ];

    if (options.json_strict) args.push("--json-strict");
    args.push(approvalFlag(options.approval));
    args.push(options.worker_agent);
    if (options.session) args.push("-s", options.session);
    if (options.no_wait) args.push("--no-wait");
    if (options.mode === "exec") args.push("exec");
    args.push("--file", prompt_file);

    acpx = await runCommand({
      command,
      args,
      cwd: root,
      stdout_path: events_path,
      stderr_path,
      timeout_ms: options.timeout_ms,
    });
  } catch (err: any) {
    // Write failure result even when spawn crashes
    const failResult = {
      task_id: options.task_id,
      worker_agent: options.worker_agent,
      status: "failed",
      created_at: initial_created_at,
      updated_at: now,
      cwd: root,
      run_cwd,
      worktree_path: options.worktree_path ?? null,
      session: options.session ?? existing?.session ?? null,
      mode: options.mode,
      approval: options.approval,
      task_path: existing?.task_path ?? path.relative(root, path.join(root, ".agent", "tasks", `${options.task_id}.md`)),
      prompt_file: path.relative(root, prompt_file),
      result_path: path.relative(root, result_path),
      events_path: existing?.events_path ?? (isRevision ? null : path.relative(root, events_path)),
      revision_events_paths: existing?.revision_events_paths ?? [],
      stderr_paths: existing?.stderr_paths ?? [],
      revision_stderr_paths: existing?.revision_stderr_paths ?? [],
      test_log_paths: existing?.test_log_paths ?? [],
      revision_test_log_paths: existing?.revision_test_log_paths ?? [],
      diff_path: existing?.diff_path ?? null,
      cached_diff_path: existing?.cached_diff_path ?? null,
      status_path: existing?.status_path ?? null,
      untracked_path: existing?.untracked_path ?? null,
      changed_files_path: existing?.changed_files_path ?? null,
      test_log_path: existing?.test_log_path ?? null,
      test_stderr_path: existing?.test_stderr_path ?? null,
      changed_files: existing?.changed_files ?? [],
      test_command: options.test_command ?? existing?.test_command ?? null,
      test_exit_code: existing?.test_exit_code ?? null,
      revision_count: existing?.revision_count ?? options.revision_count ?? 0,
      policy: existing?.policy ?? { forbidden_file_modified: false, outside_allowed_files: false, violations: [] },
      allowed_files: options.allowed_files ?? existing?.allowed_files ?? null,
      forbidden_files: options.forbidden_files ?? existing?.forbidden_files ?? null,
      acpx: null,
      test: existing?.test ?? null,
      git: null,
      worker_summary: null,
      worker_stop_reason: null,
      worker_tool_calls: [],
      worker_error_event: null,
      worker_duration_ms: null,
      worker_input_tokens: null,
      worker_output_tokens: null,
      worker_cost_usd: null,
      error: {
        message: `acpx spawn failed: ${err.message}`,
        exit_code: null,
        stderr_path: isRevision ? path.relative(root, stderr_path) : null,
      },
    };
    await writeFile(result_path, JSON.stringify(failResult, null, 2));
    return failResult;
  }

  // Parse events for summary
  const eventsText = await readTextIfExists(events_path, 2_000_000);
  eventsSummary = parseWorkerEvents(eventsText);

  // Run test command if specified
  const test_log_path = path.join(resultDir, `${options.task_id}.${options.run_label}.test.log`);
  const test_stderr_path = path.join(resultDir, `${options.task_id}.${options.run_label}.test.stderr.log`);
  if (options.test_command) {
    const testCmd = typeof options.test_command === "string"
      ? { cmd: options.test_command, args: [] as string[], shell: true as const }
      : { cmd: options.test_command.cmd, args: options.test_command.args, shell: false as const };
    test = await runCommand({
      command: testCmd.cmd,
      args: testCmd.args,
      cwd: run_cwd,
      stdout_path: test_log_path,
      stderr_path: test_stderr_path,
      timeout_ms: options.timeout_ms,
      shell: testCmd.shell,
    });
  }

  // Collect git artifacts
  git = options.capture_diff
    ? await captureGitArtifacts(root, run_cwd, resultDir, options.task_id)
    : undefined;
  const changed_files = git?.changed_files ?? [];
  const policy = evaluatePolicy({
    changed_files,
    allowed_files: options.allowed_files,
    forbidden_files: options.forbidden_files,
  });

  // Determine status
  const status = acpx.exit_code === 0 && !acpx.timed_out ? "completed" : "failed";
  const finalStatus = isRevision && status === "completed" ? "revised" : status;

  // Accumulate revision paths
  const priorRevisionEvents = existing?.revision_events_paths ?? [];
  const newRevisionEvents = isRevision ? [path.relative(root, events_path)] : [];
  const revision_events_paths = [...priorRevisionEvents, ...newRevisionEvents];

  const priorStderr = existing?.stderr_paths ?? [];
  const priorRevisionStderr = existing?.revision_stderr_paths ?? [];
  const newStderrPath = path.relative(root, stderr_path);
  const stderr_paths = isRevision ? priorStderr : [...priorStderr, newStderrPath];
  const revision_stderr_paths = isRevision ? [...priorRevisionStderr, newStderrPath] : priorRevisionStderr;

  const priorTestLogs = existing?.test_log_paths ?? [];
  const priorRevisionTestLogs = existing?.revision_test_log_paths ?? [];
  const test_log_paths = isRevision ? priorTestLogs : (test ? [...priorTestLogs, path.relative(root, test_log_path)] : priorTestLogs);
  const revision_test_log_paths = isRevision && test
    ? [...priorRevisionTestLogs, path.relative(root, test_log_path)]
    : priorRevisionTestLogs;

  const result = {
    task_id: options.task_id,
    worker_agent: options.worker_agent,
    status: finalStatus,
    created_at: initial_created_at,
    updated_at: now,
    cwd: root,
    run_cwd,
    worktree_path: options.worktree_path ?? existing?.worktree_path ?? null,
    session: options.session ?? existing?.session ?? null,
    mode: options.mode,
    approval: options.approval,
    task_path: existing?.task_path ?? path.relative(root, path.join(root, ".agent", "tasks", `${options.task_id}.md`)),
    prompt_file: path.relative(root, prompt_file),
    result_path: path.relative(root, result_path),
    events_path: existing?.events_path ?? (!isRevision ? path.relative(root, events_path) : null),
    revision_events_paths,
    stderr_paths,
    revision_stderr_paths,
    test_log_paths,
    revision_test_log_paths,
    latest_test_log_path: test ? path.relative(root, test_log_path) : existing?.latest_test_log_path ?? null,
    diff_path: git ? path.relative(root, git.diff_path) : existing?.diff_path ?? null,
    cached_diff_path: git ? path.relative(root, git.cached_diff_path) : existing?.cached_diff_path ?? null,
    status_path: git ? path.relative(root, git.status_path) : existing?.status_path ?? null,
    untracked_path: git ? path.relative(root, git.untracked_path) : existing?.untracked_path ?? null,
    changed_files_path: git ? path.relative(root, git.changed_files_path) : existing?.changed_files_path ?? null,
    test_log_path: test ? path.relative(root, test_log_path) : existing?.test_log_path ?? null,
    test_stderr_path: test ? path.relative(root, test_stderr_path) : existing?.test_stderr_path ?? null,
    changed_files,
    test_command: options.test_command ?? existing?.test_command ?? null,
    test_exit_code: test?.exit_code ?? null,
    revision_count: options.revision_count ?? existing?.revision_count ?? 0,
    policy,
    allowed_files: options.allowed_files ?? existing?.allowed_files ?? null,
    forbidden_files: options.forbidden_files ?? existing?.forbidden_files ?? null,
    acpx,
    test: test ?? null,
    git: git
      ? {
          status_exit_code: git.status.exit_code,
          diff_exit_code: git.diff.exit_code,
          cached_diff_exit_code: git.cachedDiff.exit_code,
          untracked_exit_code: git.untracked.exit_code,
        }
      : existing?.git ?? null,
    worker_summary: eventsSummary?.final_message ?? existing?.worker_summary ?? null,
    worker_stop_reason: eventsSummary?.stop_reason ?? existing?.worker_stop_reason ?? null,
    worker_tool_calls: eventsSummary?.tool_calls ?? existing?.worker_tool_calls ?? [],
    worker_error_event: eventsSummary?.error_event ?? existing?.worker_error_event ?? null,
    worker_duration_ms: eventsSummary?.duration_ms ?? existing?.worker_duration_ms ?? null,
    worker_input_tokens: eventsSummary?.input_tokens ?? existing?.worker_input_tokens ?? null,
    worker_output_tokens: eventsSummary?.output_tokens ?? existing?.worker_output_tokens ?? null,
    worker_cost_usd: eventsSummary?.cost_usd ?? existing?.worker_cost_usd ?? null,
    error:
      status === "failed"
        ? {
            message: acpx.timed_out ? "acpx timed out" : `acpx exited with code ${acpx.exit_code}`,
            exit_code: acpx.exit_code,
            stderr_path: path.relative(root, stderr_path),
          }
        : null,
  };

  await writeFile(result_path, JSON.stringify(result, null, 2));
  return result;
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

const StructuredTestCommandSchema = z.union([
  z.string().min(1),
  z.object({ cmd: z.string().min(1), args: z.array(z.string()) }),
]);

server.tool(
  "run_worker",
  "Run a worker agent through acpx. Writes task instructions to .agent/tasks, saves acpx events, stderr, git diff/status, optional test logs, and a stable result JSON under .agent/results.",
  {
    worker_agent: WorkerAgentSchema.default(defaultWorkerAgent()),
    task_id: TaskIdSchema,
    cwd: z.string().optional().describe("Target git repository root. Defaults to the MCP server process cwd."),
    instructions: z.string().min(1).describe("Task instructions for the worker agent."),
    allowed_files: z.array(z.string()).optional(),
    forbidden_files: z.array(z.string()).optional(),
    worker_cwd: z.string().optional().describe("Directory for acpx --cwd, relative to cwd. Defaults to cwd."),
    isolate_worktree: z.boolean().default(false),
    force_recreate_worktree: z.boolean().default(false).describe("If true and worktree exists, remove and recreate it."),
    session: z.string().optional().describe("Optional acpx named session, passed as -s <session>."),
    mode: RunModeSchema,
    approval: ApprovalSchema,
    json_strict: z.boolean().default(true),
    no_wait: z.boolean().default(false).describe("DEPRECATED: not supported yet. Will return an error if set to true."),
    capture_diff: z.boolean().default(true),
    test_command: StructuredTestCommandSchema.optional().describe("Optional command to run after acpx. String form: 'npm test -- auth' (runs via shell). Object form: {cmd:'npm', args:['test','--','auth']} (no shell, safer)."),
    timeout_ms: z.number().int().positive().max(86_400_000).default(defaultTimeoutMs()),
  },
  async (input) => {
    if (input.no_wait) {
      return textResult({ error: "no_wait is not currently supported. Set no_wait=false." });
    }

    const root = await repoRootFrom(input.cwd);
    const agentDir = path.join(root, ".agent");
    const taskDir = path.join(agentDir, "tasks");
    const resultDir = path.join(agentDir, "results");
    await ensureDir(taskDir);
    await ensureDir(resultDir);

    const worktree_path = await createWorktreeIfNeeded(root, input.task_id, input.isolate_worktree, input.force_recreate_worktree);
    const run_cwd = worktree_path
      ? worktree_path
      : input.worker_cwd
        ? await resolveInside(root, input.worker_cwd)
        : root;

    const taskFile = path.join(taskDir, `${input.task_id}.md`);
    await writeFile(
      taskFile,
      taskMarkdown({
        task_id: input.task_id,
        worker_agent: input.worker_agent,
        instructions: input.instructions,
        allowed_files: input.allowed_files,
        forbidden_files: input.forbidden_files,
      }),
    );

    const result = await runWorkerInternal({
      cwd: root,
      worker_agent: input.worker_agent,
      task_id: input.task_id,
      prompt_file: path.relative(root, taskFile),
      run_cwd,
      session: input.session,
      mode: input.mode,
      approval: input.approval,
      json_strict: input.json_strict,
      no_wait: false,
      timeout_ms: input.timeout_ms,
      capture_diff: input.capture_diff,
      test_command: input.test_command,
      run_label: "run",
      allowed_files: input.allowed_files,
      forbidden_files: input.forbidden_files,
      revision_count: 0,
      worktree_path,
      existing_result: null,
    });

    return textResult(result);
  },
);

server.tool(
  "revise_worker",
  "Send reviewer feedback back to the worker agent through acpx. Builds a revision prompt from the original task and feedback, then captures new events/diff/test logs. Preserves run history and accumulates revision artifacts.",
  {
    worker_agent: WorkerAgentSchema.default(defaultWorkerAgent()),
    task_id: TaskIdSchema,
    cwd: z.string().optional(),
    review_feedback: z.string().min(1).describe("Blocking review feedback from the upstream reviewer agent."),
    allowed_files: z.array(z.string()).optional().describe("Override allowed files. Defaults to original task's allowed_files."),
    forbidden_files: z.array(z.string()).optional().describe("Override forbidden files. Defaults to original task's forbidden_files."),
    worker_cwd: z.string().optional(),
    session: z.string().optional(),
    mode: RunModeSchema,
    approval: ApprovalSchema,
    json_strict: z.boolean().default(true),
    no_wait: z.boolean().default(false).describe("DEPRECATED: not supported yet. Will return an error if set to true."),
    capture_diff: z.boolean().default(true),
    test_command: StructuredTestCommandSchema.optional().describe("Optional test command. Defaults to original task's test_command."),
    timeout_ms: z.number().int().positive().max(86_400_000).default(defaultTimeoutMs()),
  },
  async (input) => {
    if (input.no_wait) {
      return textResult({ error: "no_wait is not currently supported. Set no_wait=false." });
    }

    const root = await repoRootFrom(input.cwd);
    const existing = await loadExistingResult(root, input.task_id);
    const agentDir = path.join(root, ".agent");
    const taskFile = path.join(agentDir, "tasks", `${input.task_id}.md`);
    if (!(await exists(taskFile))) throw new Error(`Missing original task file: ${taskFile}`);

    const reviewsDir = path.join(agentDir, "reviews");
    const resultDir = path.join(agentDir, "results");
    await ensureDir(reviewsDir);
    await ensureDir(resultDir);

    const reviewFile = path.join(reviewsDir, `${input.task_id}.md`);
    await writeFile(reviewFile, input.review_feedback);

    const originalTask = await readFile(taskFile, "utf8");
    const revisionPrompt = `# Original Task\n\n${originalTask}\n\n# Review Feedback\n\n${input.review_feedback}\n\n# Revision Instructions\n\nFix only the blocking issues identified by the reviewer. Do not perform unrelated refactors. Do not modify forbidden files. Keep the patch minimal and focused. When finished, summarize changed files, tests run, and remaining risks.\n`;
    const revisionPromptFile = path.join(resultDir, `${input.task_id}.revise.prompt.md`);
    await writeFile(revisionPromptFile, revisionPrompt);

    const run_cwd = input.worker_cwd
      ? await resolveInside(root, input.worker_cwd)
      : existing?.run_cwd
        ? await realpath(existing.run_cwd)
        : root;

    // Inherit allowed_files / forbidden_files from existing result or original task
    const allowed_files = input.allowed_files ?? existing?.allowed_files ?? undefined;
    const forbidden_files = input.forbidden_files ?? existing?.forbidden_files ?? undefined;
    const test_command = input.test_command ?? existing?.test_command ?? undefined;

    const worktree_path = existing?.worktree_path ?? null;
    const revision_count = Number.isFinite(existing?.revision_count) ? existing.revision_count + 1 : 1;

    const result = await runWorkerInternal({
      cwd: root,
      worker_agent: input.worker_agent,
      task_id: input.task_id,
      prompt_file: path.relative(root, revisionPromptFile),
      run_cwd,
      session: input.session ?? existing?.session ?? undefined,
      mode: input.mode,
      approval: input.approval,
      json_strict: input.json_strict,
      no_wait: false,
      timeout_ms: input.timeout_ms,
      capture_diff: input.capture_diff,
      test_command,
      run_label: "revision",
      allowed_files,
      forbidden_files,
      revision_count,
      worktree_path,
      existing_result: existing,
    });

    return textResult(result);
  },
);

server.tool(
  "read_worker_result",
  "Read saved worker artifacts for review: result JSON, git diff/status, test log, and tails of acpx event/stderr logs.",
  {
    task_id: TaskIdSchema,
    cwd: z.string().optional(),
    include_diff: z.boolean().default(true),
    include_test_log: z.boolean().default(true),
    include_events: z.boolean().default(false),
    max_bytes: z.number().int().positive().max(1_000_000).default(defaultMaxOutputBytes()),
  },
  async (input) => {
    const root = await repoRootFrom(input.cwd);
    const maxChars = input.max_bytes;
    const resultDir = path.join(root, ".agent", "results");
    const resultPath = path.join(resultDir, `${input.task_id}.result.json`);
    const resultText = await readTextIfExists(resultPath, maxChars);
    const parsed = resultText ? JSON.parse(resultText) : null;

    const paths = {
      result_path: path.relative(root, resultPath),
      run_events_path: path.relative(root, path.join(resultDir, `${input.task_id}.run.events.ndjson`)),
      run_stderr_path: path.relative(root, path.join(resultDir, `${input.task_id}.run.stderr.log`)),
      revision_events_path: path.relative(root, path.join(resultDir, `${input.task_id}.revision.events.ndjson`)),
      revision_stderr_path: path.relative(root, path.join(resultDir, `${input.task_id}.revision.stderr.log`)),
      diff_path: path.relative(root, path.join(resultDir, `${input.task_id}.diff`)),
      status_path: path.relative(root, path.join(resultDir, `${input.task_id}.status.txt`)),
      run_test_log_path: path.relative(root, path.join(resultDir, `${input.task_id}.run.test.log`)),
      revision_test_log_path: path.relative(root, path.join(resultDir, `${input.task_id}.revision.test.log`)),
    };

    const abs = (rel: string) => path.join(root, rel);

    function truncRead(text: string | null, limit: number): { value: string | null; truncated: boolean } {
      if (!text) return { value: null, truncated: false };
      const truncated = text.length > limit;
      return {
        value: truncated
          ? text.slice(0, Math.floor(limit / 2)) + `\n\n... [truncated ${text.length - limit} chars] ...\n\n` + text.slice(-Math.floor(limit / 2))
          : text,
        truncated,
      };
    }

    const diffRaw = input.include_diff ? await readTextIfExists(abs(paths.diff_path), 2_000_000) : null;
    const runEventsRaw = input.include_events ? await readTextIfExists(abs(paths.run_events_path), 2_000_000) : null;
    const revEventsRaw = input.include_events ? await readTextIfExists(abs(paths.revision_events_path), 2_000_000) : null;
    const runTestRaw = input.include_test_log ? await readTextIfExists(abs(paths.run_test_log_path), 2_000_000) : null;
    const revTestRaw = input.include_test_log ? await readTextIfExists(abs(paths.revision_test_log_path), 2_000_000) : null;
    const statusRaw = await readTextIfExists(abs(paths.status_path), 50_000);
    const runStderrRaw = await readTextIfExists(abs(paths.run_stderr_path), 50_000);
    const revStderrRaw = await readTextIfExists(abs(paths.revision_stderr_path), 50_000);

    const diffResult = truncRead(diffRaw, maxChars);
    const runEventsResult = truncRead(runEventsRaw, maxChars);
    const revEventsResult = truncRead(revEventsRaw, maxChars);
    const runTestResult = truncRead(runTestRaw, maxChars);
    const revTestResult = truncRead(revTestRaw, maxChars);
    const statusResult = truncRead(statusRaw, 20_000);
    const runStderrResult = truncRead(runStderrRaw, 20_000);
    const revStderrResult = truncRead(revStderrRaw, 20_000);
    const resultTextResult = truncRead(resultText, maxChars);

    const out = {
      task_id: input.task_id,
      result: resultTextResult.value ? JSON.parse(resultTextResult.value) : null,
      artifacts: paths,
      diff: diffResult.value,
      status: statusResult.value,
      run_events: runEventsResult.value,
      run_stderr: runStderrResult.value,
      revision_events: revEventsResult.value,
      revision_stderr: revStderrResult.value,
      run_test_log: runTestResult.value,
      revision_test_log: revTestResult.value,
      truncated: {
        result: resultTextResult.truncated,
        diff: diffResult.truncated,
        status: statusResult.truncated,
        run_events: runEventsResult.truncated,
        run_stderr: runStderrResult.truncated,
        revision_events: revEventsResult.truncated,
        revision_stderr: revStderrResult.truncated,
        run_test_log: runTestResult.truncated,
        revision_test_log: revTestResult.truncated,
      },
    };

    return textResult(out);
  },
);

server.tool(
  "cancel_worker",
  "Ask acpx to cooperatively cancel an in-flight prompt for a worker agent/session.",
  {
    task_id: TaskIdSchema.optional(),
    worker_agent: WorkerAgentSchema.default(defaultWorkerAgent()),
    cwd: z.string().optional(),
    worker_cwd: z.string().optional(),
    session: z.string().optional(),
    timeout_ms: z.number().int().positive().max(300_000).default(60_000),
  },
  async (input) => {
    assertAllowedWorkerAgent(input.worker_agent);
    const root = await repoRootFrom(input.cwd);
    const workerCwd = input.worker_cwd ? await resolveInside(root, input.worker_cwd) : root;
    const resultDir = path.join(root, ".agent", "results");
    await ensureDir(resultDir);
    const { command, args_prefix } = getAcpxCommand();
    const args = [...args_prefix, "--cwd", workerCwd, input.worker_agent];
    if (input.session) args.push("-s", input.session);
    args.push("cancel");

    const result = await runCommand({
      command,
      args,
      cwd: root,
      stdout_path: path.join(resultDir, `cancel.${input.worker_agent}.stdout.log`),
      stderr_path: path.join(resultDir, `cancel.${input.worker_agent}.stderr.log`),
      timeout_ms: input.timeout_ms,
    });

    const cancelAttempted = true;
    const cancelSucceeded = result.exit_code === 0;
    const cancelResult = {
      task_id: input.task_id ?? null,
      worker_agent: input.worker_agent,
      status: cancelSucceeded ? "cancel_requested" : "cancel_failed",
      cancel: {
        attempted: cancelAttempted,
        succeeded: cancelSucceeded,
        exit_code: result.exit_code,
        signal: result.signal,
        timed_out: result.timed_out,
        duration_ms: result.duration_ms,
        error: cancelSucceeded ? null : result.stderr_tail || "cancel command failed",
        note: "cancel_worker is best-effort. It sends a cancel request to acpx but may not stop an already-running process.",
      },
    };

    if (input.task_id) {
      const existing = await loadExistingResult(root, input.task_id);
      if (existing) {
        existing.status = cancelSucceeded ? "cancel_requested" : "cancel_failed";
        existing.updated_at = new Date().toISOString();
        existing.cancel = cancelResult.cancel;
        await writeFile(
          path.join(root, ".agent", "results", `${input.task_id}.result.json`),
          JSON.stringify(existing, null, 2),
        );
      }
    }

    return textResult(cancelResult);
  },
);

server.tool(
  "list_worker_agents",
  "Return the worker agents this MCP server is configured to allow, plus common acpx agent registry keys.",
  {},
  async () => {
    const allowed = getAllowedWorkerAgents();
    return textResult({
      default_worker_agent: defaultWorkerAgent(),
      allowed_worker_agents: allowed ? [...allowed] : "*",
      common_acpx_agents: DEFAULT_COMMON_WORKER_AGENTS,
      acpx_bin: process.env.ACPX_BIN ?? "acpx",
      approval_default: process.env.ACPX_APPROVAL ?? "all",
      env_aliases_supported: {
        DEFAULT_ACPX_AGENT: "DEFAULT_WORKER_AGENT",
        ALLOWED_ACPX_AGENTS: "ALLOWED_WORKER_AGENTS",
      },
    });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-start the server when run as the main module (not imported for testing).
if (!process.env.VITEST) {
  main().catch((error) => {
    console.error(`[${SERVER_NAME}] fatal`, error);
    process.exit(1);
  });
}
