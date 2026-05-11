# Agent-to-Agent ACP Worker MCP 实施计划书

## 1. 项目背景

本项目的目标是实现一个 **通用的 Agent-to-Agent 调度型 MCP Server**。

它允许一个上游 agent，也就是 leader / reviewer agent，通过 MCP tools 委派任务给另一个下游 worker agent 执行。worker agent 可以是任何被 `acpx` 支持的 ACP-compatible agent，例如 Claude、Gemini、OpenCode、Qwen、Kimi 或其他自定义 ACP agent。

整体设计思想：

```text
Leader / Reviewer Agent
  → MCP tool
    → acpx
      → ACP
        → Worker Agent
```

本项目不绑定任何特定上游 agent，也不绑定任何特定下游 agent。

上游 agent 的职责：

- 理解用户目标
- 制定计划
- 拆分任务
- 调用 MCP tool 委派 worker agent 执行
- 审核 worker agent 产出的 git diff、测试日志和结果文件
- 如果不通过，将 review feedback 发回 worker agent 修改
- 如果通过，汇总最终结果

MCP Server 的职责：

- 暴露稳定的 MCP tools
- 接收上游 agent 的任务请求
- 调用 `acpx` 执行指定 worker agent
- 保存 worker 输出、diff、测试日志、状态文件
- 将结构化结果返回给上游 agent

`acpx` 的职责：

- 作为 headless ACP client
- 统一调用 Claude、Gemini、OpenCode、Qwen、Kimi 或其他 ACP-compatible agents
- 处理 ACP 协议细节

本项目不自研 ACP client，也不直接适配每个 agent。`acpx` 已经负责 agent 适配层，本项目只做 MCP 封装、任务管理、artifact 收集和审查辅助。

---

## 2. 当前工作区假设

当前 agent 的工作区就是本项目根目录。

请先检查已有文件：

```text
package.json
tsconfig.json
src/
README.md
AGENTS.example.md
examples/
```

不要一开始就重写整个项目。优先：

1. 阅读现有代码
2. 判断哪些功能已实现
3. 对照本计划补齐缺口
4. 保持对外 tool schema 和目录结构稳定
5. 只在必要时重构

---

## 3. 目标架构

### 3.1 调用链路

```text
Leader / Reviewer Agent
  ↓ MCP tool call
agent-worker-mcp
  ↓ child_process.spawn
acpx
  ↓ ACP
Worker Agent
  ↓ modifies repo / emits output
agent-worker-mcp
  ↓ collect artifacts
Leader / Reviewer Agent reviews result
```

### 3.2 关键角色

| 角色 | 说明 |
|---|---|
| Leader Agent | 负责规划、拆任务、调用 worker、最终汇总 |
| Reviewer Agent | 负责审核 diff、测试日志、策略违规和结果质量。通常可以与 Leader Agent 是同一个 agent |
| Worker Agent | 负责执行具体实现任务 |
| MCP Server | 提供稳定工具接口，负责调用 acpx、保存结果、收集 diff/test log |
| acpx | ACP client 运行时，负责连接具体 worker agent |
| ACP Agent | 任何支持 Agent Client Protocol 的 agent |

### 3.3 产物目录结构

MCP Server 在目标 repo 内维护 `.agent/` 目录：

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
    task-001.run.test.log
    task-001.revision.test.log
  worktrees/
    task-001/
