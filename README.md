# agent-worker-mcp

`agent-worker-mcp` 是一个通过 [`acpx`](https://github.com/openclaw/acpx) 做 **agent-to-agent 任务委托** 的通用 MCP 服务器。

它让任意 MCP 客户端里的上游 agent 充当 leader / reviewer，把实现任务委托给 `acpx` 支持的 ACP worker agent，例如 Claude、Gemini、Codex、OpenCode、Qwen、Kimi 或其他兼容 ACP 的 agent。

它不重新实现 ACP，也不直接适配具体 agent。`acpx` 仍然是 ACP client/runtime 和 agent 兼容层。

```text
Leader / Reviewer Agent
  -> MCP tools: run_worker / revise_worker / read_worker_result / get_worker_status / watch_worker
    -> acpx
      -> ACP
        -> Claude / Gemini / OpenCode / Qwen / Kimi / other ACP-compatible worker agent
```

## 功能概览

MCP 暴露的工具：

- `run_worker`：把任务写入 `.agent/tasks`，通过 `acpx` 启动 worker agent，并保存 events、stderr、git diff/status、变更文件、可选测试日志和稳定的 result JSON。
- `revise_worker`：把 reviewer feedback 发回 worker agent 做定向修订，并保留原始 run 历史与 revision 产物。
- `read_worker_result`：读取 `.agent/results/*` 产物，供上游 reviewer 审查。
- `get_worker_status`：轮询运行中或已完成的 worker 任务，返回状态、耗时、最近 events、最近 stderr、tool calls 和错误信息。
- `watch_worker`：返回更长的 worker events/stderr tail，用于展示实时进度。
- `apply_worker_patch`：把隔离 worktree 中已审查的 tracked diff 和可选 untracked 文件应用回主仓库。
- `cancel_worker`：通过 `acpx cancel` 尝试取消正在运行的 worker prompt/session。
- `cleanup_worker`：清理某个 task 的保存产物，并可选删除对应 worktree。
- `validate_acpx`：检查本机 `acpx` help 输出是否包含本 MCP 依赖的参数。
- `list_worker_agents`：返回默认 worker、允许的 worker 列表和常见 `acpx` agent key。

默认产物目录：

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
    task-001.revision-1.events.ndjson
    task-001.revision-1.stderr.log
    task-001.revision-1.prompt.md
    task-001.apply.patch
    task-001.diff
    task-001.cached.diff
    task-001.status.txt
    task-001.untracked.txt
    task-001.changed-files.txt
    task-001.run.test.log
    task-001.revision-1.test.log
  worktrees/
    task-001/
```

## 安装

前置条件：

- Node.js 20+
- 全局可用的 `acpx`，或设置 `ACPX_BIN="npx -y acpx@latest"`
- 已为要使用的 worker agent 配好认证，例如 Claude、Gemini、OpenCode、Qwen、Kimi 或自定义 ACP agent

```bash
npm install
npm run build
```

本地开发时可选全局链接：

```bash
npm link
```

## 配置 MCP 客户端

stdio MCP 配置示例：

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

`tool_timeout_sec` 应足够长。代码任务通常会超过 60 秒，太短会导致上游 MCP client 在 worker 完成前超时。

## 示例：run_worker

```json
{
  "worker_agent": "claude",
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "instructions": "Implement X. Only modify src/foo.ts and tests/foo.test.ts. Keep the patch minimal and return a concise summary.",
  "allowed_files": ["src/foo.ts", "tests/foo.test.ts"],
  "forbidden_files": [".env", "migrations/**"],
  "skill_paths": ["/Users/me/.codex/skills/review/SKILL.md"],
  "context_files": ["docs/architecture.md"],
  "approval": "all",
  "mode": "exec",
  "test_command": {
    "cmd": "npm",
    "args": ["test", "--", "foo"]
  }
}
```

`skill_paths` 和 `context_files` 会在 worker 运行前被复制进生成的 task prompt：

- `skill_paths` 用于外部 skill 文件，例如 Codex 的 `SKILL.md`，支持仓库外绝对路径。
- `context_files` 用于目标仓库内的上下文文件，路径必须保持在 `cwd` 内。
- 每个注入文件默认最多注入 `80000` bytes，可通过 `WORKER_MAX_CONTEXT_FILE_BYTES` 调整。

worker 完成后，上游 agent 应调用 `read_worker_result`，亲自检查 result JSON、diff、测试日志和 policy，而不是只看 worker 的自然语言总结。

## 后台任务和实时状态

`run_worker` 和 `revise_worker` 支持 `no_wait=true`。开启后，工具会在写入 task 和启动 worker 后立即返回，后台继续执行 worker：

```json
{
  "worker_agent": "claude",
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "instructions": "Implement X.",
  "no_wait": true
}
```

返回结果会是 `running` 或 `revising`，并包含 events/stderr 产物路径。

轮询当前状态：

```json
{
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "recent_lines": 20
}
```

使用 `get_worker_status` 可获得：

- 当前状态
- 是否仍 active
- 已运行时间
- 最近 events
- 最近 stderr
- worker tool calls
- worker summary / stop reason / error

获取更长的实时日志 tail：

```json
{
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "lines": 80,
  "include_result": true
}
```

使用 `watch_worker` 可以展示更完整的最近 events/stderr。它不是流式订阅，而是轮询友好的 watch helper。

当 MCP server 进程结束、收到 `SIGINT` / `SIGTERM`，或 stdio 输入关闭时，server 会取消本次进程启动的后台 worker。取消会通过 `SIGTERM` 发送给对应的 `acpx` 子进程，5 秒后仍未退出则升级为 `SIGKILL`；result JSON 会更新为 `cancelled` 并记录取消原因。这个清理只作用于当前 MCP server 进程亲自启动的后台任务，不会按进程名误杀用户在其他终端或其他会话中启动的 Claude。

## 示例：revise_worker

```json
{
  "worker_agent": "claude",
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "review_feedback": "The implementation is mostly correct, but it lacks a regression test for invalid input. Add only the missing test and minimal code changes.",
  "test_command": {
    "cmd": "npm",
    "args": ["test", "--", "foo"]
  }
}
```

`revise_worker` 默认继承原任务的 `allowed_files`、`forbidden_files`、`skill_paths`、`context_files` 和 `test_command`。如果某次 revision 需要不同上下文，可显式传新数组覆盖。

## 推荐 Leader / Reviewer 流程

```md
# Worker delegation policy

You are the leader and reviewer agent.

Use the agent-worker MCP server to delegate implementation work to worker agents.

Available tools:
- run_worker
- revise_worker
- read_worker_result
- get_worker_status
- watch_worker
- apply_worker_patch
- cancel_worker
- cleanup_worker
- validate_acpx
- list_worker_agents

Workflow:
1. Split work into small tasks with explicit allowed files, forbidden files, and acceptance criteria.
2. Call run_worker with a unique task_id and selected worker_agent.
3. If no_wait=true was used, poll get_worker_status or watch_worker until the task completes.
4. Call read_worker_result.
5. Review the actual diff, changed files, policy flags, and test logs yourself.
6. Never accept based only on the worker's natural-language summary.
7. If blocking issues exist, call revise_worker with precise feedback.
8. Limit revision loops to 3 attempts unless the user explicitly asks otherwise.
9. If isolate_worktree was used, call apply_worker_patch only after reviewing the diff.
10. Accept only when the diff satisfies the task, tests pass or failures are explained, no forbidden files were modified, and there is no unrelated refactor.
```

## 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `ACPX_BIN` | `acpx` | 启动 acpx 的命令。可设为 `npx -y acpx@latest`。 |
| `DEFAULT_WORKER_AGENT` | `claude` | 默认 worker agent。 |
| `ALLOWED_WORKER_AGENTS` | `*` | 逗号分隔的 worker allowlist，例如 `claude,gemini,opencode`。 |
| `ACPX_APPROVAL` | `all` | 默认权限模式：`all`、`reads` 或 `deny`。 |
| `WORKER_MAX_TIMEOUT_SECONDS` | `3600` | worker 任务默认最大运行秒数。 |
| `WORKER_MAX_OUTPUT_BYTES` | `200000` | `read_worker_result` 默认返回产物的最大字节数。 |
| `WORKER_MAX_CONTEXT_FILE_BYTES` | `80000` | 每个 `skill_paths` 或 `context_files` 注入文件的最大字节数。 |

兼容旧变量名：

| 旧变量 | 新变量 |
|---|---|
| `DEFAULT_ACPX_AGENT` | `DEFAULT_WORKER_AGENT` |
| `ALLOWED_ACPX_AGENTS` | `ALLOWED_WORKER_AGENTS` |

## 安全注意事项

- `ACPX_APPROVAL=all` 便于自动化，但会通过 `acpx` 给 worker 较宽的本地编辑和终端权限。建议配合 `isolate_worktree=true` 或一次性 checkout 使用。
- `test_command` 的字符串形式会通过 shell 执行，只应传可信命令。更推荐 `{ "cmd": "...", "args": [...] }` 结构化形式。
- `skill_paths` 和 `context_files` 会把文件内容注入 worker prompt。只传允许该 worker agent 读取的可信文件。
- 使用 `ALLOWED_WORKER_AGENTS` 限制上游 agent 可调用的 worker。
- 服务器会约束 `.agent` 产物路径并校验 `task_id`，但一旦 `acpx` 授权 worker，本 MCP 不能阻止 worker 编辑文件。
- 接受 worker 输出前，必须审查 diff、测试日志和 policy violations。

## acpx 兼容性

使用前建议检查本机 `acpx` 命令面：

```bash
acpx --help
acpx claude --help
acpx claude exec --help
```

也可以调用 MCP 工具 `validate_acpx`：

```json
{
  "worker_agent": "claude",
  "cwd": "/path/to/repo"
}
```

它会把 help stdout/stderr 保存到 `.agent/results`，并返回结构化兼容性摘要。

当前内部调用假设 `acpx` 支持：

```text
--cwd
--format json
--timeout
--json-strict
--approve-all / --approve-reads / --deny-all
<worker_agent> exec --file <prompt_file>
```

如果你的 `acpx` 版本变更了这些参数，应只调整 `src/index.ts` 内部 invocation builder，保持 MCP 工具 schema 稳定。

## Worktree 审查和应用

当 `run_worker` 使用 `"isolate_worktree": true` 时，worker 会编辑 `.agent/worktrees/<task_id>`，不会直接污染主工作区。先读取结果：

```json
{
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "include_diff": true,
  "include_test_log": true
}
```

审查通过后，可以先检查 patch 是否可应用：

```json
{
  "task_id": "task-001",
  "cwd": "/path/to/repo",
  "check_only": true,
  "include_untracked": true
}
```

使用 `apply_worker_patch` 并设置 `"check_only": false` 后，工具会先运行 `git apply --check`，再应用 tracked diff。未跟踪文件默认只在不会覆盖现有文件时复制；确需覆盖时必须显式设置 `"overwrite_untracked": true`。

## 已知限制

- `acpx` CLI 参数必须与本机安装版本匹配。不同版本可能需要更新内部 invocation。
- `cancel_worker` 是 best-effort。它会向 `acpx` 发送取消请求，但不保证一定能停止已经运行的底层进程。
- `no_wait` 后台任务通过 result 文件和当前 MCP 进程内 job state 跟踪。如果 MCP server 进程中途退出，应检查保存的 events/stderr 产物，再决定重跑或取消。
- 字符串形式 `test_command` 通过 shell 执行，只应用于可信输入。
- worktree 隔离是可选能力。审查后用 `apply_worker_patch` 应用结果，再用 `cleanup_worker` 清理产物或 worktree。
- reviewer 必须审查实际 diff 和测试日志；worker summary 不能作为接受依据。
- `acpx` spawn 失败和非零退出会尽量写入结构化 `.agent/results/<task_id>.result.json`。

## 运行测试

```bash
npm install
npm test
```

测试使用 [Vitest](https://vitest.dev)，并通过 mock `acpx` 验证关键逻辑，不需要真实 worker agent。
