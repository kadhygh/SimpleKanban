# SimpleKanban

SimpleKanban 是一个面向 **Unity 本地开发流程** 的任务与执行管理器原型。

它的目标不是直接复刻 `vibekanban`，而是保留“网页观察 / 控制 CLI 会话”的核心思想，同时去掉多人协作、远程服务、`worktree` 等当前阶段不需要的前提，优先解决本地开发中的高频执行与验证问题。

## 当前方向

- 本地优先、单机优先。
- 先从 `Project -> TerminalSession -> Executor` 的最小闭环开始。
- v1 核心不是“拉起外部 terminal 窗口”，而是“在网页中提供等价于常规 terminal CLI 的交互能力”。
- 后续再逐步扩展到 `Workspace`、`TaskCard`、无限画布、依赖关系与状态看板。

## 当前 v1 核心目标

- 选择本地工程目录。
- 创建或恢复一个网页托管终端会话。
- 在网页中完成终端输入、输出、交互式 CLI 使用。
- 支持通过执行器模型把命令、参数、文件路径注入终端。
- 为未来一个 `TaskCard` 绑定多个可执行入口保留扩展位。

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

项目当前仍处于方案落地前的文档与架构收敛阶段。

短期内优先推进：

1. 本地服务与网页联通。
2. 网页终端最小闭环。
3. 终端会话恢复与状态可见。
4. 执行器模型与命令注入。