```

---

## 4. 必须实现的 MCP Tools

需要暴露以下 5 个 tools：

```text
run_worker
revise_worker
read_worker_result
cancel_worker
list_worker_agents
```

这些 tools 不应该体现某个特定 agent 名称。所有 agent 都通过参数传入。

---

# 5. Tool 设计

## 5.1 `run_worker`

### 作用

让上游 agent 委派一个子任务给指定 worker agent 执行。

### 输入 schema

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "cwd": "/absolute/path/to/repo",
  "instructions": "实现登录接口 rate limit，只修改 src/auth 和 tests/auth。",
  "allowed_files": [
    "src/auth/**",
    "tests/auth/**"
  ],
  "forbidden_files": [
    "migrations/**",
    ".env",
    "package-lock.json"
  ],
  "test_command": "npm test -- auth",
  "timeout_seconds": 1800,
  "isolate_worktree": false
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---:|---|
| `task_id` | 是 | 任务 ID，只允许 `/^[a-zA-Z0-9._-]+$/` |
| `worker_agent` | 否 | worker agent，默认使用 `DEFAULT_WORKER_AGENT` |
| `cwd` | 是 | 目标 git repo 根目录 |
| `instructions` | 是 | 给 worker 的任务说明 |
| `allowed_files` | 否 | 建议 worker 允许修改的文件范围 |
| `forbidden_files` | 否 | 禁止修改的文件范围 |
| `test_command` | 否 | worker 完成后由 MCP server 执行的测试命令 |
| `timeout_seconds` | 否 | 执行超时时间 |
| `isolate_worktree` | 否 | 是否为任务创建独立 git worktree |

### 行为

1. 校验 `task_id`
2. 校验 `worker_agent` 是否在白名单内
3. 校验 `cwd` 存在
4. 校验 `cwd` 是 git repo
5. 创建以下目录：

```text
.agent/tasks
.agent/reviews
.agent/results
.agent/worktrees
```

6. 写入任务文件：

```text
.agent/tasks/<task_id>.md
```

任务文件应包含：

```markdown
# Task: <task_id>

## Worker Agent

<worker_agent>

## Instructions

<instructions>

## Allowed Files

- ...

## Forbidden Files

- ...

## Acceptance Criteria

- Complete the requested implementation.
- Keep changes minimal and focused.
- Do not modify forbidden files.
- Run or support the requested tests when applicable.
- Return a concise summary of changes and risks.
```

7. 如果 `isolate_worktree=true`，创建独立 worktree：

```bash
git worktree add .agent/worktrees/<task_id> -b agent/<task_id> HEAD
```

并在该 worktree 内执行 worker。

8. 调用 `acpx`：

```bash
acpx \
  --cwd <run_cwd> \
  --format json \
  --json-strict \
  --approve-all \
  <worker_agent> exec \
  --file .agent/tasks/<task_id>.md
```

注意：实际参数必须以当前本地 `acpx --help` 为准。如果 `acpx` 参数发生变化，可以修改内部调用，但不要修改 MCP tool 对外 schema。

9. 保存 stdout：

```text
.agent/results/<task_id>.run.events.ndjson
```

10. 保存 stderr：

```text
.agent/results/<task_id>.run.stderr.log
```

11. 收集 git diff：

```bash
git diff > .agent/results/<task_id>.diff
```

如果使用 worktree，则在 worktree 内执行：

```bash
git -C <worktree> diff > .agent/results/<task_id>.diff
```

12. 收集 changed files：

```bash
git diff --name-only
```

13. 如果有 `test_command`，执行测试并保存：

```text
.agent/results/<task_id>.run.test.log
```

14. 生成 result JSON：

```text
.agent/results/<task_id>.result.json
```

15. 返回结构化结果给上游 agent。

### 输出示例

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "status": "completed",
  "cwd": "/absolute/path/to/repo",
  "run_cwd": "/absolute/path/to/repo",
  "task_path": ".agent/tasks/task-001.md",
  "result_path": ".agent/results/task-001.result.json",
  "events_path": ".agent/results/task-001.run.events.ndjson",
  "stderr_path": ".agent/results/task-001.run.stderr.log",
  "diff_path": ".agent/results/task-001.diff",
  "test_log_path": ".agent/results/task-001.run.test.log",
  "changed_files": [
    "src/auth/rateLimit.ts",
    "tests/auth/rateLimit.test.ts"
  ],
  "test_exit_code": 0,
  "revision_count": 0,
  "policy": {
    "forbidden_file_modified": false,
    "outside_allowed_files": false,
    "violations": []
  },
  "summary": "Worker finished. The reviewer agent must inspect diff and test logs before accepting."
}
```

---

## 5.2 `revise_worker`

### 作用

上游 reviewer agent 审核 worker 结果后，如果发现 blocking issues，则调用该 tool 将反馈发回 worker 修改。

