#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
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
  cancelled?: boolean;
  cancel_reason?: string | null;
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

type InjectedContextFile = {
  kind: "skill" | "context";
  path: string;
  content: string;
  truncated: boolean;
  original_bytes: number;
  included_bytes: number;
};

type WorkerRunOptions = {
  cwd: string;
  worker_agent: string;
  task_id: string;
  prompt_file: string;
  run_cwd: string;
  session?: string;
  model?: string;
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
  skill_paths?: string[];
  context_files?: string[];
  injected_context_files?: InjectedContextFile[];
  revision_count?: number;
  worktree_path?: string | null;
  existing_result?: any | null;
  abort_signal?: AbortSignal;
};

type RunningWorkerResultParams = {
  task_id: string;
  worker_agent: string;
  root: string;
  run_cwd: string;
  prompt_file: string;
  result_path: string;
  events_path: string;
  stderr_path: string;
  run_label: "run" | "revision";
  created_at: string;
  mode: RunMode;
  approval: ApprovalMode;
  json_strict: boolean;
  timeout_ms: number;
  capture_diff: boolean;
  session?: string | null;
  model?: string | null;
  test_command?: string | StructuredTestCommand | null;
  allowed_files?: string[] | null;
  forbidden_files?: string[] | null;
  skill_paths?: string[] | null;
  context_files?: string[] | null;
  injected_context_files?: InjectedContextFile[];
  worktree_path?: string | null;
  existing_result?: any | null;
  revision_count?: number;
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
  return getEnv("DEFAULT_WORKER_AGENT") ?? "claude";
}

function defaultTimeoutMs(): number {
  const seconds = Number.parseInt(process.env.WORKER_MAX_TIMEOUT_SECONDS ?? "3600", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000;
}

function defaultMaxOutputBytes(): number {
  const bytes = Number.parseInt(process.env.WORKER_MAX_OUTPUT_BYTES ?? "200000", 10);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 200_000;
}

function defaultMaxContextFileBytes(): number {
  const bytes = Number.parseInt(process.env.WORKER_MAX_CONTEXT_FILE_BYTES ?? "80000", 10);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 80_000;
}

const envApproval = ["all", "reads", "deny"].includes(process.env.ACPX_APPROVAL ?? "")
  ? (process.env.ACPX_APPROVAL as ApprovalMode)
  : "all";
const ApprovalSchema = z.enum(["all", "reads", "deny"]).default(envApproval);
const RunModeSchema = z.enum(["exec", "session"]).default("exec");
type ActiveBackgroundJob = {
  started_at: string;
  task_id: string;
  promise: Promise<unknown>;
  cancel: (reason: string) => void;
};

const activeBackgroundJobs = new Map<string, ActiveBackgroundJob>();

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

function relativeResultPath(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
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
  abort_signal?: AbortSignal;
}): Promise<CommandResult> {
  if (params.stdout_path) await ensureDir(path.dirname(params.stdout_path));
  if (params.stderr_path) await ensureDir(path.dirname(params.stderr_path));

  const started = Date.now();
  let stdout_tail = "";
  let stderr_tail = "";
  let timed_out = false;
  let cancelled = false;
  let cancel_reason: string | null = null;
  let killTimer: NodeJS.Timeout | undefined;

  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env ?? process.env,
    shell: params.shell ?? false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const terminateChild = (reason: string) => {
    cancelled = true;
    cancel_reason = reason;
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    killTimer.unref();
  };

  const onAbort = () => {
    terminateChild(String(params.abort_signal?.reason ?? "cancelled"));
  };
  if (params.abort_signal?.aborted) {
    onAbort();
  } else {
    params.abort_signal?.addEventListener("abort", onAbort, { once: true });
  }

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
        terminateChild("timeout");
      }, params.timeout_ms)
    : undefined;

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  if (timer) clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  params.abort_signal?.removeEventListener("abort", onAbort);
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
    cancelled,
    cancel_reason,
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

