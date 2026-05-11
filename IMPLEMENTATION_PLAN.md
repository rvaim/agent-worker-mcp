# agent-worker-mcp 当前实现差距与完善计划

## 1. 文档目的

本文档用于补充当前 `agent-worker-mcp` 实现中尚未完成、需要验证或建议增强的内容。

当前项目已经具备基础 MVP 能力：

```text
Leader / Reviewer Agent
  → MCP tools
    → acpx
      → ACP
        → Worker Agent
```

已经实现的核心方向包括：

- MCP stdio server
- `run_worker`
- `revise_worker`
- `read_worker_result`
- `cancel_worker`
- `list_worker_agents`
- 通过 `acpx` 调用 worker agent
- 写入 `.agent/tasks`
- 保存 worker events / stderr
- 收集 git diff
- 可选运行 test command
- 写入 `.agent/results/<task_id>.result.json`
- 基础 task_id 校验
- worker agent 白名单
- 基础 allowed / forbidden files policy 检查
- 可选 worktree 隔离雏形

但当前实现还不是生产级版本。以下是需要补齐的内容。

---

## 2. P0：必须优先处理的问题

### 2.1 验证 `acpx` CLI 参数

当前实现假设 `acpx` 支持类似调用：

```bash
acpx \
  --cwd <run_cwd> \
  --format json \
  --timeout <seconds> \
  --json-strict \
  --approve-all \
  <worker_agent> exec \
  --file <prompt_file>
```

但这必须在真实环境中验证。

请执行：

```bash
acpx --help
acpx claude --help
acpx claude exec --help
acpx gemini --help
acpx opencode --help
```

需要确认这些参数是否存在：

```text
--cwd
--format json
--json-strict
--approve-all
--timeout
exec
--file
```

如果实际参数不同，只修改 MCP server 内部的 `acpx` invocation builder，不要修改 MCP tools 对外 schema。

验收标准：

- `run_worker` 能真实调用 `acpx` 并成功产出 events 文件
- `revise_worker` 能真实调用 `acpx` 并成功产出 revision events 文件
- README 中说明已经基于哪个 `acpx` 版本验证

---

### 2.2 修复 `revise_worker` 覆盖历史信息的问题

当前风险：

- revision 可能覆盖原始 run metadata
- `revision_events_paths` 没有真正累积
- `created_at` 可能在 revision 时被刷新
- 原始 `events_path` 可能丢失
- 原始 `stderr_paths` 可能丢失

期望行为：

- 初次 `run_worker` 创建 result JSON
- 后续每次 `revise_worker` 读取旧 result JSON
- 保留：
  - `created_at`
  - `events_path`
  - `task_path`
  - `initial_test_log_path`
  - `initial_stderr_path`
- 累积：
  - `revision_events_paths`
  - `revision_stderr_paths`
  - `revision_test_log_paths`
- 更新：
  - `updated_at`
  - `status`
  - `revision_count`
  - `diff_path`
  - `changed_files`
  - `policy`
  - `latest_test_log_path`

建议 result JSON 结构：

```json
{
  "task_id": "task-001",
  "worker_agent": "claude",
  "status": "revised",
  "created_at": "2026-05-11T00:00:00.000Z",
  "updated_at": "2026-05-11T00:15:00.000Z",
  "events_path": ".agent/results/task-001.run.events.ndjson",
  "stderr_paths": [
    ".agent/results/task-001.run.stderr.log",
    ".agent/results/task-001.revision-1.stderr.log"
  ],
  "revision_events_paths": [
    ".agent/results/task-001.revision-1.events.ndjson"
  ],
  "test_log_paths": [
    ".agent/results/task-001.run.test.log",
    ".agent/results/task-001.revision-1.test.log"
  ],
  "latest_test_log_path": ".agent/results/task-001.revision-1.test.log",
  "revision_count": 1
}
```

验收标准：

- 多次调用 `revise_worker` 后，历史 events/stderr/test logs 不丢失
- `revision_count` 正确递增
- `created_at` 不被刷新
- `updated_at` 正确更新

---

### 2.3 revision 时继承 `allowed_files` / `forbidden_files`

当前风险：

`revise_worker` 只接收 `review_feedback`，如果没有重新传入 `allowed_files` / `forbidden_files`，policy 检查可能丢失原任务约束。

期望行为：

- `run_worker` 将 `allowed_files` 和 `forbidden_files` 写入 result JSON
- `revise_worker` 默认从旧 result JSON 或原任务文件中继承这些约束
- 如果调用方重新传入约束，则可以覆盖或合并，但行为需要明确

验收标准：

- 初次任务中的 forbidden files 在 revision 阶段仍然生效
- revision 修改 forbidden file 时，result JSON 标记 violation