### 输入 schema

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "cwd": "/absolute/path/to/repo",
  "review_feedback": "实现基本正确，但缺少 IP 维度限流测试。请只补充测试和必要代码，不要重构无关模块。",
  "test_command": "npm test -- auth",
  "timeout_seconds": 1800
}
```

### 行为

1. 校验 `task_id`
2. 校验 `worker_agent`
3. 校验 `cwd`
4. 读取原任务文件：

```text
.agent/tasks/<task_id>.md
```

5. 写入 review feedback：

```text
.agent/reviews/<task_id>.md
```

6. 生成 revision prompt：

```text
.agent/results/<task_id>.revise.prompt.md
```

revision prompt 内容应包括：

```markdown
# Original Task

<原始任务>

# Review Feedback

<review_feedback>

# Revision Instructions

Fix only the blocking issues identified by the reviewer.
Do not perform unrelated refactors.
Do not modify forbidden files.
Keep the patch minimal and focused.
After changes, provide a concise summary of what was fixed.
```

7. 调用 `acpx`：

```bash
acpx \
  --cwd <run_cwd> \
  --format json \
  --json-strict \
  --approve-all \
  <worker_agent> exec \
  --file .agent/results/<task_id>.revise.prompt.md
```

8. 保存 stdout：

```text
.agent/results/<task_id>.revision.events.ndjson
```

9. 保存 stderr：

```text
.agent/results/<task_id>.revision.stderr.log
```

10. 更新 diff：

```text
.agent/results/<task_id>.diff
```

11. 重新收集 changed files

12. 如果有 `test_command`，执行测试并保存：

```text
.agent/results/<task_id>.revision.test.log
```

13. 更新 result JSON：

- `status = "revised"` 或 `"completed"`
- `revision_count += 1`
- 追加 revision events path
- 更新 test log path
- 更新 changed files
- 更新 policy 检查结果

### 输出示例

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "status": "revised",
  "revision_count": 1,
  "revision_events_path": ".agent/results/task-001.revision.events.ndjson",
  "diff_path": ".agent/results/task-001.diff",
  "test_log_path": ".agent/results/task-001.revision.test.log",
  "test_exit_code": 0,
  "changed_files": [
    "src/auth/rateLimit.ts",
    "tests/auth/rateLimit.test.ts"
  ],
  "summary": "Worker revised the implementation. The reviewer agent must review the updated diff."
}
```

---

## 5.3 `read_worker_result`

### 作用

让上游 agent 读取某个任务的 result、diff、test log 和 events。

### 输入 schema

```json
{
  "task_id": "task-001",
  "cwd": "/absolute/path/to/repo",
  "include_diff": true,
  "include_test_log": true,
  "include_events": false,
  "max_bytes": 200000
}
```

### 行为

1. 校验 `task_id`
2. 读取：

```text
.agent/results/<task_id>.result.json
```

3. 根据参数读取：

```text
.agent/results/<task_id>.diff
.agent/results/<task_id>.run.test.log
.agent/results/<task_id>.revision.test.log
.agent/results/<task_id>.run.events.ndjson
.agent/results/<task_id>.revision.events.ndjson
```

4. 对超长内容截断，避免上游 agent 上下文爆炸。

### 输出示例

```json
{
  "task_id": "task-001",
  "result": {
    "status": "completed",
    "changed_files": []
  },
  "diff": "...",
  "test_log": "...",
  "events": "...",
  "truncated": {
    "diff": false,
    "test_log": false,
    "events": true
  }
}
```

---

## 5.4 `cancel_worker`

### 作用

请求取消某个 worker session。

### 输入 schema

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "cwd": "/absolute/path/to/repo"
}
```

### 行为

1. 校验 `task_id`
2. 尝试调用 `acpx` 的 cancel 能力
3. cancel 失败不能导致 MCP server 崩溃
4. 更新 result JSON：

```json
{
  "status": "cancel_requested"
}
```

### 输出示例

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "status": "cancel_requested"
}
```

---

## 5.5 `list_worker_agents`

### 作用

列出当前 MCP Server 允许调用的 worker agents。

### 输入

```json
{}
```

### 输出示例

```json
{
  "default_worker_agent": "claude",
  "allowed_worker_agents": [
    "claude",
    "gemini",
    "opencode",
    "qwen",
    "kimi",
    "codex"
  ],
  "acpx_bin": "acpx",
  "approval_mode": "all"
}
```

---

# 6. 环境变量

