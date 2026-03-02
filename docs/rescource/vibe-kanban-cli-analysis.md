# Vibe-Kanban CLI 交互与展示实现分析

> 本文档深入分析 vibe-kanban 项目的 CLI 集成、WebSocket 通信、Terminal UI 展示等核心机制，为 LocalKanban 项目提供实现参考。

---

## 1. 架构概览

### 1.1 整体交互流程

```
用户创建任务
  ↓
创建 Workspace + Worktree (可选)
  ↓
启动 CLI 进程 (Claude/Codex/Cursor)
  ↓
PTY 捕获原始输出
  ↓
LogMsg 消息封装 (Stdout/Stderr/JsonPatch)
  ↓
MsgStore 广播 (Tokio broadcast channel)
  ↓
WebSocket 推送到前端
  ↓
前端 xterm.js 渲染 + 状态更新
```

### 1.2 技术栈映射

| 功能模块 | Vibe-Kanban (Rust) | LocalKanban (Node.js) 建议 |
|---------|-------------------|---------------------------|
| CLI 进程管理 | tokio::process::Command | node-pty (已实现) |
| WebSocket 服务 | axum + tokio-tungstenite | ws (已实现) |
| 消息广播 | tokio::sync::broadcast | EventEmitter / ws 广播 |
| 前端终端 | xterm.js v5.5.0 | xterm.js (已实现) |
| 状态管理 | Zustand | Zustand / React Context |
| 路由 | TanStack Router | react-router-dom (已实现) |

---

## 2. CLI 执行器实现

### 2.1 Claude CLI 执行器

**文件**: `crates/executors/src/executors/claude.rs`

#### 进程启动参数
```rust
// 伪代码
command = "npx"
args = [
  "-y", "@anthropic-ai/claude-code@2.1.45",
  "-p",  // 指定工作目录
  "--output-format=stream-json",
  "--input-format=stream-json",
  "--include-partial-messages",
  "--replay-user-messages",
  "--model", model_id,  // 如 "claude-opus-4-6"
  "--agent", agent_id,  // 可选
  "--permission-mode", permission_mode,  // "auto" / "supervised" / "plan"
]

// Node.js 实现建议 (使用 node-pty)
const pty = require('node-pty');
const ptyProcess = pty.spawn('npx', [
  '-y', '@anthropic-ai/claude-code@2.1.45',
  '-p',
  '--output-format=stream-json',
  '--input-format=stream-json',
  '--model', modelId,
  '--permission-mode', permissionMode
], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: workspaceDir,
  env: process.env
});
```

#### 控制协议特点
- **自定义协议**: 使用 `--output-format=stream-json` 和 `--input-format=stream-json`
- **流式输出**: 支持 `--include-partial-messages` 实时展示
- **权限模式**: `auto` (自动执行) / `supervised` (需确认) / `plan` (仅规划)

### 2.2 Codex CLI 执行器

**文件**: `crates/executors/src/executors/codex.rs`

#### 进程启动参数
```rust
// 伪代码
command = "npx"
args = [
  "-y", "@openai/codex@latest",
  "app-server",
  "--model", model_id,  // 如 "o3-mini"
  "--reasoning-effort", reasoning_effort,  // "low" / "medium" / "high"
]

// Node.js 实现建议
const ptyProcess = pty.spawn('npx', [
  '-y', '@openai/codex@latest',
  'app-server',
  '--model', modelId,
  '--reasoning-effort', reasoningEffort
], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: workspaceDir,
  env: process.env
});
```

#### 控制协议特点
- **JSON-RPC 2.0**: 标准化的请求/响应协议
- **推理控制**: `reasoning_effort` 参数控制思考深度
- **结构化输出**: 严格的 JSON 格式

### 2.3 Cursor CLI 执行器

**文件**: `crates/executors/src/executors/cursor.rs`

