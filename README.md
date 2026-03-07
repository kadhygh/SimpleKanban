# SimpleKanban

SimpleKanban 是一个面向 **Unity 本地开发流程** 的任务与执行管理器原型。

它的目标不是直接复刻 `vibekanban`，而是保留“网页观察 / 控制 CLI 会话”的核心思想，同时去掉多人协作、远程服务、`worktree` 等当前阶段不需要的前提，优先解决本地开发中的高频执行与验证问题。

## 当前方向

- 本地优先、单机优先。
- 先从 `Project -> TerminalSession -> Executor` 的最小闭环开始。
- v1 核心不是“拉起外部 terminal 窗口”，而是“在网页中提供等价于常规 terminal CLI 的交互能力”。
- 后续再逐步扩展到 `Workspace`、`TaskCard`、无限画布、依赖关系与状态看板。

## 当前 M1 已实现内容

- 本地 Node 服务可启动。
- 网页可直接通过同一服务访问。
- 已提供当前项目读取接口：`GET /api/project/current`。
- 已提供项目选择接口：`POST /api/project/select`。
- 已支持将所选项目路径保存到本地状态文件。
- 页面可展示当前项目路径与基础服务状态。

## 当前 v1 核心目标

- 选择本地工程目录。
- 创建或恢复一个网页托管终端会话。
- 在网页中完成终端输入、输出、交互式 CLI 使用。
- 支持通过执行器模型把命令、参数、文件路径注入终端。
- 为未来一个 `TaskCard` 绑定多个可执行入口保留扩展位。

## 快速开始

1. 安装 Node.js 24+。
2. 在项目根目录运行：`npm run dev`
3. 打开：`http://127.0.0.1:3210`
4. 点击“选择工程”完成项目绑定。

> 当前 M1 使用零依赖本地服务骨架来尽快打通链路；后续在进入网页终端阶段时，再逐步升级到 `xterm.js + WebSocket + node-pty`。

## 文档入口

- 总体准备文档：`prepare.md`
- 全局推进看板：`docs/dashboard.md`
- v1 推进目录：`docs/推进/v1/README.md`
- v1 清单：`docs/推进/v1/清单.md`

## 参考资料

`docs/rescource` 中包含对 `vibekanban` CLI 部分逻辑的 review 和总结，可作为参考材料：

- `docs/rescource/vibe-kanban-cli-analysis.md`
- `docs/rescource/vibekanban项目分析.md`

这些内容用于帮助理解既有方案，但不是当前实现的强依赖；如果有更简单、可控的实现方式，优先采用更适合本项目的方案。

## 当前阶段结论

项目当前已经完成 `M1` 的最小可运行骨架。

短期内优先推进：

1. 网页终端最小闭环。
2. 终端会话恢复与状态可见。
3. 执行器模型与命令注入。
4. 再向 `TaskCard` 绑定关系过渡。