MCP Server 应支持以下环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ACPX_BIN` | `acpx` | acpx 可执行文件路径 |
| `DEFAULT_WORKER_AGENT` | `claude` | 默认 worker agent |
| `ALLOWED_WORKER_AGENTS` | `claude,gemini,opencode,qwen,kimi,codex` | worker agent 白名单 |
| `ACPX_APPROVAL` | `all` | acpx 权限策略 |
| `WORKER_MAX_TIMEOUT_SECONDS` | `3600` | 最大超时时间 |
| `WORKER_MAX_OUTPUT_BYTES` | `200000` | 最大返回内容大小 |

为了兼容旧版本，也可以临时支持这些别名：

| 旧变量 | 新变量 |
|---|---|
| `DEFAULT_ACPX_AGENT` | `DEFAULT_WORKER_AGENT` |
| `ALLOWED_ACPX_AGENTS` | `ALLOWED_WORKER_AGENTS` |

---

# 7. 实现要求

## 7.1 技术栈

- TypeScript
- Node.js
- `@modelcontextprotocol/sdk`
- `zod`
- `child_process.spawn`

不要使用 `child_process.exec` 运行 `acpx`，避免 stdout/stderr 过大导致 buffer 问题。

---

## 7.2 MCP Server 形态

使用 stdio transport。

入口大致如下：

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "agent-worker-mcp",
  version: "0.1.0"
});

// register tools

await server.connect(new StdioServerTransport());
```

---

## 7.3 安全要求

### task_id 校验

`task_id` 只能匹配：

```regex
^[a-zA-Z0-9._-]+$
```

禁止：

```text
../
..\
/
\
空字符串
```

---

### worker agent 白名单

`worker_agent` 必须在 `ALLOWED_WORKER_AGENTS` 中。

非法 worker agent 应直接报错，不要传给 `acpx`。

---

### cwd 校验

`cwd` 必须：

1. 存在
2. 是目录
3. 是 git repo

可以用：

```bash
git -C <cwd> rev-parse --show-toplevel
```

---

### 路径安全

所有 `.agent` 相关路径必须位于 `cwd` 内部。

实现辅助函数：

```ts
function assertInside(base: string, target: string) {
  const baseResolved = path.resolve(base);
  const targetResolved = path.resolve(target);

  if (
    targetResolved !== baseResolved &&
    !targetResolved.startsWith(baseResolved + path.sep)
  ) {
    throw new Error(`Path escapes base directory: ${targetResolved}`);
  }
}
```

---

### test_command 风险

第一版可以支持字符串 `test_command`，但 README 中必须说明它会通过 shell 执行，存在命令注入风险。

更安全的长期方案是支持结构化命令：

```json
{
  "cmd": "npm",
  "args": ["test", "--", "auth"]
}
```

---

# 8. Result JSON 格式

