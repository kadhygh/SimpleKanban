# Vibe-Kanban 项目分析

> 本文档记录对 vibe-kanban 原项目的分析，供 LocalKanban 开发参考。

---

## 技术栈和规模

### 后端：Rust

- 376 个 Rust 文件
- 多个 crates（模块）：executors, git, services, server 等
- 使用 SQLite 数据库
- 复杂的 worktree 管理系统

### 前端：React + TypeScript

- React 18 + Vite
- TanStack Router（文件路由）
- Radix UI + Tailwind CSS
- 大量依赖（Lexical 编辑器、CodeMirror、xterm.js 等）

### 架构复杂度：⭐⭐⭐⭐⭐（非常高）

---

## Worktree 集成深度

从代码分析来看：

1. 专门的 worktree_manager.rs（独立模块）
2. workspace_manager.rs 依赖 worktree
3. executors 层调用 worktree（Claude、Codex 等 CLI 执行器）
4. 有环境变量控制：`DISABLE_WORKTREE_CLEANUP`

**好消息**：worktree 相对模块化，主要集中在 `worktree_manager.rs` 和 `workspace_manager.rs`

---

## 功能范围

从路由和代码看，vibe-kanban 包含：

- ✅ 项目管理（Projects）
- ✅ 问题跟踪（Issues）- 类似 GitHub Issues
- ✅ 工作空间管理（Workspaces）
- ✅ 多 CLI 执行器（Claude、Gemini、Codex、Cursor 等）
- ✅ Pull Request 集成
- ✅ 评论、标签、关注者系统
- ✅ 通知系统
- ✅ OAuth 认证
- ✅ 远程部署支持（Remote/Relay）
- ✅ MCP 服务器集成

**这是一个企业级的完整项目管理系统，不仅仅是任务调度工具。**

---

## 工程结构

### 顶层目录

```
vibe-kanban-main/
├── .cargo/              # Rust 配置
├── .github/             # CI/CD workflows
├── assets/              # 资源文件（脚本、音效）
│   ├── scripts/         # PowerShell 脚本
│   └── sounds/          # 提示音效
├── crates/              # Rust 后端模块（376个 .rs 文件）
├── dev_assets_seed/     # 开发数据库种子
├── docs/                # 文档
├── npx-cli/             # NPX CLI 入口
├── packages/            # 前端包
├── scripts/             # 构建脚本
└── shared/              # 共享类型
```

### 后端 Crates（Rust 模块）

```
crates/
├── api-types/           # API 类型定义（issue, user, project, workspace 等）
├── db/                  # 数据库层（SQLite + SQLx）
├── deployment/          # 部署相关
├── executors/           # ⭐ CLI 执行器（Claude、Codex、Gemini、Cursor 等）
├── git/                 # Git 操作
├── git-host/            # Git 托管集成（GitHub, GitLab 等）
├── local-deployment/    # 本地部署
├── mcp/                 # MCP 服务器集成
├── relay-control/       # Relay 控制
├── relay-tunnel/        # Relay 隧道
├── remote/              # 远程服务（云端版本）
├── review/              # 代码审查
├── server/              # HTTP 服务器（路由、中间件）
├── server-info/         # 服务器信息
├── services/            # ⭐ 核心服务（worktree_manager, workspace_manager）
├── trusted-key-auth/    # 认证
└── utils/               # 工具函数
```

### 前端 Packages

```
packages/
├── local-web/           # ⭐ 本地 Web 应用（React）
│   ├── src/
│   │   ├── routes/      # TanStack Router 文件路由
│   │   ├── app/         # 应用入口和布局
│   │   └── ...
│   └── package.json
├── remote-web/          # 远程 Web 应用（云端版本）
├── ui/                  # UI 组件库（共享组件）
├── web-core/            # 共享前端逻辑
└── public/              # 公共资源（logo 等）
```

---

## 关键文件位置

### Worktree 管理

| 文件 | 说明 |
|------|------|
| `crates/services/src/services/worktree_manager.rs` | 主要的 worktree 创建、清理逻辑 |
| `crates/services/src/services/workspace_manager.rs` | workspace 管理，依赖 worktree |

### CLI 执行器

| 文件 | 说明 |
|------|------|
| `crates/executors/src/executors/claude.rs` | Claude Code CLI 执行器 |
| `crates/executors/src/executors/codex.rs` | OpenAI Codex CLI 执行器 |
| `crates/executors/src/executors/gemini.rs` | Google Gemini CLI 执行器 |
| `crates/executors/src/executors/cursor.rs` | Cursor CLI 执行器 |
| `crates/executors/src/executors/copilot.rs` | GitHub Copilot CLI 执行器 |
| `crates/executors/src/executors/mod.rs` | 执行器模块入口 |

### 前端路由

| 文件 | 说明 |
|------|------|
| `packages/local-web/src/routes/_app.tsx` | 主应用布局 |
| `packages/local-web/src/routes/_app.projects.$projectId.tsx` | 项目页面 |
| `packages/local-web/src/routes/_app.projects.$projectId_.issues.$issueId.tsx` | Issue 详情 |

---

## 前端关键依赖

```json
{
  "dependencies": {
    "@tanstack/react-router": "^1.161.1",    // 路由
    "@tanstack/react-query": "^5.85.5",       // 数据请求
    "@dnd-kit/core": "^6.3.1",                // 拖拽
    "@dnd-kit/sortable": "^10.0.0",           // 排序拖拽
    "@xterm/xterm": "^5.5.0",                 // 终端模拟
    "@xterm/addon-fit": "^0.10.0",            // 终端自适应
    "react-use-websocket": "^4.13.0",         // WebSocket
    "zustand": "^4.5.4",                      // 状态管理
    "@radix-ui/react-*": "...",               // UI 组件
    "react-virtuoso": "^4.14.0",              // 虚拟列表
    "@lexical/react": "^0.36.2",              // 富文本编辑
    "@codemirror/*": "...",                   // 代码编辑
    "framer-motion": "^12.23.24"              // 动画
  }
}
```

---

## 规模统计

| 指标 | 数量 |
|------|------|
| Rust 文件 | 376 个 |
| 前端 TSX 文件（local-web） | 22+ 个 |
| Worktree 相关引用 | 35 个 .rs 文件 |
| Crates 模块 | 16 个 |
| 前端 Packages | 5 个 |

---

## 可参考的内容

开发 LocalKanban 时，以下内容值得参考：

### 1. CLI 执行器设计
- `crates/executors/` 下的各个执行器实现
- CLI 进程的启动、输出捕获、交互处理

### 2. 前端组件
- `packages/ui/` 中的共享组件
- `packages/local-web/src/app/` 中的布局设计

### 3. 状态管理
- Zustand 的使用方式
- WebSocket 实时更新

### 4. 终端集成
- xterm.js 的集成方式
- 终端输出渲染

---

## 与 LocalKanban 的对比

| 特性 | vibe-kanban | LocalKanban |
|------|-------------|-------------|
| 后端语言 | Rust | Node.js |
| 数据库 | SQLite | JSON 文件 |
| Worktree | 必须使用 | 不使用（可选） |
| 多用户 | 支持 | 不支持 |
| 远程部署 | 支持 | 不支持 |
| 复杂度 | 企业级 | 轻量级 |
| 目标场景 | 团队协作 | 单人单线程 |
