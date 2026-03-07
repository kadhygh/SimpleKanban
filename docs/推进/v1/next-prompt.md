# 下一次对话提示词

这个文件用于在开启新对话时，快速把上下文交给新的助手实例。

## 推荐提示词

```text
继续推进 SimpleKanban 的 v1 / M2。

请先阅读以下文件，再继续实现：
1. `docs/推进/v1/交接.md`
2. `docs/推进/v1/清单.md`
3. `prepare.md`
4. `docs/dashboard.md`

当前状态：
- M1 已完成。
- 已经有本地 Node 服务、项目选择接口和基础页面。
- 当前代码已经能读取/保存当前项目路径，并在页面展示。
- 当前还没有进入网页终端阶段。

当前代码位置：
- `source/server/server.mjs`
- `source/server/lib/project-store.mjs`
- `source/server/lib/folder-dialog.mjs`
- `source/web/index.html`
- `source/web/app.js`
- `source/web/styles.css`

接下来请直接推进 M2：网页终端最小闭环。

M2 目标：
- 接入 `xterm.js`
- 接入 `node-pty`
- 打通终端输出到前端
- 打通前端输入写回 PTY
- 支持终端 resize
- 设计最小 `TerminalSession` 状态模型

实现约束：
- 继续保持单机、单项目、单活跃终端
- 不要提前引入 TaskCard 业务逻辑
- 不要提前引入账号、多人协作、远程服务、worktree
- 外部 terminal 不是当前主路径，优先网页托管终端
- `docs/rescource` 里的 vibekanban 分析可以参考，但不必照搬

请先给出一个简短计划，然后直接开始实现。
```

## 使用建议

- 如果下一次对话的目标仍然是继续开发，直接复制上面的提示词即可。
- 如果下一次对话只想讨论方案，也建议先让助手阅读 `docs/推进/v1/交接.md`。
- 如果后续进入 `M3` 或更后面的阶段，可以在这个文件基础上继续更新提示词。