`.agent/results/<task_id>.result.json` 推荐格式：

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "status": "completed",
  "created_at": "2026-05-11T00:00:00.000Z",
  "updated_at": "2026-05-11T00:10:00.000Z",
  "cwd": "/repo",
  "run_cwd": "/repo",
  "worktree_path": null,
  "task_path": ".agent/tasks/task-001.md",
  "review_path": ".agent/reviews/task-001.md",
  "events_path": ".agent/results/task-001.run.events.ndjson",
  "revision_events_paths": [],
  "stderr_paths": [
    ".agent/results/task-001.run.stderr.log"
  ],
  "diff_path": ".agent/results/task-001.diff",
  "test_log_path": ".agent/results/task-001.run.test.log",
  "changed_files": [],
  "test_command": "npm test -- auth",
  "test_exit_code": 0,
  "revision_count": 0,
  "policy": {
    "forbidden_file_modified": false,
    "outside_allowed_files": false,
    "violations": []
  },
  "error": null
}
```

---

# 9. Policy 检查

MCP Server 应做基础机械检查，但最终审核仍由上游 reviewer agent 完成。

## 9.1 changed files

使用：

```bash
git diff --name-only
```

保存到 result JSON 的 `changed_files`。

---

## 9.2 forbidden_files

如果 changed files 命中 `forbidden_files`，标记：

```json
{
  "policy": {
    "forbidden_file_modified": true,
    "violations": [
      {
        "type": "forbidden_file_modified",
        "file": "migrations/001.sql",
        "pattern": "migrations/**"
      }
    ]
  }
}
```

---

## 9.3 allowed_files

如果传入了 `allowed_files`，changed files 中有文件不匹配任何 allowed pattern，则标记：

```json
{
  "policy": {
    "outside_allowed_files": true,
    "violations": [
      {
        "type": "outside_allowed_files",
        "file": "src/billing/index.ts"
      }
    ]
  }
}
```

---

# 10. Phase 实施计划

## Phase 1：基础 MCP Server

目标：项目能编译，上游 agent 能看到 tools。

任务：

- 检查 package.json
- 检查 tsconfig.json
- 确保 `src/index.ts` 可以启动 stdio MCP server
- 注册 5 个 tools
- 每个 tool 至少有 schema 和占位实现
- `npm run build` 必须通过

验收：

```bash
npm install
npm run build
npm start
```

---

## Phase 2：实现 `list_worker_agents`

目标：验证 MCP Server 基本可用。

任务：

- 读取环境变量
- 解析 `ALLOWED_WORKER_AGENTS`
- 返回 default worker agent、allowed worker agents、acpx bin、approval mode
- 兼容读取旧环境变量 `DEFAULT_ACPX_AGENT` 和 `ALLOWED_ACPX_AGENTS`

验收：

- MCP Inspector 或任意 MCP client 能调用 `list_worker_agents`
- 返回稳定 JSON

---

## Phase 3：实现 `run_worker`

目标：上游 agent 能通过 MCP 调用 acpx 跑 worker。

任务：

- 校验输入
- 写任务文件
- 调用 acpx
- 保存 stdout/stderr
- 收集 diff
- 收集 changed files
- 可选运行测试
- 写 result JSON
- 返回 result JSON

验收：

调用 `run_worker` 后，生成：

```text
.agent/tasks/<task_id>.md
.agent/results/<task_id>.run.events.ndjson
.agent/results/<task_id>.run.stderr.log
.agent/results/<task_id>.diff
.agent/results/<task_id>.result.json
```

---

## Phase 4：实现 `read_worker_result`

目标：上游 agent 能方便读取结果。

任务：

- 读取 result JSON
- 可选读取 diff
- 可选读取 test log
- 可选读取 events
- 实现 max_bytes 截断
- 返回 truncated 信息

验收：

- 能返回 result
- 能返回 diff
- 超长内容不会导致 MCP 返回爆炸

---

## Phase 5：实现 `revise_worker`

目标：支持 reviewer agent 审核后打回 worker 修改。

任务：

- 读取原任务
- 写 review feedback
- 生成 revise prompt
- 调用 acpx
- 保存 revision events/stderr
- 更新 diff
- 重新运行测试
- 更新 result JSON
- revision_count + 1

验收：

生成：

```text
.agent/reviews/<task_id>.md
.agent/results/<task_id>.revise.prompt.md
.agent/results/<task_id>.revision.events.ndjson
.agent/results/<task_id>.revision.stderr.log
.agent/results/<task_id>.diff
.agent/results/<task_id>.result.json
```

---

## Phase 6：实现 policy checks

目标：MCP Server 先做机械安全检查。

任务：

- 实现 glob 匹配
- 检查 forbidden_files
- 检查 allowed_files
- 写入 result JSON 的 `policy` 字段

验收：

- 修改 forbidden file 时，result JSON 标记 violation
- 修改 allowed_files 之外文件时，result JSON 标记 warning/violation

---

## Phase 7：实现 `cancel_worker`

目标：支持取消 worker。

任务：

- 尝试调用 acpx cancel
- 捕获错误
- 更新 result JSON status
- 返回 cancel_requested

验收：

- cancel 失败也不会 crash
- 返回结构化 JSON

---

## Phase 8：worktree 隔离

目标：避免 worker 直接污染主工作区。

任务：

- 支持 `isolate_worktree=true`
- 创建 `.agent/worktrees/<task_id>`
- 创建 branch `agent/<task_id>`
- acpx 在 worktree 内运行
- diff 从 worktree 收集
- result JSON 记录 `worktree_path`

验收：

- 主工作区不被 worker 直接修改
- worktree 中能看到修改
- diff 能被读取

---

## Phase 9：README 和 examples

目标：让用户能直接接入任意 MCP-capable 上游 agent。

README 必须包含：

1. 项目目标
2. 架构图
3. 安装方式
4. 环境变量
5. MCP client 配置示例
6. tool 使用示例
7. 推荐 leader/reviewer workflow
8. 安全注意事项
9. acpx 参数兼容说明

示例配置应使用通用表述，不要绑定某个上游 agent。

---

# 11. Leader / Reviewer Agent 使用规范

建议在 README 或 `AGENTS.example.md` 中加入：

```markdown
# Delegation policy

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
2. For each task, call run_worker with:
   - task_id
   - worker_agent
   - instructions
   - cwd
   - allowed_files
   - forbidden_files
   - test_command when applicable