#### 进程启动参数
```rust
// 伪代码
command = "cursor-agent"
args = [
  "--model", model_id,  // 如 "gpt-4" / "claude-3-5-sonnet"
]

// Node.js 实现建议
const ptyProcess = pty.spawn('cursor-agent', [
  '--model', modelId
], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: workspaceDir,
  env: process.env
});
```

#### 控制协议特点
- **简单 JSON 流**: 每行一个 JSON 对象
- **多模型支持**: 支持 OpenAI 和 Anthropic 模型
- **轻量级**: 最简单的集成方式

### 2.4 CLI 执行器对比

| 特性 | Claude CLI | Codex CLI | Cursor CLI |
|------|-----------|-----------|-----------|
| 协议 | 自定义 stream-json | JSON-RPC 2.0 | 简单 JSON 流 |
| 权限控制 | 3 种模式 | 无 | 无 |
| 流式输出 | 支持 | 支持 | 支持 |
| 推理控制 | 无 | reasoning_effort | 无 |
| 模型选择 | Anthropic 系列 | OpenAI 系列 | 多厂商 |
| 集成复杂度 | 中 | 高 | 低 |

---

## 3. 服务端通信机制

### 3.1 WebSocket 协议

**文件**: `crates/server/src/routes/ws.rs`

#### 消息类型定义
```rust
// 伪代码
enum LogMsg {
  Stdout { data: String },      // 标准输出
  Stderr { data: String },      // 标准错误
  JsonPatch { patch: Value },   // JSON Patch 增量更新
  Ready,                        // CLI 就绪
  Finished { exit_code: i32 }   // 进程结束
}

// Node.js 实现建议
const LogMsgType = {
  STDOUT: 'stdout',
  STDERR: 'stderr',
  JSON_PATCH: 'json_patch',
  READY: 'ready',
  FINISHED: 'finished'
};

function sendLogMsg(ws, type, data) {
  ws.send(JSON.stringify({ type, data, timestamp: Date.now() }));
}
```

#### WebSocket 事件流
```
客户端连接
  ↓
发送 task_id
  ↓
订阅 MsgStore 广播
  ↓
接收历史消息 (如果有)
  ↓
实时接收新消息
  ↓
客户端断开 → 取消订阅
```

### 3.2 PTY 服务

**文件**: `crates/server/src/pty_service.rs`

#### 核心功能
```rust
// 伪代码
class PtyService {
  sessions: Map<task_id, PtySession>

  spawn(task_id, command, args, cwd) {
    pty = create_pty(command, args, cwd)
    session = PtySession { pty, msg_store }

    // 启动读取循环
    spawn_task(async {
      loop {
        data = pty.read()
        msg_store.broadcast(LogMsg::Stdout { data })
      }
    })

    sessions.insert(task_id, session)
  }

  write(task_id, input) {
    session = sessions.get(task_id)
    session.pty.write(input)
  }

  kill(task_id) {
    session = sessions.remove(task_id)
    session.pty.kill()
    msg_store.broadcast(LogMsg::Finished { exit_code: -1 })
  }
}

// Node.js 实现建议
class PtyService {
  constructor() {
    this.sessions = new Map();
  }

  spawn(taskId, command, args, cwd, msgStore) {
    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd,
      env: process.env
    });

    ptyProcess.onData(data => {
      msgStore.broadcast(taskId, { type: 'stdout', data });
    });

    ptyProcess.onExit(({ exitCode }) => {
      msgStore.broadcast(taskId, { type: 'finished', data: { exitCode } });
      this.sessions.delete(taskId);
    });

    this.sessions.set(taskId, { ptyProcess, msgStore });
  }

  write(taskId, input) {
    const session = this.sessions.get(taskId);
    if (session) {
      session.ptyProcess.write(input);
    }
  }

  kill(taskId) {
    const session = this.sessions.get(taskId);
    if (session) {
      session.ptyProcess.kill();
      this.sessions.delete(taskId);
    }
  }
}
```

### 3.3 消息广播 (MsgStore)

**文件**: `crates/server/src/msg_store.rs`