---

### 2.4 完整收集 git 变更，避免漏掉 staged / untracked files

当前风险：

只使用：

```bash
git diff
git diff --name-only
```

可能漏掉：

- staged changes
- untracked files
- 新建但未 git add 的文件
- 删除 / rename 状态细节

建议收集：

```bash
git status --porcelain=v1
git diff --binary
git diff --cached --binary
git diff --name-only
git diff --cached --name-only
git ls-files --others --exclude-standard
```

建议产物：

```text
.agent/results/<task_id>.diff
.agent/results/<task_id>.cached.diff
.agent/results/<task_id>.status.txt
.agent/results/<task_id>.untracked.txt
```

`changed_files` 应合并：

- unstaged tracked files
- staged files
- untracked files

验收标准：

- worker 新建文件但未 git add 时，`changed_files` 能包含该文件
- staged changes 不会被漏掉
- result JSON 能反映完整改动范围

---

### 2.5 spawn / acpx 失败时也要写 result JSON

当前风险：

如果发生：

- `acpx` 不存在
- spawn 失败
- acpx exit code 非 0
- stdout/stderr 写入失败
- git 命令失败

MCP tool 可能直接 throw，导致调用方拿不到结构化结果。

期望行为：

只要 `task_id` 和 `cwd` 已知，就尽量写入：

```text
.agent/results/<task_id>.result.json
```

失败 result 示例：

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

验收标准：

- `acpx` 不存在时，tool 返回结构化错误
- `acpx` exit code 非 0 时，result JSON 存在
- MCP server 不因单个任务失败而崩溃

---

## 3. P1：稳定性与可维护性增强

### 3.1 增加 mock acpx 自动化测试

当前没有自动化测试。

建议增加：

```text
tests/
  run-worker.test.ts
  revise-worker.test.ts
  read-worker-result.test.ts
  policy.test.ts
  fixtures/
    mock-acpx.js
```

mock `acpx` 应模拟：

- 正常 stdout NDJSON
- stderr 输出
- exit code 0
- exit code 1
- 超时
- 写入一个假文件，模拟 worker 改代码

测试重点：

- `run_worker` 生成正确 artifacts
- `revise_worker` 生成 revision prompt
- `read_worker_result` 能读取 diff/test log
- 非法 task_id 报错
- 非白名单 worker agent 报错
- forbidden file policy 生效
- untracked files 能进入 changed_files

验收标准：

```bash
npm test
```

能够通过。

---

### 3.2 `read_worker_result` 返回精确 truncated map

当前可能只有笼统说明，例如：

```text
Long fields may be truncated according to max_bytes.
```

建议改成：

```json
{
  "truncated": {
    "diff": true,
    "test_log": false,
    "events": true,
    "result": false
  }
}
```

每个字段都应独立标记是否被截断。

验收标准：

- 超长 diff 被截断时，`truncated.diff = true`
- 未截断字段明确为 false
- 返回内容大小受 `max_bytes` 控制

---

### 3.3 改进 `cancel_worker` 语义

当前 `cancel_worker` 更像 best-effort。

问题：

- 没有维护 job id
- 没有维护 pid
- 没有维护 acpx session registry
- 不能保证真的取消后台任务

建议短期明确：

```text
cancel_worker 是 best-effort。
它尝试调用 acpx cancel。
如果失败，记录 cancel_failed，但不让 MCP server 崩溃。
```

建议 result JSON 状态：

```json
{
  "status": "cancel_requested",
  "cancel": {
    "attempted": true,
    "succeeded": false,
    "error": "..."
  }
}
```

长期可以增加真正 job manager。

验收标准：

- cancel 失败不会 crash
- result JSON 记录 cancel 尝试结果
- README 说明 cancel 是 best-effort

---

### 3.4 明确 `no_wait` / 异步任务语义

如果项目保留 `no_wait` 参数，需要修正当前语义。

当前风险：

- `acpx --no-wait` 后 worker 可能还没完成
- MCP server 立即收集 diff
- 测试可能提前执行
- result JSON 状态不准确

建议两种选择：

#### 选择 A：第一版移除或禁用 `no_wait`

最简单、最稳。

#### 选择 B：实现真正异步任务

需要增加：

- job id
- status 文件
- pid/session 记录
- poll/status tool
- result finalization
- cancel by job/session

验收标准：

- 如果保留 `no_wait`，必须不提前收集 final diff/test log
- read result 能显示 pending/running/completed 状态

---

### 3.5 `test_command` 支持结构化命令

当前字符串命令方便，但有命令注入风险。

建议支持两种形式：

```json
{
  "test_command": "npm test -- auth"
}
```

以及更安全的：