3. After the worker finishes, call read_worker_result.
4. Review the actual git diff and test logs yourself.
5. Do not accept a worker result based only on the worker summary.
6. If there are blocking issues, call revise_worker with precise feedback.
7. Limit revisions to 3 attempts.
8. Accept only when:
   - the diff satisfies the task
   - tests pass or failure is explained
   - no forbidden files were modified
   - there is no obvious overengineering or unrelated refactor
9. Summarize final accepted changes for the user.
```

---

# 12. acpx 调用兼容要求

实现前必须在本地确认：

```bash
acpx --help
acpx claude --help
acpx claude exec --help
```

也应测试其他 worker agent：

```bash
acpx gemini --help
acpx opencode --help
acpx qwen --help
```

如果以下参数不可用：

```text
--cwd
--format json
--json-strict
--approve-all
exec
--file
```

请根据当前 acpx 版本修正内部调用方式。

但不要改变 MCP tools 对外 schema。

---

# 13. 错误处理要求

任何 tool 失败时，都必须返回结构化错误，而不是让 MCP Server 直接崩溃。

失败时应尽量写入 result JSON：

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "status": "failed",
  "error": {
    "message": "acpx exited with code 1",
    "exit_code": 1,
    "stderr_path": ".agent/results/task-001.run.stderr.log"
  }
}
```

常见失败场景：

- `acpx` 不存在
- worker agent 不在白名单
- cwd 不是 git repo
- task_id 非法
- worker 超时
- test command 失败
- acpx 参数不兼容
- stdout/stderr 文件写入失败

---

# 14. 最终验收标准

项目完成后必须满足：

## 构建

```bash
npm install
npm run build
```

必须成功。

## MCP Server

```bash
npm start
```

能作为 stdio MCP server 启动。

## Tools

MCP client 能看到：

```text
run_worker
revise_worker
read_worker_result
cancel_worker
list_worker_agents
```

## run_worker

调用后生成：

```text
.agent/tasks/<task_id>.md
.agent/results/<task_id>.run.events.ndjson
.agent/results/<task_id>.run.stderr.log
.agent/results/<task_id>.diff
.agent/results/<task_id>.result.json
```

## read_worker_result

能返回：

```text
result JSON
diff
test log
events，可选
truncated 标记
```

## revise_worker

调用后生成：

```text
.agent/reviews/<task_id>.md
.agent/results/<task_id>.revise.prompt.md
.agent/results/<task_id>.revision.events.ndjson
.agent/results/<task_id>.revision.stderr.log
.agent/results/<task_id>.diff
```

并更新：

```text
.agent/results/<task_id>.result.json
```

## 安全校验

必须生效：

- 非法 task_id 报错
- 非白名单 worker agent 报错
- 非 git repo 报错
- 路径穿越报错
- forbidden files 命中时 result JSON 标记 violation

---

# 15. 重要设计原则

1. 不自研 ACP client。
2. 不直接适配 Claude、Gemini、OpenCode、Qwen、Kimi 等 agent。
3. `acpx` 是唯一 agent 适配层。
4. MCP Server 只做稳定封装、状态管理、artifact 收集。
5. 上游 reviewer agent 必须审核 diff 和测试日志，不得只相信 worker summary。
6. worker agent 可以便宜或多样化，但 review 必须严格。
7. 外部 MCP tool schema 要稳定，即使内部 acpx 参数变化，也不要影响上游 agent 调用方式。
8. 默认先实现简单可用，再增加 worktree、policy、cancel、状态管理等增强能力。
9. 文档和命名中使用通用术语：leader agent、reviewer agent、worker agent、upstream agent、downstream agent。
10. 不要在核心接口中写死任何特定上游或下游 agent。