#### 核心设计
```rust
// 伪代码
class MsgStore {
  channels: Map<task_id, BroadcastChannel>
  history: Map<task_id, Vec<LogMsg>>

  broadcast(task_id, msg) {
    // 存储历史
    history.get(task_id).push(msg.clone())

    // 广播给所有订阅者
    channel = channels.get(task_id)
    channel.send(msg)
  }

  subscribe(task_id) -> Receiver {
    channel = channels.get_or_create(task_id)
    return channel.subscribe()
  }

  get_history(task_id) -> Vec<LogMsg> {
    return history.get(task_id).clone()
  }
}

// Node.js 实现建议
const EventEmitter = require('events');

class MsgStore extends EventEmitter {
  constructor() {
    super();
    this.history = new Map();
  }

  broadcast(taskId, msg) {
    // 存储历史
    if (!this.history.has(taskId)) {
      this.history.set(taskId, []);
    }
    this.history.get(taskId).push(msg);

    // 广播事件
    this.emit(`task:${taskId}`, msg);
  }

  subscribe(taskId, callback) {
    this.on(`task:${taskId}`, callback);

    // 返回取消订阅函数
    return () => this.off(`task:${taskId}`, callback);
  }

  getHistory(taskId) {
    return this.history.get(taskId) || [];
  }
}
```

### 3.4 JSON Patch 协议

**用途**: 增量更新任务状态，避免传输完整对象

```javascript
// 示例: 更新任务状态
{
  type: 'json_patch',
  data: {
    op: 'replace',
    path: '/status',
    value: 'running'
  }
}

// Node.js 实现建议
const jsonpatch = require('fast-json-patch');

function applyPatch(task, patchMsg) {
  const patch = patchMsg.data;
  jsonpatch.applyPatch(task, [patch]);
  return task;
}
```

---

## 4. 前端 UI 实现

### 4.1 xterm.js 集成

**文件**: `apps/web/src/components/Terminal.tsx`

#### 基础配置
```typescript
// 伪代码
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4'
  },
  scrollback: 10000
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.loadAddon(new WebLinksAddon());

terminal.open(containerElement);
fitAddon.fit();
```

