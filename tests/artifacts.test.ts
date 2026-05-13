import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  artifactLabelForRun,
  buildInjectedContextMarkdown,
  buildRunningWorkerResult,
  extractRecentLines,
  resolveWorktreePathFromResult,
  selectWorkerResultArtifactPaths,
  summarizeAcpxHelp,
  summarizeWorkerStatus,
} from "../src/index.js";

describe("artifactLabelForRun", () => {
  it("uses stable run label for initial runs", () => {
    expect(artifactLabelForRun("run", 0)).toBe("run");
  });

  it("numbers revision artifacts so history is not overwritten", () => {
    expect(artifactLabelForRun("revision", 1)).toBe("revision-1");
    expect(artifactLabelForRun("revision", 2)).toBe("revision-2");
  });
});

describe("selectWorkerResultArtifactPaths", () => {
  const root = "/repo";

  it("keeps initial and latest test logs distinct after revisions", () => {
    const paths = selectWorkerResultArtifactPaths(
      {
        events_path: ".agent/results/task.run.events.ndjson",
        revision_events_paths: [".agent/results/task.revision-1.events.ndjson"],
        stderr_paths: [".agent/results/task.run.stderr.log"],
        revision_stderr_paths: [".agent/results/task.revision-1.stderr.log"],
        test_log_paths: [".agent/results/task.run.test.log"],
        revision_test_log_paths: [".agent/results/task.revision-1.test.log"],
        latest_test_log_path: ".agent/results/task.revision-1.test.log",
      },
      root,
      "task",
    );

    expect(paths.runEventsPath).toBe(path.join(root, ".agent/results/task.run.events.ndjson"));
    expect(paths.latestRevisionEventsPath).toBe(path.join(root, ".agent/results/task.revision-1.events.ndjson"));
    expect(paths.runStderrPath).toBe(path.join(root, ".agent/results/task.run.stderr.log"));
    expect(paths.latestRevisionStderrPath).toBe(path.join(root, ".agent/results/task.revision-1.stderr.log"));
    expect(paths.runTestLogPath).toBe(path.join(root, ".agent/results/task.run.test.log"));
    expect(paths.latestRevisionTestLogPath).toBe(path.join(root, ".agent/results/task.revision-1.test.log"));
  });

  it("falls back to legacy artifact names when result JSON lacks explicit paths", () => {
    const paths = selectWorkerResultArtifactPaths({}, root, "legacy");

    expect(paths.runEventsPath).toBe(path.join(root, ".agent/results/legacy.run.events.ndjson"));
    expect(paths.runStderrPath).toBe(path.join(root, ".agent/results/legacy.run.stderr.log"));
    expect(paths.runTestLogPath).toBe(path.join(root, ".agent/results/legacy.run.test.log"));
  });
});

describe("summarizeAcpxHelp", () => {
  it("reports expected acpx flags found in help output", () => {
    const summary = summarizeAcpxHelp("Usage: acpx --cwd . --format json --json-strict --approve-all --timeout 10", [
      "--cwd",
      "--format",
      "--json-strict",
      "--approve-all",
      "--timeout",
    ]);

    expect(summary).toEqual({
      "--cwd": true,
      "--format": true,
      "--json-strict": true,
      "--approve-all": true,
      "--timeout": true,
    });
  });
});

describe("resolveWorktreePathFromResult", () => {
  it("resolves relative worktree paths inside the repository", () => {
    expect(resolveWorktreePathFromResult({ worktree_path: ".agent/worktrees/task" }, "/repo")).toBe(
      path.join("/repo", ".agent/worktrees/task"),
    );
  });

  it("preserves absolute worktree paths", () => {
    expect(resolveWorktreePathFromResult({ worktree_path: "/repo/.agent/worktrees/task" }, "/repo")).toBe(
      "/repo/.agent/worktrees/task",
    );
  });

  it("returns null when no worktree path is present", () => {
    expect(resolveWorktreePathFromResult({}, "/repo")).toBeNull();
  });
});

describe("buildInjectedContextMarkdown", () => {
  it("renders skill and context files into worker task markdown", () => {
    const markdown = buildInjectedContextMarkdown([
      {
        kind: "skill",
        path: "/Users/example/.codex/skills/review/SKILL.md",
        content: "Use review checklist.",
        truncated: false,
        original_bytes: 21,
        included_bytes: 21,
      },
      {
        kind: "context",
        path: "/repo/docs/notes.md",
        content: "Project notes.",
        truncated: true,
        original_bytes: 120000,
        included_bytes: 80000,
      },
    ]);

    expect(markdown).toContain("## Required Skills");
    expect(markdown).toContain('<skill path="/Users/example/.codex/skills/review/SKILL.md" truncated="false" original_bytes="21" included_bytes="21">');
    expect(markdown).toContain("Use review checklist.");
    expect(markdown).toContain("## Context Files");
    expect(markdown).toContain('<context_file path="/repo/docs/notes.md" truncated="true" original_bytes="120000" included_bytes="80000">');
    expect(markdown).toContain("Project notes.");
  });

  it("returns an empty string when no files are injected", () => {
    expect(buildInjectedContextMarkdown([])).toBe("");
  });
});

describe("buildRunningWorkerResult", () => {
  it("creates a running result skeleton with artifact paths for polling", () => {
    const result = buildRunningWorkerResult({
      task_id: "task-bg",
      worker_agent: "claude",
      root: "/repo",
      run_cwd: "/repo",
      prompt_file: "/repo/.agent/tasks/task-bg.md",
      result_path: "/repo/.agent/results/task-bg.result.json",
      events_path: "/repo/.agent/results/task-bg.run.events.ndjson",
      stderr_path: "/repo/.agent/results/task-bg.run.stderr.log",
      run_label: "run",
      created_at: "2026-05-13T00:00:00.000Z",
      mode: "exec",
      approval: "all",
      json_strict: true,
      timeout_ms: 300000,
      capture_diff: true,
    });

    expect(result.status).toBe("running");
    expect(result.events_path).toBe(".agent/results/task-bg.run.events.ndjson");
    expect(result.stderr_paths).toEqual([".agent/results/task-bg.run.stderr.log"]);
    expect(result.background.started_at).toBe("2026-05-13T00:00:00.000Z");
  });
});

describe("extractRecentLines", () => {
  it("returns the last non-empty lines up to the requested limit", () => {
    expect(extractRecentLines("a\n\nb\nc\nd\n", 2)).toEqual(["c", "d"]);
  });
});

describe("summarizeWorkerStatus", () => {
  it("adds recent event and stderr lines to a running result", () => {
    const status = summarizeWorkerStatus(
      {
        task_id: "task-bg",
        status: "running",
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:00.000Z",
        worker_tool_calls: ["Read File"],
      },
      {
        eventsText: '{"type":"start"}\n{"type":"tool_call","name":"Read File"}\n',
        stderrText: "warning\n",
        now: "2026-05-13T00:00:05.000Z",
      },
    );

    expect(status.status).toBe("running");
    expect(status.elapsed_ms).toBe(5000);
    expect(status.recent_events).toEqual(['{"type":"start"}', '{"type":"tool_call","name":"Read File"}']);
    expect(status.recent_stderr).toEqual(["warning"]);
    expect(status.worker_tool_calls).toEqual(["Read File"]);
  });
});
