# SimpleKanban

SimpleKanban 是一个面向 **Unity 本地开发流程** 的任务与执行管理器原型。

它的目标不是直接复刻 `vibekanban`，而是保留“网页观察 / 控制 CLI 会话”的核心思想，同时去掉多人协作、远程服务、`worktree` 等当前阶段不需要的前提，优先解决本地开发中的高频执行与验证问题。

## 当前方向

- 本地优先、单机优先。
- 先从 `Project -> TerminalSession -> Executor` 的最小闭环开始。
- v1 核心不是“拉起外部 terminal 窗口”，而是“在网页中提供等价于常规 terminal CLI 的交互能力”。
- 后续再逐步扩展到 `Workspace`、`TaskCard`、无限画布、依赖关系与状态看板。

## 当前已实现内容（v1 当前节点）

- 本地 Node 服务、项目选择与状态持久化。
- 网页托管终端最小闭环，以及页面刷新后的会话恢复。
- 执行器模型、命令预览与终端注入。
- `TaskCard -> Run -> Terminal -> 状态回流` 最小闭环。
- 依赖关系结构视图（选中高亮、focus-only 子图、环依赖提示）。
- Canvas 节点投影，以及工作台 <-> canvas 基于 `?task=` 的双向定位。

## 当前 v1 核心目标

- 选择本地工程目录。
- 创建或恢复一个网页托管终端会话。
- 在网页中完成终端输入、输出、交互式 CLI 使用。
- 支持通过执行器模型把命令、参数、文件路径注入终端。
- 为未来一个 `TaskCard` 绑定多个可执行入口保留扩展位。

## 快速开始

1. 安装 Node.js 24+。
2. 首次拉起前先在项目根目录运行：`npm install`
3. 然后运行：`npm run dev`
4. 打开：`http://127.0.0.1:3210`
5. 点击“选择工程”完成项目绑定。

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

项目当前已经完成 `M1` 到 `M7.2` 的当前节点，并且 `M7.2` 的工作台 <-> canvas 双向定位已由用户本人验证通过。

短期内优先推进：

1. 进入 `M7.3`，决定结构视图是继续保留，还是开始逐步被 canvas 吸收。
2. 收拢结构视图、TaskCard 和 canvas 之间的焦点与详情语义。
3. 在主界面方向稳定后，再决定 `M7.4` 的详情布局与页面表现重构。