```json
{
  "test_command": {
    "cmd": "npm",
    "args": ["test", "--", "auth"]
  }
}
```

短期可以保留字符串，但 README 必须明确风险。

验收标准：

- 字符串命令兼容旧调用
- 结构化命令不通过 shell 执行
- 测试日志和 exit code 正常保存

---

### 3.6 worktree 分支冲突与清理

当前 worktree 支持是雏形。

需要处理：

- `.agent/worktrees/<task_id>` 已存在
- `agent/<task_id>` branch 已存在
- worktree 已损坏
- 重复运行同一个 task
- 清理 worktree
- 删除或保留 branch 的策略

建议新增行为：

```text
如果 worktree 已存在：
  - 默认复用
  - 或通过 force_recreate_worktree=true 重新创建

如果 branch 已存在：
  - 默认复用
  - 或生成 agent/<task_id>-<timestamp>
```

验收标准：

- 同一个 task 重复运行不会直接失败
- README 说明 worktree 生命周期策略

---

## 4. P2：增强体验与观测性

### 4.1 解析 worker events，提取 final summary

当前只保存 raw events。

建议从 events.ndjson 中提取：

- final message
- summary
- stop reason
- tool calls
- duration
- token / cost，如果 acpx 提供
- error event，如果有

写入 result JSON：

```json
{
  "worker_summary": "...",
  "worker_stop_reason": "end_turn",
  "worker_metrics": {
    "duration_ms": 12345,
    "input_tokens": null,
    "output_tokens": null,
    "cost_usd": null
  }
}
```

验收标准：

- reviewer agent 可以不读完整 events，也能看到 worker final summary
- raw events 仍然保留

---

### 4.2 增加 apply / merge 辅助工具

当前项目只负责让 worker 修改代码并收集 diff。

如果启用 worktree 隔离，最终还需要将 worktree 改动应用回主工作区。

可选新增 tools：

```text
apply_worker_patch
merge_worker_worktree
cleanup_worker_worktree
```

第一版可以不做，但文档应说明当前不负责 merge。

---

### 4.3 支持自定义 worker agent command

当前通过 `acpx <worker_agent>` 调用预定义 agent。

长期可支持：

```json
{
  "worker_agent": "custom",
  "worker_command": "my-agent-acp --stdio"
}
```

或通过环境变量配置 agent alias。

这可以让任意 ACP agent 接入。

---

### 4.4 增加成本、耗时、token 统计

如果 `acpx` events 中包含 usage 信息，应提取并记录。

建议字段：

```json
{
  "metrics": {
    "started_at": "...",
    "finished_at": "...",
    "duration_ms": 123456,
    "input_tokens": 1234,
    "output_tokens": 567,
    "cost_usd": 0.01
  }
}
```

---

## 5. 文档需要补充的章节

### 5.1 README.md 增加 Known Limitations

建议加入：

```markdown
## Known Limitations

- acpx CLI arguments must be verified against the installed acpx version.
- cancel_worker is currently best-effort unless a full job manager is enabled.
- no_wait / background execution is not production-ready unless explicitly implemented.
- test_command as string is executed through shell and should be treated as trusted input.
- worktree isolation is optional and may require manual cleanup.
- reviewer agents must inspect git diff and test logs; worker summaries are not sufficient.
```

---

### 5.2 IMPLEMENTATION_PLAN.md 增加 Backlog

将本文档 P0/P1/P2 内容加入 `IMPLEMENTATION_PLAN.md`，或保留为独立 `IMPLEMENTATION_GAPS.md`。

---

### 5.3 AGENTS.example.md 增加 reviewer 注意事项

建议增加：

```markdown
Never accept a worker result based only on the worker's summary.
Always inspect:
- result JSON
- changed files
- git diff
- test log
- policy violations

If the worker modified forbidden files, request revision or reject the result.
```

---

## 6. 推荐下一步执行顺序

建议按以下顺序推进：

```text
1. 验证 acpx CLI 参数
2. 修 revise_worker 历史保留
3. 修 changed_files / git diff 完整性
4. 修失败时 result JSON 兜底
5. 增加 mock acpx 测试
6. 改 read_worker_result truncated map
7. 明确或禁用 no_wait
8. 改进 cancel_worker 状态记录
9. 增强 worktree 复用和清理
10. 解析 worker events summary
```

---

## 7. 当前状态判断

当前实现适合：

```text
MVP
本地实验
单任务同步调用
验证 agent-to-agent delegation 流程
```

当前还不适合直接作为生产级系统用于：

```text
大量并发任务
长时间后台任务
强安全边界环境
CI/CD 自动合并
复杂 worktree 生命周期管理
严格审计场景
```

达到生产级前，至少应完成 P0 和 P1 中的大部分内容。
