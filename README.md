# agent-worker-mcp

A generic MCP server for **agent-to-agent delegation** through [`acpx`](https://github.com/openclaw/acpx).

This server lets any MCP-capable upstream agent act as a leader/reviewer and delegate implementation tasks to any `acpx`-supported ACP-compatible worker agent.

It does **not** reimplement ACP and does **not** directly adapt individual agents. `acpx` remains the ACP client/runtime and agent compatibility layer.

```text
Leader / Reviewer Agent
  -> MCP tool: run_worker / revise_worker / read_worker_result / cancel_worker
    -> acpx
      -> ACP
        -> Claude / Gemini / OpenCode / Qwen / Kimi / other ACP-compatible worker agent
```

## What it provides

Tools exposed over MCP:

- `run_worker` — write task instructions to `.agent/tasks`, run a worker agent through `acpx`, capture events, stderr, git diff/status, changed files, optional test logs, and result JSON.
- `revise_worker` — send reviewer feedback back to the worker agent for a focused revision.
- `read_worker_result` — read `.agent/results/*` artifacts for upstream review.
- `cancel_worker` — ask `acpx` to cancel an in-flight prompt/session.
- `list_worker_agents` — show configured/default worker agents and common `acpx` agent keys.

Default artifact layout inside the target repository:

```text
.agent/
  tasks/
    task-001.md
  reviews/
    task-001.md
  results/
    task-001.result.json
    task-001.run.events.ndjson
    task-001.run.stderr.log
    task-001.revision.events.ndjson
    task-001.revision.stderr.log
    task-001.diff
    task-001.status.txt
    task-001.changed-files.txt
    task-001.run.test.log
  worktrees/
    task-001/
```

## Install

Prerequisites:

- Node.js 20+
- `acpx` available globally, or set `ACPX_BIN="npx -y acpx@latest"`
- authentication configured for the worker agents you intend to use, such as Claude, Gemini, OpenCode, Qwen, Kimi, or a custom ACP agent

```bash
npm install
npm run build
```

Optional global install for local development:

```bash
npm link
```

## Configure an MCP client

Example stdio MCP configuration:

```toml
[mcp_servers.agent_worker]
command = "node"
args = ["/absolute/path/to/agent-worker-mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 3600
env_vars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]

[mcp_servers.agent_worker.env]
ACPX_BIN = "acpx"
DEFAULT_WORKER_AGENT = "claude"
ALLOWED_WORKER_AGENTS = "claude,gemini,opencode,qwen,kimi,codex"
ACPX_APPROVAL = "all"
```

`tool_timeout_sec` should be long enough for coding tasks. Short defaults such as 60 seconds are usually too short for worker-agent delegation.

## Tool example: run_worker

```json
{
  "worker_agent": "claude",
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "instructions": "Implement X. Only modify src/foo.ts and tests/foo.test.ts. Keep the patch minimal and return a concise summary.",
  "allowed_files": ["src/foo.ts", "tests/foo.test.ts"],
  "forbidden_files": [".env", "migrations/**"],
  "approval": "all",
  "mode": "exec",
  "test_command": "npm test -- foo"
}
```

Then the upstream agent should call `read_worker_result`, inspect the actual diff and test logs, and accept or call `revise_worker` with precise feedback.

## Tool example: revise_worker

```json
{
  "worker_agent": "claude",
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "review_feedback": "The implementation is mostly correct, but it lacks a regression test for invalid input. Add only the missing test and minimal code changes.",
  "test_command": "npm test -- foo"
}
```

## Recommended leader/reviewer workflow

```md
# Worker delegation policy

You are the leader and reviewer agent.

Use the agent-worker MCP server to delegate implementation work to worker agents.

Available tools:
- run_worker
- revise_worker
- read_worker_result
- cancel_worker
- list_worker_agents

Workflow:
1. Break the user request into small, reviewable tasks.
2. For each task, call run_worker with task_id, worker_agent, instructions, cwd, allowed_files, forbidden_files, and test_command when applicable.
3. After the worker finishes, call read_worker_result.
4. Review the actual git diff and test logs yourself.
5. Do not accept a worker result based only on the worker's summary.
6. If there are blocking issues, call revise_worker with precise feedback.
7. Limit revisions to 3 attempts.
8. Accept only when the diff satisfies the task, tests pass or failures are explained, no forbidden files were modified, and there is no unrelated refactor.
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ACPX_BIN` | `acpx` | Command used to start acpx. Can be `npx -y acpx@latest`. |
| `DEFAULT_WORKER_AGENT` | `claude` | Default worker agent. |
| `ALLOWED_WORKER_AGENTS` | `*` | Comma-separated allow list, e.g. `claude,gemini,opencode`. |
| `ACPX_APPROVAL` | `all` | Default permission mode: `all`, `reads`, or `deny`. |
| `WORKER_MAX_TIMEOUT_SECONDS` | `3600` | Default maximum runtime for worker tasks. |
| `WORKER_MAX_OUTPUT_BYTES` | `200000` | Default max artifact bytes returned by read_worker_result. |

Compatibility aliases are also accepted for older configurations:

| Old variable | New variable |
|---|---|
| `DEFAULT_ACPX_AGENT` | `DEFAULT_WORKER_AGENT` |
| `ALLOWED_ACPX_AGENTS` | `ALLOWED_WORKER_AGENTS` |

## Safety notes

- `ACPX_APPROVAL=all` is convenient for automation but grants the worker broad local edit/terminal permissions through `acpx`. Prefer disposable git worktrees or sandboxed checkouts.
- `test_command` currently runs through the shell in `run_cwd`; only pass trusted commands.
- Use `ALLOWED_WORKER_AGENTS` to restrict which worker agents the upstream agent can call.
- The server constrains `.agent` paths to the target repository and validates task IDs, but it does not prevent a worker agent from editing files once `acpx` grants permissions.
- Always review diff and test logs before accepting worker output.

## acpx compatibility

Before using this server, verify your local `acpx` command surface:

```bash
acpx --help
acpx claude --help
acpx claude exec --help
```

The internal `acpx` invocation currently assumes support for:

```text
--cwd
--format json
--json-strict
--approve-all / --approve-reads / --deny-all
exec
--file
```

If your `acpx` version changes those flags, update the internal invocation in `src/index.ts` while keeping the MCP tool schemas stable.