#### WebSocket 双向通信
```typescript
// 接收服务端数据
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'stdout' || msg.type === 'stderr') {
    terminal.write(msg.data);
  } else if (msg.type === 'json_patch') {
    applyPatchToTask(msg.data);
  } else if (msg.type === 'finished') {
    terminal.write(`\r\n\x1b[32m[Process exited with code ${msg.data.exitCode}]\x1b[0m\r\n`);
  }
};

// 发送用户输入
terminal.onData((data) => {
  ws.send(JSON.stringify({
    type: 'input',
    data: data
  }));
});
```

### 4.2 状态指示器

**文件**: `apps/web/src/components/TaskCard.tsx`

#### 状态映射
```typescript
enum TaskStatus {
  IDLE = 'idle',       // 灰色 - 未启动
  RUNNING = 'running', // 蓝色 - 运行中
  COMPLETED = 'completed', // 绿色 - 已完成
  FAILED = 'failed',   // 红色 - 失败
  KILLED = 'killed'    // 灰色 - 已终止
}

function getStatusColor(status: TaskStatus): string {
  switch (status) {
    case TaskStatus.IDLE: return '#6b7280';
    case TaskStatus.RUNNING: return '#3b82f6';
    case TaskStatus.COMPLETED: return '#10b981';
    case TaskStatus.FAILED: return '#ef4444';
    case TaskStatus.KILLED: return '#6b7280';
  }
}
```

#### 状态指示器组件
```typescript
function StatusIndicator({ status }: { status: TaskStatus }) {
  const color = getStatusColor(status);
  const isAnimated = status === TaskStatus.RUNNING;

  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-3 h-3 rounded-full ${isAnimated ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: color }}
      />
      <span className="text-sm capitalize">{status}</span>
    </div>
  );
}
```

### 4.3 虚拟化日志渲染

**优化**: 对于大量日志，使用虚拟滚动避免性能问题

```typescript
// xterm.js 内置虚拟化，无需额外处理
// 但可以限制 scrollback 大小
const terminal = new Terminal({
  scrollback: 10000  // 最多保留 10000 行
});

// 如果需要完整日志，可以存储到后端
function saveFullLog(taskId: string) {
  const history = msgStore.getHistory(taskId);
  const fullLog = history
    .filter(msg => msg.type === 'stdout' || msg.type === 'stderr')
    .map(msg => msg.data)
    .join('');

  fs.writeFileSync(`logs/${taskId}.log`, fullLog);
}
```

### 4.4 用户交互

#### 输入处理
```typescript
// 处理特殊按键
terminal.onKey(({ key, domEvent }) => {
  const ev = domEvent;
  const printable = !ev.altKey && !ev.ctrlKey && !ev.metaKey;

  if (ev.keyCode === 13) {
    // Enter 键
    ws.send(JSON.stringify({ type: 'input', data: '\r' }));
  } else if (ev.keyCode === 8) {
    // Backspace 键
    ws.send(JSON.stringify({ type: 'input', data: '\b' }));
  } else if (printable) {
    ws.send(JSON.stringify({ type: 'input', data: key }));
  }
});
```

#### 终止任务
```typescript
function killTask(taskId: string) {
  fetch(`/api/tasks/${taskId}/kill`, { method: 'POST' })
    .then(() => {
      terminal.write('\r\n\x1b[33m[Task killed by user]\x1b[0m\r\n');
    });
}
```

---

## 5. 模型选择实现

### 5.1 前端组件

**文件**: `apps/web/src/components/ModelSelectorPopover.tsx`

#### 模型配置结构
```typescript
interface ModelConfig {
  executor: 'claude' | 'codex' | 'cursor';
  model: string;
  permissionMode?: 'auto' | 'supervised' | 'plan';
  reasoningEffort?: 'low' | 'medium' | 'high';
}

const AVAILABLE_MODELS = {
  claude: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }
  ],
  codex: [
    { id: 'o3-mini', name: 'O3 Mini' },
    { id: 'o1', name: 'O1' }
  ],
  cursor: [
    { id: 'gpt-4', name: 'GPT-4' },
    { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' }
  ]
};
```

#### 选择器组件
```typescript
function ModelSelectorPopover({ value, onChange }: Props) {
  const [executor, setExecutor] = useState(value.executor);
  const [model, setModel] = useState(value.model);

  const handleExecutorChange = (newExecutor) => {
    setExecutor(newExecutor);
    setModel(AVAILABLE_MODELS[newExecutor][0].id);
  };

  const handleSave = () => {
    onChange({ executor, model, ...otherOptions });
  };

  return (
    <Popover>
      <Select value={executor} onChange={handleExecutorChange}>
        <option value="claude">Claude CLI</option>
        <option value="codex">Codex CLI</option>
        <option value="cursor">Cursor CLI</option>
      </Select>

      <Select value={model} onChange={setModel}>
        {AVAILABLE_MODELS[executor].map(m => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </Select>

      {executor === 'claude' && (
        <Select value={permissionMode} onChange={setPermissionMode}>
          <option value="auto">Auto</option>
          <option value="supervised">Supervised</option>
          <option value="plan">Plan</option>
        </Select>
      )}

      {executor === 'codex' && (
        <Select value={reasoningEffort} onChange={setReasoningEffort}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
      )}

      <Button onClick={handleSave}>Save</Button>
    </Popover>
  );
}
```

### 5.2 后端配置应用

**文件**: `crates/server/src/executor_config.rs`

#### 配置结构
```rust
// 伪代码
struct ExecutorConfig {
  executor: ExecutorType,
  model: String,
  permission_mode: Option<String>,
  reasoning_effort: Option<String>
}

impl ExecutorConfig {
  fn apply_overrides(&mut self, overrides: ExecutorConfig) {
    if let Some(executor) = overrides.executor {
      self.executor = executor;
    }
    if let Some(model) = overrides.model {
      self.model = model;
    }
    // ... 其他字段
  }

  fn to_cli_args(&self) -> Vec<String> {
    match self.executor {
      ExecutorType::Claude => vec![
        "--model".to_string(),
        self.model.clone(),
        "--permission-mode".to_string(),
        self.permission_mode.clone().unwrap_or("auto".to_string())
      ],
      ExecutorType::Codex => vec![
        "--model".to_string(),
        self.model.clone(),
        "--reasoning-effort".to_string(),
        self.reasoning_effort.clone().unwrap_or("medium".to_string())
      ],
      ExecutorType::Cursor => vec![
        "--model".to_string(),
        self.model.clone()
      ]
    }
  }
}

// Node.js 实现建议
class ExecutorConfig {
  constructor(executor, model, options = {}) {
    this.executor = executor;
    this.model = model;
    this.permissionMode = options.permissionMode;
    this.reasoningEffort = options.reasoningEffort;
  }

  applyOverrides(overrides) {
    if (overrides.executor) this.executor = overrides.executor;
    if (overrides.model) this.model = overrides.model;
    if (overrides.permissionMode) this.permissionMode = overrides.permissionMode;
    if (overrides.reasoningEffort) this.reasoningEffort = overrides.reasoningEffort;
  }

  toCliArgs() {
    const args = ['--model', this.model];

    if (this.executor === 'claude' && this.permissionMode) {
      args.push('--permission-mode', this.permissionMode);
    }

    if (this.executor === 'codex' && this.reasoningEffort) {
      args.push('--reasoning-effort', this.reasoningEffort);
    }

    return args;
  }
}
```

### 5.3 数据流

```
前端用户选择模型
  ↓
POST /api/tasks { executor, model, options }
  ↓
后端创建 ExecutorConfig
  ↓
apply_overrides(用户配置)
  ↓
to_cli_args() 生成 CLI 参数
  ↓
PtyService.spawn(command, args)
  ↓
CLI 进程启动
```

---

## 6. Worktree 管理

**文件**: `crates/server/src/worktree_manager.rs`

### 6.1 核心功能

```rust
// 伪代码
class WorktreeManager {
  create_worktree(task_id, base_branch) {
    worktree_path = `.worktrees/${task_id}`
    branch_name = `task/${task_id}`

    // 创建 worktree
    exec(`git worktree add ${worktree_path} -b ${branch_name} ${base_branch}`)

    return worktree_path
  }

  remove_worktree(task_id) {
    worktree_path = `.worktrees/${task_id}`

    // 删除 worktree
    exec(`git worktree remove ${worktree_path} --force`)
  }
}

// Node.js 实现建议
const { execSync } = require('child_process');
const path = require('path');

class WorktreeManager {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.worktreesDir = path.join(repoPath, '.worktrees');
  }

  createWorktree(taskId, baseBranch = 'main') {
    const worktreePath = path.join(this.worktreesDir, taskId);
    const branchName = `task/${taskId}`;

    try {
      execSync(
        `git worktree add "${worktreePath}" -b "${branchName}" "${baseBranch}"`,
        { cwd: this.repoPath }
      );
      return worktreePath;
    } catch (error) {
      console.error(`Failed to create worktree: ${error.message}`);
      throw error;
    }
  }

  removeWorktree(taskId) {
    const worktreePath = path.join(this.worktreesDir, taskId);

    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: this.repoPath
      });
    } catch (error) {
      console.error(`Failed to remove worktree: ${error.message}`);
    }
  }
}
```

### 6.2 生命周期

```
任务创建
  ↓
(可选) 创建 worktree
  ↓
CLI 在 worktree 中执行
  ↓
任务完成/失败
  ↓
(可选) 清理 worktree
```

**注意**: LocalKanban 项目决定不使用 worktree (Unity 项目 Library 切换成本高)

---

## 7. LocalKanban 实现建议

### 7.1 Rust → Node.js 转换要点

| Rust 特性 | Node.js 替代方案 |
|----------|----------------|
| tokio::process::Command | node-pty |
| tokio::sync::broadcast | EventEmitter |
| axum + tokio-tungstenite | Express + ws |
| serde_json | JSON.parse/stringify |
| async/await | async/await (原生支持) |

### 7.2 关键实现步骤

1. **CLI 执行器** (`packages/server/src/executors/`)
   - `claude.ts`: Claude CLI 集成
   - `codex.ts`: Codex CLI 集成 (可选)
   - `cursor.ts`: Cursor CLI 集成 (可选)
   - `base.ts`: 通用执行器接口

2. **PTY 服务** (`packages/server/src/services/pty-service.ts`)
   - 使用 node-pty 管理伪终端
   - 监听 onData 和 onExit 事件
   - 广播到 MsgStore

3. **消息广播** (`packages/server/src/services/msg-store.ts`)
   - 继承 EventEmitter
   - 实现 broadcast/subscribe/getHistory

4. **WebSocket 路由** (`packages/server/src/routes/ws.ts`)
   - 处理客户端连接
   - 订阅 MsgStore
   - 转发消息到客户端

5. **前端终端** (`packages/web/src/components/Terminal.tsx`)
   - 集成 xterm.js
   - WebSocket 双向通信
   - 状态指示器

6. **模型选择** (`packages/web/src/components/ModelSelector.tsx`)
   - 前端选择器组件
   - 后端配置应用

### 7.3 简化建议

**Phase 2 最小实现**:
- 仅支持 Claude CLI
- 固定权限模式 (supervised)
- 简化状态指示器 (仅 idle/running/completed/failed)
- 不实现 worktree 管理

**Phase 3 扩展**:
- 添加 Codex/Cursor 支持
- 可配置权限模式
- 完整状态指示器
- 日志持久化

### 7.4 关键文件路径

```
LocalKanban/
├── packages/
│   ├── server/
│   │   ├── src/
│   │   │   ├── executors/
│   │   │   │   ├── base.ts
│   │   │   │   ├── claude.ts
│   │   │   │   ├── codex.ts
│   │   │   │   └── cursor.ts
│   │   │   ├── services/
│   │   │   │   ├── pty-service.ts
│   │   │   │   └── msg-store.ts
│   │   │   ├── routes/
│   │   │   │   ├── ws.ts
│   │   │   │   └── tasks.ts
│   │   │   └── types/
│   │   │       ├── executor-config.ts
│   │   │       └── log-msg.ts
│   └── web/
│       ├── src/
│       │   ├── components/
│       │   │   ├── Terminal.tsx
│       │   │   ├── TaskCard.tsx
│       │   │   └── ModelSelector.tsx
│       │   ├── hooks/
│       │   │   └── useWebSocket.ts
│       │   └── types/
│       │       └── task.ts
```

---

## 8. 总结

### 8.1 核心设计模式

1. **进程管理**: node-pty 提供伪终端能力
2. **消息广播**: EventEmitter 实现发布/订阅
3. **实时通信**: WebSocket 双向数据流
4. **状态同步**: JSON Patch 增量更新
5. **终端渲染**: xterm.js 虚拟化渲染

### 8.2 关键技术决策

- **不使用 worktree**: Unity 项目 Library 切换成本高
- **优先支持 Claude CLI**: 最成熟的 AI 编程助手
- **简化权限模式**: Phase 2 固定为 supervised
- **WebSocket 双通道**: pty_data (原始) + parsed events (状态)

### 8.3 下一步行动

1. 实现 `PtyService` 和 `MsgStore`
2. 创建 Claude CLI 执行器
3. 实现 WebSocket 路由
4. 集成 xterm.js 到前端
5. 添加状态指示器
6. 测试完整流程

---

**文档版本**: v1.0
**最后更新**: 2026-03-03
**参考项目**: [vibe-kanban](https://github.com/example/vibe-kanban) (假设链接)
