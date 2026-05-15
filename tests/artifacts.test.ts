import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  artifactLabelForRun,
  buildInjectedContextMarkdown,
  buildRunningWorkerResult,
  compactWorkerResult,
  cancelActiveBackgroundWorkers,
  extractRecentLines,
  launchBackgroundWorker,
  normalizeContextPathListInput,
  resolveWorktreePathFromResult,
  selectWorkerResultArtifactPaths,
  summarizeAcpxHelp,
  summarizeInjectedContextFiles,
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
    expect(markdown).toContain('<skill path="/Users/example/.codex/skills/review/SKILL.md" mode="inline" truncated="false" original_bytes="21" included_bytes="21">');
    expect(markdown).toContain("Use review checklist.");
    expect(markdown).toContain("## Context Files");
    expect(markdown).toContain('<context_file path="/repo/docs/notes.md" mode="inline" truncated="true" original_bytes="120000" included_bytes="80000">');
    expect(markdown).toContain("Project notes.");
  });

  it("returns an empty string when no files are injected", () => {
    expect(buildInjectedContextMarkdown([])).toBe("");
  });

  it("renders referenced context files without embedding file content", () => {
    const markdown = buildInjectedContextMarkdown([
      {
        kind: "context",
        path: "/repo/docs/large.md",
        content: "SHOULD_NOT_BE_INCLUDED",
        truncated: false,
        original_bytes: 120000,
        included_bytes: 0,
        mode: "reference",
      },
    ]);

    expect(markdown).toContain('<context_file path="/repo/docs/large.md" mode="reference"');
    expect(markdown).toContain("Read this file from disk when needed.");
    expect(markdown).not.toContain("SHOULD_NOT_BE_INCLUDED");
  });
});

describe("compactWorkerResult", () => {
  it("omits verbose fields and keeps review handles", () => {
    const compact = compactWorkerResult({
      task_id: "task-compact",
      worker_agent: "claude",
      status: "completed",
      run_cwd: "/repo",
      worktree_path: "/repo/.agent/worktrees/task-compact",
      result_path: ".agent/results/task-compact.result.json",
      events_path: ".agent/results/task-compact.run.events.ndjson",
      diff_path: ".agent/results/task-compact.diff",
      test_log_path: ".agent/results/task-compact.run.test.log",
      changed_files: ["src/foo.ts"],
      policy: { forbidden_file_modified: false, outside_allowed_files: false, violations: [] },
      injected_context_files: [
        {
          kind: "context",
          path: "/repo/docs/large.md",
          content: "large content",
          truncated: false,
          original_bytes: 10000,
          included_bytes: 10000,
        },
      ],
      worker_summary: "Done",
      acpx: { stdout_tail: "very long stdout" },
      test: { stdout_tail: "very long test output" },
    });

    expect(compact).toEqual({
      task_id: "task-compact",
      worker_agent: "claude",
      status: "completed",
      run_cwd: "/repo",
      worktree_path: "/repo/.agent/worktrees/task-compact",
      artifacts: {
        result_path: ".agent/results/task-compact.result.json",
        events_path: ".agent/results/task-compact.run.events.ndjson",
        revision_events_paths: [],
        diff_path: ".agent/results/task-compact.diff",
        cached_diff_path: null,
        status_path: null,
        test_log_path: ".agent/results/task-compact.run.test.log",
        latest_test_log_path: null,
      },
      changed_files: ["src/foo.ts"],
      policy: { forbidden_file_modified: false, outside_allowed_files: false, violations: [] },
      worker_summary: "Done",
      worker_stop_reason: null,
      worker_error_event: null,
      worker_tool_calls: [],
      worker_input_tokens: null,
      worker_output_tokens: null,
      worker_cost_usd: null,
      test_exit_code: null,
      error: null,
      background: null,
      context_files: [
        {
          kind: "context",
          path: "/repo/docs/large.md",
          mode: "inline",
          truncated: false,
          original_bytes: 10000,
          included_bytes: 10000,
        },
      ],
      next_actions: [
        "Use read_worker_result with view='review' to inspect diff and test logs before accepting.",
        "Use apply_worker_patch after review if this task used an isolated worktree.",
      ],
    });
  });
});

describe("summarizeInjectedContextFiles", () => {
  it("strips content from injected context metadata", () => {
    expect(summarizeInjectedContextFiles([
      {
        kind: "skill",
        path: "/skill.md",
        content: "secret instructions",
        truncated: true,
        original_bytes: 10,
        included_bytes: 5,
      },
    ])).toEqual([
      {
        kind: "skill",
        path: "/skill.md",
        mode: "inline",
        truncated: true,
        original_bytes: 10,
        included_bytes: 5,
      },
    ]);
  });
});

describe("normalizeContextPathListInput", () => {
  it("wraps a single context file path for schema compatibility", () => {
    expect(normalizeContextPathListInput("docs/architecture.md")).toEqual(["docs/architecture.md"]);
  });

  it("preserves context file arrays", () => {
    expect(normalizeContextPathListInput(["docs/a.md", "docs/b.md"])).toEqual(["docs/a.md", "docs/b.md"]);
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

describe("background worker cancellation", () => {
  it("cancels tracked background workers on server shutdown", async () => {
    const controller = new AbortController();
    let cancelReason: string | undefined;
    let resolveWorker: (() => void) | undefined;
    const workerPromise = new Promise<void>((resolve) => {
      resolveWorker = resolve;
    });

    launchBackgroundWorker(
      "/repo",
      "task-bg-cancel",
      "/repo/.agent/results/task-bg-cancel.result.json",
      workerPromise,
      {
        abortController: controller,
        onCancel: (reason) => {
          cancelReason = reason;
          resolveWorker?.();
        },
      },
    );

    const cancelled = cancelActiveBackgroundWorkers("test shutdown");

    expect(cancelled).toHaveLength(1);
    expect(controller.signal.aborted).toBe(true);
    expect(cancelReason).toBe("test shutdown");
    await cancelled[0].promise;
  });
});