export function artifactLabelForRun(run_label: "run" | "revision", revision_count = 0): string {
  if (run_label === "run") return "run";
  const safeRevision = Number.isFinite(revision_count) && revision_count > 0 ? revision_count : 1;
  return `revision-${safeRevision}`;
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

function absArtifactPath(root: string, artifactPath: unknown): string | null {
  if (typeof artifactPath !== "string" || !artifactPath) return null;
  return path.isAbsolute(artifactPath) ? artifactPath : path.join(root, artifactPath);
}

function firstPath(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

function lastPath(value: unknown): string | null {
  return Array.isArray(value) && typeof value[value.length - 1] === "string" ? value[value.length - 1] : null;
}

export function selectWorkerResultArtifactPaths(parsed: any, root: string, task_id: string) {
  const resultDir = path.join(root, ".agent", "results");
  const fallback = (suffix: string) => path.join(resultDir, `${task_id}.${suffix}`);

  return {
    runEventsPath: absArtifactPath(root, parsed.events_path) ?? fallback("run.events.ndjson"),
    latestRevisionEventsPath: absArtifactPath(root, lastPath(parsed.revision_events_paths)),
    runStderrPath: absArtifactPath(root, firstPath(parsed.stderr_paths)) ?? fallback("run.stderr.log"),
    latestRevisionStderrPath: absArtifactPath(root, lastPath(parsed.revision_stderr_paths)),
    runTestLogPath:
      absArtifactPath(root, firstPath(parsed.test_log_paths) ?? parsed.initial_test_log_path ?? parsed.test_log_path) ??
      fallback("run.test.log"),
    latestRevisionTestLogPath:
      absArtifactPath(root, lastPath(parsed.revision_test_log_paths) ?? parsed.latest_test_log_path) ?? null,
  };
}

export function summarizeAcpxHelp(helpText: string, expectedFlags: string[]): Record<string, boolean> {
  return Object.fromEntries(expectedFlags.map((flag) => [flag, helpText.includes(flag)]));
}

export function resolveWorktreePathFromResult(parsed: any, root: string): string | null {
  const worktreePath = parsed?.worktree_path;
  if (typeof worktreePath !== "string" || !worktreePath) return null;
  return path.isAbsolute(worktreePath) ? worktreePath : path.join(root, worktreePath);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildInjectedContextMarkdown(files: InjectedContextFile[]): string {
  if (!files.length) return "";

  const renderFile = (file: InjectedContextFile) => {
    const tag = file.kind === "skill" ? "skill" : "context_file";
    const attrs = [
      `path="${escapeXmlAttribute(file.path)}"`,
      `truncated="${file.truncated ? "true" : "false"}"`,
      `original_bytes="${file.original_bytes}"`,
      `included_bytes="${file.included_bytes}"`,
    ].join(" ");
    return `<${tag} ${attrs}>
${file.content}
</${tag}>`;
  };

  const skills = files.filter((file) => file.kind === "skill");
  const contexts = files.filter((file) => file.kind === "context");
  const sections: string[] = [];

  if (skills.length) {
    sections.push(`## Required Skills

The worker must follow these injected skill instructions before working on the task.

${skills.map(renderFile).join("\n\n")}`);
  }

  if (contexts.length) {
    sections.push(`## Context Files

The following files were provided as read-only context for this task.

${contexts.map(renderFile).join("\n\n")}`);
  }

  return sections.join("\n\n");
}

export function extractRecentLines(text: string | null | undefined, limit: number): string[] {
  if (!text || limit <= 0) return [];
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-limit);
}

export function buildRunningWorkerResult(params: RunningWorkerResultParams) {
  const isRevision = params.run_label === "revision";
  const existing = params.existing_result;
  const taskPath = path.join(params.root, ".agent", "tasks", `${params.task_id}.md`);
  const status = isRevision ? "revising" : "running";
  const stderrRel = relativeResultPath(params.root, params.stderr_path);
  const eventsRel = relativeResultPath(params.root, params.events_path);
  const priorStderr = existing?.stderr_paths ?? [];
  const priorRevisionStderr = existing?.revision_stderr_paths ?? [];

  return {
    task_id: params.task_id,
    worker_agent: params.worker_agent,
    status,
    created_at: existing?.created_at ?? params.created_at,
    updated_at: params.created_at,
    cwd: params.root,
    run_cwd: params.run_cwd,
    worktree_path: params.worktree_path ?? existing?.worktree_path ?? null,
    session: params.session ?? existing?.session ?? null,
    model: params.model ?? existing?.model ?? null,
    mode: params.mode,
    approval: params.approval,
    json_strict: params.json_strict,
    timeout_ms: params.timeout_ms,
    capture_diff: params.capture_diff,
    task_path: existing?.task_path ?? relativeResultPath(params.root, taskPath),
    prompt_file: relativeResultPath(params.root, params.prompt_file),
    result_path: relativeResultPath(params.root, params.result_path),
    events_path: existing?.events_path ?? (!isRevision ? eventsRel : null),
    revision_events_paths: [
      ...(existing?.revision_events_paths ?? []),
      ...(isRevision ? [eventsRel] : []),
    ],
    stderr_paths: isRevision ? priorStderr : [...priorStderr, stderrRel],
    revision_stderr_paths: isRevision ? [...priorRevisionStderr, stderrRel] : priorRevisionStderr,
    test_log_paths: existing?.test_log_paths ?? [],
    revision_test_log_paths: existing?.revision_test_log_paths ?? [],
    latest_test_log_path: existing?.latest_test_log_path ?? null,
    diff_path: existing?.diff_path ?? null,
    cached_diff_path: existing?.cached_diff_path ?? null,
    status_path: existing?.status_path ?? null,
    untracked_path: existing?.untracked_path ?? null,
    changed_files_path: existing?.changed_files_path ?? null,
    test_log_path: existing?.test_log_path ?? null,
    test_stderr_path: existing?.test_stderr_path ?? null,
    changed_files: existing?.changed_files ?? [],
    test_command: params.test_command ?? existing?.test_command ?? null,
    test_exit_code: existing?.test_exit_code ?? null,
    revision_count: params.revision_count ?? existing?.revision_count ?? 0,
    policy: existing?.policy ?? { forbidden_file_modified: false, outside_allowed_files: false, violations: [] },
    allowed_files: params.allowed_files ?? existing?.allowed_files ?? null,
    forbidden_files: params.forbidden_files ?? existing?.forbidden_files ?? null,
    skill_paths: params.skill_paths ?? existing?.skill_paths ?? null,
    context_files: params.context_files ?? existing?.context_files ?? null,
    injected_context_files: params.injected_context_files ?? existing?.injected_context_files ?? [],
    acpx: null,
    test: existing?.test ?? null,
    git: existing?.git ?? null,
    worker_summary: existing?.worker_summary ?? null,
    worker_stop_reason: existing?.worker_stop_reason ?? null,
    worker_tool_calls: existing?.worker_tool_calls ?? [],
    worker_error_event: existing?.worker_error_event ?? null,
    worker_duration_ms: null,
    worker_input_tokens: existing?.worker_input_tokens ?? null,
    worker_output_tokens: existing?.worker_output_tokens ?? null,
    worker_cost_usd: existing?.worker_cost_usd ?? null,
    background: {
      no_wait: true,
      started_at: params.created_at,
      events_path: eventsRel,
      stderr_path: stderrRel,
    },
    error: null,
  };
}

export function summarizeWorkerStatus(
  result: any,
  options: {
    eventsText?: string | null;
    stderrText?: string | null;
    now?: string;
    recentLineCount?: number;
    active?: boolean;
  } = {},
) {
  const now = options.now ?? new Date().toISOString();
  const startedAt = result.background?.started_at ?? result.created_at ?? result.updated_at;
  const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const nowMs = new Date(now).getTime();
  const eventsSummary = parseWorkerEvents(options.eventsText ?? null);
  const workerToolCalls = eventsSummary.tool_calls.length ? eventsSummary.tool_calls : result.worker_tool_calls ?? [];

  return {
    task_id: result.task_id,
    worker_agent: result.worker_agent ?? null,
    status: result.status,
    active: options.active ?? (result.status === "running" || result.status === "revising"),
    started_at: startedAt ?? null,
    updated_at: result.updated_at ?? null,
    elapsed_ms: Number.isFinite(startedMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - startedMs) : null,
    run_cwd: result.run_cwd ?? null,
    worktree_path: result.worktree_path ?? null,
    events_path: result.events_path ?? null,
    revision_events_paths: result.revision_events_paths ?? [],
    stderr_paths: result.stderr_paths ?? [],
    revision_stderr_paths: result.revision_stderr_paths ?? [],
    worker_summary: eventsSummary.final_message ?? result.worker_summary ?? null,
    worker_stop_reason: eventsSummary.stop_reason ?? result.worker_stop_reason ?? null,
    worker_tool_calls: workerToolCalls,
    worker_error_event: eventsSummary.error_event ?? result.worker_error_event ?? null,
    recent_events: extractRecentLines(options.eventsText, options.recentLineCount ?? 10),
    recent_stderr: extractRecentLines(options.stderrText, options.recentLineCount ?? 10),
    error: result.error ?? null,
  };
}

async function loadInjectedContextFiles(params: {
  root: string;
  skill_paths?: string[];
  context_files?: string[];
  max_bytes?: number;
}): Promise<InjectedContextFile[]> {
  const maxBytes = params.max_bytes ?? defaultMaxContextFileBytes();

  async function loadOne(kind: "skill" | "context", inputPath: string): Promise<InjectedContextFile> {
    const resolved = kind === "context"
      ? await resolveInside(params.root, inputPath)
      : path.resolve(params.root, inputPath);
    const st = await lstat(resolved);
    if (!st.isFile()) {
      throw new Error(`${kind === "skill" ? "skill_paths" : "context_files"} entry is not a file: ${inputPath}`);
    }

    const data = await readFile(resolved);
    const originalBytes = data.byteLength;
    const truncated = originalBytes > maxBytes;
    const included = truncated ? data.subarray(0, maxBytes) : data;
    const content = included.toString("utf8") +
      (truncated ? `\n\n[truncated ${originalBytes - maxBytes} bytes; increase WORKER_MAX_CONTEXT_FILE_BYTES to include more]` : "");

    return {
      kind,
      path: resolved,
      content,
      truncated,
      original_bytes: originalBytes,
      included_bytes: included.byteLength,
    };
  }

  const skills = await Promise.all((params.skill_paths ?? []).map((file) => loadOne("skill", file)));
  const contexts = await Promise.all((params.context_files ?? []).map((file) => loadOne("context", file)));
  return [...skills, ...contexts];
}

function taskMarkdown(params: {
  task_id: string;
  worker_agent: string;
  instructions: string;
  allowed_files?: string[];
  forbidden_files?: string[];
  injected_context_markdown?: string;
}) {
  const allowed = params.allowed_files?.length
    ? params.allowed_files.map((f) => `- ${f}`).join("\n")
    : "- Not specified (all files allowed)";
  const forbidden = params.forbidden_files?.length
    ? params.forbidden_files.map((f) => `- ${f}`).join("\n")
    : "- None";
  return `# Task: ${params.task_id}

## Worker Agent

${params.worker_agent}

## Instructions

${params.instructions}

${params.injected_context_markdown ? `${params.injected_context_markdown}\n` : ""}

## Allowed Files

${allowed}

## Forbidden Files

${forbidden}

## Requirements

1. Complete the requested implementation.
2. Keep changes minimal and focused — no unrelated refactors.
3. Do not modify forbidden files under any circumstance.
4. Run relevant tests when applicable.

## Output Format

Reply with a structured summary using exactly this format:

\`\`\`
## Summary
[One sentence describing what was done]

## Changed Files
- path/to/file1 — [what and why]
- path/to/file2 — [what and why]
(If none: "No files modified")

## Tests Run
- [test command] — [result]
(If none: "No tests applicable")

## Remaining Risks
[One sentence. If none: "None"]
\`\`\`
`;
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
  const seenToolCalls = new Set<string>();

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

        // Tool calls: Claude uses name/tool, Codex uses title
        if (su === "tool_call" || su === "tool_use") {
          const toolName = update.title ?? update.name ?? update.tool ?? "unknown";
          if (!seenToolCalls.has(toolName)) {
            summary.tool_calls.push(toolName);
            seenToolCalls.add(toolName);
          }
        }

        // Usage: Claude has cost in last usage_update, Codex has used (total tokens)
        if (su === "usage_update") {
          if (update.used != null && summary.input_tokens === null) {
            // Codex: only has total token count, store as input_tokens
            summary.input_tokens = update.used;
          }
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
        const toolName = event.title ?? event.name ?? event.tool ?? "unknown";
        if (!seenToolCalls.has(toolName)) {
          summary.tool_calls.push(toolName);
          seenToolCalls.add(toolName);
        }
      }
      if (event.type === "error") {
        summary.error_event = event.message ?? event.error ?? JSON.stringify(event);
      }

      // acpx JSON-RPC format: final response with stopReason + usage (Claude)
      if (event.id != null && event.result?.stopReason) {
        summary.stop_reason = event.result.stopReason;
        if (event.result.usage) {
          summary.input_tokens = event.result.usage.inputTokens ?? summary.input_tokens;
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
  const artifactLabel = artifactLabelForRun(options.run_label, options.revision_count);
  const events_path = path.join(resultDir, `${options.task_id}.${artifactLabel}.events.ndjson`);
  const stderr_path = path.join(resultDir, `${options.task_id}.${artifactLabel}.stderr.log`);

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
    if (options.model) args.push("--model", options.model);
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
      abort_signal: options.abort_signal,
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
      model: options.model ?? existing?.model ?? null,
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
      skill_paths: options.skill_paths ?? existing?.skill_paths ?? null,
      context_files: options.context_files ?? existing?.context_files ?? null,
      injected_context_files: options.injected_context_files ?? existing?.injected_context_files ?? [],
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
  const test_log_path = path.join(resultDir, `${options.task_id}.${artifactLabel}.test.log`);
  const test_stderr_path = path.join(resultDir, `${options.task_id}.${artifactLabel}.test.stderr.log`);
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
      abort_signal: options.abort_signal,
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
  const status = acpx.exit_code === 0 && !acpx.timed_out && !acpx.cancelled
    ? "completed"
    : acpx.cancelled && !acpx.timed_out
      ? "cancelled"
      : "failed";
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
    model: options.model ?? existing?.model ?? null,
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
    skill_paths: options.skill_paths ?? existing?.skill_paths ?? null,
    context_files: options.context_files ?? existing?.context_files ?? null,
    injected_context_files: options.injected_context_files ?? existing?.injected_context_files ?? [],
    acpx: {
      command: acpx.command,
      args: acpx.args,
      cwd: acpx.cwd,
      exit_code: acpx.exit_code,
      signal: acpx.signal,
      timed_out: acpx.timed_out,
      duration_ms: acpx.duration_ms,
      stdout_path: acpx.stdout_path,
      stderr_path: acpx.stderr_path,
      cancelled: acpx.cancelled ?? false,
      cancel_reason: acpx.cancel_reason ?? null,
    },
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
    worker_duration_ms: eventsSummary?.duration_ms ?? acpx.duration_ms ?? existing?.worker_duration_ms ?? null,
    worker_input_tokens: eventsSummary?.input_tokens ?? existing?.worker_input_tokens ?? null,
    worker_output_tokens: eventsSummary?.output_tokens ?? existing?.worker_output_tokens ?? null,
    worker_cost_usd: eventsSummary?.cost_usd ?? existing?.worker_cost_usd ?? null,
    error:
      status === "failed" || status === "cancelled"
        ? {
            message: acpx.timed_out
              ? "acpx timed out"
              : status === "cancelled"
                ? `acpx cancelled: ${acpx.cancel_reason ?? "cancelled"}`
                : `acpx exited with code ${acpx.exit_code}`,
            exit_code: acpx.exit_code,
            stderr_path: path.relative(root, stderr_path),
          }
        : null,
  };

  await writeFile(result_path, JSON.stringify(result, null, 2));
  return result;
}

async function writeBackgroundFailureResult(root: string, task_id: string, resultPath: string, err: any) {
  const existing = await loadExistingResult(root, task_id);
  const now = new Date().toISOString();
  const failed = {
    ...(existing ?? { task_id }),
    status: "failed",
    updated_at: now,
    error: {
      message: `background worker failed: ${err?.message ?? String(err)}`,
      exit_code: null,
      stderr_path: existing?.background?.stderr_path ?? null,
    },
  };
  await writeFile(resultPath, JSON.stringify(failed, null, 2));
}

export function launchBackgroundWorker(
  root: string,
  task_id: string,
  resultPath: string,
  workerPromise: Promise<unknown>,
  options: {
    abortController?: AbortController;
    onCancel?: (reason: string) => void;
  } = {},
) {
  const started_at = new Date().toISOString();
  const key = `${root}:${task_id}`;
  const promise = workerPromise
    .catch((err) => writeBackgroundFailureResult(root, task_id, resultPath, err))
    .finally(() => {
      activeBackgroundJobs.delete(key);
    });
  const cancel = (reason: string) => {
    options.onCancel?.(reason);
    if (!options.abortController?.signal.aborted) {
      options.abortController?.abort(reason);
    }
    activeBackgroundJobs.delete(key);
  };
  activeBackgroundJobs.set(key, { started_at, task_id, promise, cancel });
}

export function cancelActiveBackgroundWorkers(reason = "MCP server shutdown cancelled background worker"): number {
  const jobs = [...activeBackgroundJobs.values()];
  for (const job of jobs) {
    job.cancel(reason);
  }
  return jobs.length;
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

const StructuredTestCommandSchema = z.union([
  z.string().min(1),
  z.object({ cmd: z.string().min(1), args: z.array(z.string()) }),
]);
const ContextPathListSchema = z.array(z.string().min(1).max(4096)).max(20);

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
    skill_paths: ContextPathListSchema.optional().describe("Skill files to inject into the worker prompt. Absolute paths are supported, e.g. /Users/me/.codex/skills/foo/SKILL.md."),
    context_files: ContextPathListSchema.optional().describe("Repository files to inject into the worker prompt. Paths must stay inside cwd."),
    worker_cwd: z.string().optional().describe("Directory for acpx --cwd, relative to cwd. Defaults to cwd."),
    isolate_worktree: z.boolean().default(false),
    force_recreate_worktree: z.boolean().default(false).describe("If true and worktree exists, remove and recreate it."),
    session: z.string().optional().describe("Optional acpx named session, passed as -s <session>."),
    model: z.string().optional().describe("Model id for the worker agent (e.g. 'sonnet[1m]', 'opus[1m]'). Passed as --model to acpx."),
    mode: RunModeSchema,
    approval: ApprovalSchema,
    json_strict: z.boolean().default(true),
    no_wait: z.boolean().default(false).describe("If true, start the worker in the background, write a running result JSON, and return immediately. Poll with get_worker_status or watch_worker."),
    capture_diff: z.boolean().default(true),
    test_command: StructuredTestCommandSchema.optional().describe("Optional command to run after acpx. String form: 'npm test -- auth' (runs via shell). Object form: {cmd:'npm', args:['test','--','auth']} (no shell, safer)."),
    timeout_ms: z.number().int().positive().max(86_400_000).default(defaultTimeoutMs()),
  },
  async (input) => {
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

    // Load previous result to warn on overwrite and preserve history
    const existingResult = await loadExistingResult(root, input.task_id);
    const injectedContextFiles = await loadInjectedContextFiles({
      root,
      skill_paths: input.skill_paths,
      context_files: input.context_files,
    });
    const injectedContextMarkdown = buildInjectedContextMarkdown(injectedContextFiles);

    const taskFile = path.join(taskDir, `${input.task_id}.md`);
    await writeFile(
      taskFile,
      taskMarkdown({
        task_id: input.task_id,
        worker_agent: input.worker_agent,
        instructions: input.instructions,
        allowed_files: input.allowed_files,
        forbidden_files: input.forbidden_files,
        injected_context_markdown: injectedContextMarkdown,
      }),
    );

    const workerOptions: WorkerRunOptions = {
      cwd: root,
      worker_agent: input.worker_agent,
      task_id: input.task_id,
      prompt_file: path.relative(root, taskFile),
      run_cwd,
      session: input.session,
      model: input.model,
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
      skill_paths: input.skill_paths,
      context_files: input.context_files,
      injected_context_files: injectedContextFiles,
      revision_count: 0,
      worktree_path,
      existing_result: existingResult,
    };

    if (input.no_wait) {
      const artifactLabel = artifactLabelForRun("run", 0);
      const resultPath = path.join(resultDir, `${input.task_id}.result.json`);
      const eventsPath = path.join(resultDir, `${input.task_id}.${artifactLabel}.events.ndjson`);
      const stderrPath = path.join(resultDir, `${input.task_id}.${artifactLabel}.stderr.log`);
      const running = buildRunningWorkerResult({
        task_id: input.task_id,
        worker_agent: input.worker_agent,
        root,
        run_cwd,
        prompt_file: taskFile,
        result_path: resultPath,
        events_path: eventsPath,
        stderr_path: stderrPath,
        run_label: "run",
        created_at: new Date().toISOString(),
        mode: input.mode,
        approval: input.approval,
        json_strict: input.json_strict,
        timeout_ms: input.timeout_ms,
        capture_diff: input.capture_diff,
        session: input.session ?? null,
        model: input.model ?? null,
        test_command: input.test_command ?? null,
        allowed_files: input.allowed_files ?? null,
        forbidden_files: input.forbidden_files ?? null,
        skill_paths: input.skill_paths ?? null,
        context_files: input.context_files ?? null,
        injected_context_files: injectedContextFiles,
        worktree_path,
        existing_result: existingResult,
        revision_count: 0,
      });
      await writeFile(resultPath, JSON.stringify(running, null, 2));
      const abortController = new AbortController();
      launchBackgroundWorker(
        root,
        input.task_id,
        resultPath,
        runWorkerInternal({ ...workerOptions, abort_signal: abortController.signal }),
        { abortController },
      );
      return textResult(running);
    }

    const result = await runWorkerInternal(workerOptions);

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
    skill_paths: ContextPathListSchema.optional().describe("Override or provide skill files to inject into the revision prompt. Defaults to original task's skill_paths."),
    context_files: ContextPathListSchema.optional().describe("Override or provide repository files to inject into the revision prompt. Defaults to original task's context_files."),
    worker_cwd: z.string().optional(),
    session: z.string().optional(),
    model: z.string().optional().describe("Model id for the worker agent. Passed as --model to acpx."),
    mode: RunModeSchema,
    approval: ApprovalSchema,
    json_strict: z.boolean().default(true),
    no_wait: z.boolean().default(false).describe("If true, start the revision in the background, write a revising result JSON, and return immediately. Poll with get_worker_status or watch_worker."),
    capture_diff: z.boolean().default(true),
    test_command: StructuredTestCommandSchema.optional().describe("Optional test command. Defaults to original task's test_command."),
    timeout_ms: z.number().int().positive().max(86_400_000).default(defaultTimeoutMs()),
  },
  async (input) => {
    const root = await repoRootFrom(input.cwd);
    const existing = await loadExistingResult(root, input.task_id);

    // Enforce max 3 revisions
    const MAX_REVISIONS = 3;
    const currentRevisions = existing?.revision_count ?? 0;
    if (currentRevisions >= MAX_REVISIONS) {
      return textResult({
        task_id: input.task_id,
        error: `Revision limit reached (${MAX_REVISIONS} max, ${currentRevisions} already done). Review the current result and accept or reject.`,
        revision_count: currentRevisions,
        max_revisions: MAX_REVISIONS,
      });
    }

    const agentDir = path.join(root, ".agent");
    const taskFile = path.join(agentDir, "tasks", `${input.task_id}.md`);
    if (!(await exists(taskFile))) throw new Error(`Missing original task file: ${taskFile}`);

    const reviewsDir = path.join(agentDir, "reviews");
    const resultDir = path.join(agentDir, "results");
    await ensureDir(reviewsDir);
    await ensureDir(resultDir);

    const reviewFile = path.join(reviewsDir, `${input.task_id}.md`);
    await writeFile(reviewFile, input.review_feedback);

    const worktree_path = existing?.worktree_path ?? null;
    const revision_count = Number.isFinite(existing?.revision_count) ? existing.revision_count + 1 : 1;
    const skill_paths = input.skill_paths ?? existing?.skill_paths ?? undefined;
    const context_files = input.context_files ?? existing?.context_files ?? undefined;
    const injectedContextFiles = await loadInjectedContextFiles({
      root,
      skill_paths,
      context_files,
    });
    const injectedContextMarkdown = buildInjectedContextMarkdown(injectedContextFiles);
    const originalTask = await readFile(taskFile, "utf8");
    const revisionPrompt = `# Original Task\n\n${originalTask}\n\n# Review Feedback\n\n${input.review_feedback}\n\n${injectedContextMarkdown ? `${injectedContextMarkdown}\n\n` : ""}# Revision Instructions\n\nFix only the blocking issues identified by the reviewer. Do not perform unrelated refactors. Do not modify forbidden files. Keep the patch minimal and focused. When finished, summarize changed files, tests run, and remaining risks.\n`;
    const revisionLabel = artifactLabelForRun("revision", revision_count);
    const revisionPromptFile = path.join(resultDir, `${input.task_id}.${revisionLabel}.prompt.md`);
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

    const workerOptions: WorkerRunOptions = {
      cwd: root,
      worker_agent: input.worker_agent,
      task_id: input.task_id,
      prompt_file: path.relative(root, revisionPromptFile),
      run_cwd,
      session: input.session ?? existing?.session ?? undefined,
      model: input.model ?? existing?.model ?? undefined,
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
      skill_paths,
      context_files,
      injected_context_files: injectedContextFiles,
      revision_count,
      worktree_path,
      existing_result: existing,
    };

    if (input.no_wait) {
      const resultPath = path.join(resultDir, `${input.task_id}.result.json`);
      const eventsPath = path.join(resultDir, `${input.task_id}.${revisionLabel}.events.ndjson`);
      const stderrPath = path.join(resultDir, `${input.task_id}.${revisionLabel}.stderr.log`);
      const revising = buildRunningWorkerResult({
        task_id: input.task_id,
        worker_agent: input.worker_agent,
        root,
        run_cwd,
        prompt_file: revisionPromptFile,
        result_path: resultPath,
        events_path: eventsPath,
        stderr_path: stderrPath,
        run_label: "revision",
        created_at: new Date().toISOString(),
        mode: input.mode,
        approval: input.approval,
        json_strict: input.json_strict,
        timeout_ms: input.timeout_ms,
        capture_diff: input.capture_diff,
        session: input.session ?? existing?.session ?? null,
        model: input.model ?? existing?.model ?? null,
        test_command,
        allowed_files,
        forbidden_files,
        skill_paths,
        context_files,
        injected_context_files: injectedContextFiles,
        worktree_path,
        existing_result: existing,
        revision_count,
      });
      await writeFile(resultPath, JSON.stringify(revising, null, 2));
      const abortController = new AbortController();
      launchBackgroundWorker(
        root,
        input.task_id,
        resultPath,
        runWorkerInternal({ ...workerOptions, abort_signal: abortController.signal }),
        { abortController },
      );
      return textResult(revising);
    }

    const result = await runWorkerInternal(workerOptions);

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

    if (!parsed) {
      return textResult({
        task_id: input.task_id,
        error: `No result found for task '${input.task_id}'. Run 'run_worker' first.`,
        result: null,
        artifacts: {},
        diff: null,
        status: null,
        truncated: { result: false, diff: false, status: false, run_events: false, run_stderr: false, revision_events: false, revision_stderr: false, run_test_log: false, revision_test_log: false },
      });
    }

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

    const artifactPaths = selectWorkerResultArtifactPaths(parsed, root, input.task_id);
    const diffRaw = input.include_diff
      ? await readTextIfExists(absArtifactPath(root, parsed.diff_path) ?? path.join(resultDir, `${input.task_id}.diff`), 2_000_000)
      : null;
    const runEventsRaw = input.include_events ? await readTextIfExists(artifactPaths.runEventsPath, 2_000_000) : null;
    const revEventsRaw = input.include_events && artifactPaths.latestRevisionEventsPath
      ? await readTextIfExists(artifactPaths.latestRevisionEventsPath, 2_000_000)
      : null;
    const runTestRaw = input.include_test_log ? await readTextIfExists(artifactPaths.runTestLogPath, 2_000_000) : null;
    const revTestRaw = input.include_test_log && artifactPaths.latestRevisionTestLogPath
      ? await readTextIfExists(artifactPaths.latestRevisionTestLogPath, 2_000_000)
      : null;
    const statusRaw = await readTextIfExists(absArtifactPath(root, parsed.status_path) ?? path.join(resultDir, `${input.task_id}.status.txt`), 50_000);
    const runStderrRaw = await readTextIfExists(artifactPaths.runStderrPath, 50_000);
    const revStderrRaw = artifactPaths.latestRevisionStderrPath
      ? await readTextIfExists(artifactPaths.latestRevisionStderrPath, 50_000)
      : null;

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
      artifacts: {
        result_path: path.relative(root, resultPath),
        events_path: parsed.events_path ?? null,
        revision_events_paths: parsed.revision_events_paths ?? [],
        diff_path: parsed.diff_path ?? null,
        status_path: parsed.status_path ?? null,
        test_log_path: parsed.test_log_path ?? null,
        latest_test_log_path: parsed.latest_test_log_path ?? null,
      },
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
  "get_worker_status",
  "Return the current status of a worker task, including elapsed time, recent acpx event/stderr lines, tool calls, and error details. Useful for polling no_wait tasks.",
  {
    task_id: TaskIdSchema,
    cwd: z.string().optional(),
    recent_lines: z.number().int().positive().max(100).default(10),
    max_bytes: z.number().int().positive().max(1_000_000).default(200_000),
  },
  async (input) => {
    const root = await repoRootFrom(input.cwd);
    const existing = await loadExistingResult(root, input.task_id);
    if (!existing) {
      return textResult({
        task_id: input.task_id,
        status: "missing_result",
        error: `No result found for task '${input.task_id}'. Run 'run_worker' first.`,
      });
    }

    const paths = selectWorkerResultArtifactPaths(existing, root, input.task_id);
    const useRevisionLogs = (existing.status === "revising" || existing.status === "revised") && paths.latestRevisionEventsPath;
    const eventsPath = useRevisionLogs ? paths.latestRevisionEventsPath : paths.runEventsPath;
    const stderrPath = useRevisionLogs && paths.latestRevisionStderrPath ? paths.latestRevisionStderrPath : paths.runStderrPath;
    const [eventsText, stderrText] = await Promise.all([
      eventsPath ? readTextIfExists(eventsPath, input.max_bytes) : Promise.resolve(null),
      stderrPath ? readTextIfExists(stderrPath, Math.min(input.max_bytes, 200_000)) : Promise.resolve(null),
    ]);
    const key = `${root}:${input.task_id}`;

    return textResult(summarizeWorkerStatus(existing, {
      eventsText,
      stderrText,
      recentLineCount: input.recent_lines,
      active: activeBackgroundJobs.has(key) || existing.status === "running" || existing.status === "revising",
    }));
  },
);

server.tool(
  "watch_worker",
  "Return a larger recent tail of worker acpx events and stderr for a task. This is a polling-friendly watch helper, not a streaming subscription.",
  {
    task_id: TaskIdSchema,
    cwd: z.string().optional(),
    lines: z.number().int().positive().max(500).default(50),
    include_result: z.boolean().default(false),
    max_bytes: z.number().int().positive().max(2_000_000).default(500_000),
  },
  async (input) => {
    const root = await repoRootFrom(input.cwd);
    const existing = await loadExistingResult(root, input.task_id);
    if (!existing) {
      return textResult({
        task_id: input.task_id,
        status: "missing_result",
        error: `No result found for task '${input.task_id}'. Run 'run_worker' first.`,
      });
    }

    const paths = selectWorkerResultArtifactPaths(existing, root, input.task_id);
    const useRevisionLogs = (existing.status === "revising" || existing.status === "revised") && paths.latestRevisionEventsPath;
    const eventsPath = useRevisionLogs ? paths.latestRevisionEventsPath : paths.runEventsPath;
    const stderrPath = useRevisionLogs && paths.latestRevisionStderrPath ? paths.latestRevisionStderrPath : paths.runStderrPath;
    const [eventsText, stderrText] = await Promise.all([
      eventsPath ? readTextIfExists(eventsPath, input.max_bytes) : Promise.resolve(null),
      stderrPath ? readTextIfExists(stderrPath, Math.min(input.max_bytes, 500_000)) : Promise.resolve(null),
    ]);
    const key = `${root}:${input.task_id}`;
    const status = summarizeWorkerStatus(existing, {
      eventsText,
      stderrText,
      recentLineCount: input.lines,
      active: activeBackgroundJobs.has(key) || existing.status === "running" || existing.status === "revising",
    });

    return textResult({
      ...status,
      event_lines: status.recent_events,
      stderr_lines: status.recent_stderr,
      result: input.include_result ? existing : undefined,
    });
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
  "validate_acpx",
  "Run lightweight acpx help checks and report whether the command surface appears compatible with this MCP server.",
  {
    worker_agent: WorkerAgentSchema.default(defaultWorkerAgent()),
    cwd: z.string().optional(),
    include_exec_help: z.boolean().default(true),
    timeout_ms: z.number().int().positive().max(300_000).default(60_000),
  },
  async (input) => {
    assertAllowedWorkerAgent(input.worker_agent);
    const root = await repoRootFrom(input.cwd);
    const resultDir = path.join(root, ".agent", "results");
    await ensureDir(resultDir);
    const { command, args_prefix } = getAcpxCommand();

    async function check(label: string, args: string[], expected_flags: string[]) {
      const stdout_path = path.join(resultDir, `validate-acpx.${label}.stdout.log`);
      const stderr_path = path.join(resultDir, `validate-acpx.${label}.stderr.log`);
      try {
        const result = await runCommand({
          command,
          args: [...args_prefix, ...args],
          cwd: root,
          stdout_path,
          stderr_path,
          timeout_ms: input.timeout_ms,
        });
        const output = `${result.stdout_tail}\n${result.stderr_tail}`;
        return {
          label,
          command,
          args: [...args_prefix, ...args],
          ok: result.exit_code === 0 && !result.timed_out,
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          stdout_path: path.relative(root, stdout_path),
          stderr_path: path.relative(root, stderr_path),
          expected_flags: summarizeAcpxHelp(output, expected_flags),
        };
      } catch (err: any) {
        return {
          label,
          command,
          args: [...args_prefix, ...args],
          ok: false,
          exit_code: null,
          timed_out: false,
          stdout_path: path.relative(root, stdout_path),
          stderr_path: path.relative(root, stderr_path),
          expected_flags: Object.fromEntries(expected_flags.map((flag) => [flag, false])),
          error: err.message,
        };
      }
    }

    const checks = [
      await check("top-help", ["--help"], ["--cwd", "--format", "--timeout"]),
      await check("agent-help", [input.worker_agent, "--help"], ["exec", "cancel", "-s", "--model"]),
    ];
    if (input.include_exec_help) {
      checks.push(
        await check("exec-help", [input.worker_agent, "exec", "--help"], [
          "--file",
          "--json-strict",
          "--approve-all",
          "--approve-reads",
          "--deny-all",
        ]),
      );
    }

    const missing_flags = checks.flatMap((c) =>
      Object.entries(c.expected_flags)
        .filter(([, found]) => !found)
        .map(([flag]) => ({ check: c.label, flag })),
    );

    return textResult({
      status: checks.every((c) => c.ok) && missing_flags.length === 0 ? "compatible" : "needs_review",
      worker_agent: input.worker_agent,
      acpx_bin: [command, ...args_prefix].join(" "),
      checks,
      missing_flags,
      note: "Help output can vary by acpx version. Treat this as a compatibility smoke check before running real workers.",
    });
  },
);

server.tool(
  "apply_worker_patch",
  "Apply the tracked diff and optional untracked files from an isolated worker worktree back to the main repository working tree.",
  {
    task_id: TaskIdSchema,
    cwd: z.string().optional(),
    include_untracked: z.boolean().default(true),
    overwrite_untracked: z.boolean().default(false),
    check_only: z.boolean().default(false),
    timeout_ms: z.number().int().positive().max(300_000).default(60_000),
  },
  async (input) => {
    const root = await repoRootFrom(input.cwd);
    const existing = await loadExistingResult(root, input.task_id);
    if (!existing) {
      return textResult({
        task_id: input.task_id,
        status: "missing_result",
        error: `No result found for task '${input.task_id}'. Run 'run_worker' first.`,
      });
    }

    const worktreePath = resolveWorktreePathFromResult(existing, root);
    if (!worktreePath) {
      return textResult({
        task_id: input.task_id,
        status: "not_applicable",
        error: "This task has no worktree_path. apply_worker_patch only applies isolated worktree results.",
      });
    }

    const worktreeReal = await realpath(worktreePath);
    await assertInside(root, worktreeReal);

    const resultDir = path.join(root, ".agent", "results");
    await ensureDir(resultDir);
    const patchPath = path.join(resultDir, `${input.task_id}.apply.patch`);

    const diff = await runCommand({
      command: "git",
      args: ["-C", worktreeReal, "diff", "--binary", "HEAD"],
      cwd: root,
      stdout_path: patchPath,
      stderr_path: path.join(resultDir, `${input.task_id}.apply-diff.stderr.log`),
      timeout_ms: input.timeout_ms,
    });
    if (diff.exit_code !== 0) {
      return textResult({
        task_id: input.task_id,
        status: "failed",
        patch_path: path.relative(root, patchPath),
        diff,
        error: "Failed to generate worker patch from the isolated worktree.",
      });
    }
    const patchText = await readTextIfExists(patchPath, 10_000_000);
    const hasPatch = Boolean(patchText?.trim());

    const untracked = input.include_untracked
      ? await runCommand({
          command: "git",
          args: ["-C", worktreeReal, "ls-files", "--others", "--exclude-standard"],
          cwd: root,
          timeout_ms: input.timeout_ms,
        })
      : null;
    if (untracked && untracked.exit_code !== 0) {
      return textResult({
        task_id: input.task_id,
        status: "failed",
        patch_path: path.relative(root, patchPath),
        untracked,
        error: "Failed to list untracked files in the isolated worktree.",
      });
    }
    const untrackedFiles = untracked
      ? untracked.stdout_tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];

    const copyConflicts: string[] = [];
    const unsupportedUntrackedFiles: string[] = [];
    for (const file of untrackedFiles) {
      const src = path.join(worktreeReal, file);
      const dest = path.join(root, file);
      await assertInside(worktreeReal, src);
      await assertInside(root, dest);
      const srcStat = await lstat(src);
      if (!srcStat.isFile()) unsupportedUntrackedFiles.push(file);
      if (!input.overwrite_untracked && (await exists(dest))) copyConflicts.push(file);
    }

    if (copyConflicts.length || unsupportedUntrackedFiles.length) {
      return textResult({
        task_id: input.task_id,
        status: "conflict",
        patch_path: path.relative(root, patchPath),
        conflicts: copyConflicts,
        unsupported_untracked_files: unsupportedUntrackedFiles,
        error: unsupportedUntrackedFiles.length
          ? "Untracked worker entries must be regular files before they can be copied back."
          : "Untracked worker files would overwrite existing files. Set overwrite_untracked=true only after review.",
      });
    }

    let applyCheck: CommandResult | null = null;
    let applyResult: CommandResult | null = null;
    if (hasPatch) {
      applyCheck = await runCommand({
        command: "git",
        args: ["-C", root, "apply", "--check", patchPath],
        cwd: root,
        timeout_ms: input.timeout_ms,
      });
      if (applyCheck.exit_code !== 0) {
        return textResult({
          task_id: input.task_id,
          status: "conflict",
          patch_path: path.relative(root, patchPath),
          apply_check: applyCheck,
          error: "Worker patch does not apply cleanly to the main working tree.",
        });
      }

      if (!input.check_only) {
        applyResult = await runCommand({
          command: "git",
          args: ["-C", root, "apply", patchPath],
          cwd: root,
          timeout_ms: input.timeout_ms,
        });
        if (applyResult.exit_code !== 0) {
          return textResult({
            task_id: input.task_id,
            status: "failed",
            patch_path: path.relative(root, patchPath),
            apply: applyResult,
            error: "git apply failed after a successful check.",
          });
        }
      }
    }

    const copied_untracked_files: string[] = [];
    if (!input.check_only) {
      for (const file of untrackedFiles) {
        const src = path.join(worktreeReal, file);
        const dest = path.join(root, file);
        await assertInside(worktreeReal, src);
        await assertInside(root, dest);
        await ensureDir(path.dirname(dest));
        await copyFile(src, dest);
        copied_untracked_files.push(file);
      }
    }

    const rootGit = input.check_only
      ? null
      : await captureGitArtifacts(root, root, resultDir, input.task_id);

    existing.status = input.check_only ? existing.status : "applied";
    existing.updated_at = new Date().toISOString();
    existing.apply = {
      status: input.check_only ? "checked" : "applied",
      patch_path: path.relative(root, patchPath),
      has_patch: hasPatch,
      include_untracked: input.include_untracked,
      copied_untracked_files,
      would_copy_untracked_files: input.check_only ? untrackedFiles : [],
      apply_check_exit_code: applyCheck?.exit_code ?? null,
      apply_exit_code: applyResult?.exit_code ?? null,
    };
    if (rootGit) {
      existing.diff_path = path.relative(root, rootGit.diff_path);
      existing.cached_diff_path = path.relative(root, rootGit.cached_diff_path);
      existing.status_path = path.relative(root, rootGit.status_path);
      existing.untracked_path = path.relative(root, rootGit.untracked_path);
      existing.changed_files_path = path.relative(root, rootGit.changed_files_path);
      existing.changed_files = rootGit.changed_files;
    }
    await writeFile(path.join(resultDir, `${input.task_id}.result.json`), JSON.stringify(existing, null, 2));

    return textResult({
      task_id: input.task_id,
      status: input.check_only ? "checked" : "applied",
      patch_path: path.relative(root, patchPath),
      has_patch: hasPatch,
      copied_untracked_files,
      would_copy_untracked_files: input.check_only ? untrackedFiles : [],
      apply_check_exit_code: applyCheck?.exit_code ?? null,
      apply_exit_code: applyResult?.exit_code ?? null,
    });
  },
);

server.tool(
  "cleanup_worker",
  "Delete saved artifacts for a task, including result JSON, events, stderr, diff, status, and worktree if present.",
  {
    task_id: TaskIdSchema,
    cwd: z.string().optional(),
    remove_worktree: z.boolean().default(false).describe("Also remove the git worktree and branch for this task."),
  },
  async (input) => {
    const root = await repoRootFrom(input.cwd);
    const resultDir = path.join(root, ".agent", "results");
    const existing = await loadExistingResult(root, input.task_id);

    if (!existing) {
      return textResult({ task_id: input.task_id, status: "nothing_to_cleanup", message: "No result found for this task_id." });
    }

    const removed: string[] = [];
    // Remove result artifacts (all files matching task_id prefix)
    try {
      const files = await readdir(resultDir);
      for (const f of files) {
        if (f.startsWith(input.task_id)) {
          await rm(path.join(resultDir, f), { force: true });
          removed.push(f);
        }
      }
    } catch {
      // dir may not exist
    }

    // Remove task file
    const taskFile = path.join(root, ".agent", "tasks", `${input.task_id}.md`);
    if (await exists(taskFile)) {
      await rm(taskFile, { force: true });
      removed.push(path.relative(root, taskFile));
    }

    // Remove review file
    const reviewFile = path.join(root, ".agent", "reviews", `${input.task_id}.md`);
    if (await exists(reviewFile)) {
      await rm(reviewFile, { force: true });
      removed.push(path.relative(root, reviewFile));
    }

    // Remove worktree if requested
    let worktree_removed = false;
    if (input.remove_worktree && existing.worktree_path) {
      const wtPath = path.resolve(root, existing.worktree_path);
      if (await exists(wtPath)) {
        await runCommand({
          command: "git",
          args: ["-C", root, "worktree", "remove", "--force", wtPath],
          cwd: root,
          timeout_ms: 30_000,
        });
        worktree_removed = true;
      }
    }

    return textResult({
      task_id: input.task_id,
      status: "cleaned_up",
      removed_files: removed,
      removed_count: removed.length,
      worktree_removed,
    });
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
        ALLOWED_ACPX_AGENTS: "ALLOWED_WORKER_AGENTS",
      },
    });
  },
);

let shutdownHandlersInstalled = false;

function installBackgroundWorkerShutdownHandlers() {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;

  const cancelFor = (reason: string) => {
    const count = cancelActiveBackgroundWorkers(reason);
    if (count > 0) {
      console.error(`[${SERVER_NAME}] cancelled ${count} background worker(s): ${reason}`);
    }
  };

  process.once("SIGINT", () => {
    cancelFor("MCP server received SIGINT");
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cancelFor("MCP server received SIGTERM");
    process.exit(143);
  });
  process.once("beforeExit", () => {
    cancelFor("MCP server beforeExit");
  });
  process.stdin.once("end", () => {
    cancelFor("MCP server stdin ended");
  });
  process.stdin.once("close", () => {
    cancelFor("MCP server stdin closed");
  });
}

async function main() {
  installBackgroundWorkerShutdownHandlers();
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
