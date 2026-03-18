# happy 可借鉴点与边界

这份文档用于整理 `happy` 项目里对当前 `v2` 推进真正有价值的部分，并明确哪些内容不值得在当前阶段照搬。

目标不是把 `happy` 当成直接对标物，也不是把 `SimpleKanban` 重新改造成一个远程多端产品，而是提取其中对“多 session、结构化状态回流、CLI 监控与控制层”有帮助的工程思路。

## 1. 先给结论

`happy` 最值得借鉴的，不是它的手机端、加密同步和跨设备接力，而是它围绕本地 CLI 建立的这一层结构：

- 本地 `CLI wrapper / daemon / session` 才是运行真相来源；
- 前端或移动端不直接和 LLM provider 对话，而是和“本地 session”对话；
- provider 的输出会先被适配层归一化，再同步给 UI；
- 会话消息、运行状态、心跳、usage 等不是混在一条终端文本流里，而是分层回流。

这条思路和当前 `v2` 的方向是相容的，因为 `v2` 已经明确把 `Session` 升级为一等对象，并开始引入 `parsed events`。

## 2. 参考前提

本次整理主要基于 `happy` 的公开 README、官网文档和公开源码入口，而不是完整本地 clone。

主要参考：

- `happy` README：<https://raw.githubusercontent.com/slopus/happy/main/README.md>
- `How It Works`：<https://happy.engineering/docs/how-it-works/>
- `Features`：<https://happy.engineering/docs/features/>
- `Real-time Sync`：<https://happy.engineering/docs/features/real-time-sync/>
- `CLI Architecture`：<https://raw.githubusercontent.com/slopus/happy/main/docs/cli-architecture.md>
- `happy-cli src/index.ts`：<https://github.com/slopus/happy/blob/main/packages/happy-cli/src/index.ts>
- `happy-cli src/api/apiSession.ts`：<https://github.com/slopus/happy/blob/main/packages/happy-cli/src/api/apiSession.ts>
- `controlServer.ts`：<https://github.com/slopus/happy/blob/main/packages/happy-cli/src/daemon/controlServer.ts>

## 3. `happy` 的核心方式

先把 `happy` 的方式说准，后面的借鉴点才不会偏。

- `happy` 的核心对象更接近 `session`，不是 `TaskCard`。
- App 侧并不直接调用 Claude / Codex API，而是通过本地 `happy` CLI 和 daemon 去控制本机上的 agent 进程。
- CLI 侧是 source of truth：它负责启动 agent、观察 agent 输出、维护 session 状态，并把结果同步给其他端。
- UI 看到的不是“单纯终端字符流”，而是“终端流 + 结构化消息 + 状态事件 + 心跳 + usage”的组合。

对当前项目来说，真正有价值的不是它的产品外壳，而是这套“执行层和状态层分离”的做法。

## 4. 可借鉴点

### 4.1 把 `Session` 真正当成执行真相来源

`happy` 最值得借的一点，是它没有把“页面上的聊天视图”当成真相来源，而是把本地运行中的 session 当成真相来源。

这意味着：

- UI 只消费 session 已整理好的状态；
- session 负责维护当前 agent 是否还活着、是否正在思考、是否需要人工批准、是否有新消息；
- 即使以后出现多个视图，底层仍然只围绕一套 session 状态模型。

对当前 `v2` 的意义：

- `Session` 既然已经是一等对象，就不应该只是“终端观察窗背后的隐藏连接”；
- `TaskCard` 显示的运行态应该以绑定的 `Session.runtimeStatus` 为准，而不是继续从页面局部状态拼凑；
- `ListWorkspace` 和 `CanvasWorkspace` 后续都应消费同一套 session 真相，而不是各自维护一套推断逻辑。

建议落地方向：

- 继续强化 `Session Registry` 的中心地位；
- 让更多运行态、等待态、错误态、关闭态都由服务端 session 层统一发出；
- 前端只做展示和交互，不再深度参与状态判断。

### 4.2 让 UI 和“session”对话，而不是直接和 provider 对话

`happy` 的 App 侧不是直接给 Claude / Codex 发请求，而是给“某个 session”发消息或发控制命令。

这个分层非常重要，因为它天然隔开了三件事：

- UI 层的输入体验；
- session 层的状态机和消息通道；
- provider 层的具体实现差异。

对当前项目的启发：

- 以后无论是 Codex CLI、Claude Code、还是别的本地 agent，都不应该直接让前端分别对接；
- 前端只需要知道“向某个 session 发送输入”“读取某个 session 的结构化消息”“查看某个 session 的运行状态”；
- provider 差异应该被吸收到服务端执行器或 session adapter 里。

如果后续要做 `TaskCard -> Run` 的进一步抽象，这一层尤其关键，因为：

- `TaskCard` 绑定的是 `Session` 或执行入口；
- `TaskCard` 不该直接理解 Claude/Codex 的细节；
- 未来一个任务可以切换或复用不同执行器，但 UI 层不必被迫感知这些差异。

### 4.3 不只抓原始终端流，而是拆成多类结构化回流

`happy` 明显不是只依赖一条原始 stdout/stderr 文本流。它会把内容拆成不同的同步类型，例如：

- 会话消息；
- 状态更新；
- 心跳；
- usage；
- 其他控制面事件。

这点和当前 `parsed events` 的方向高度一致，而且值得进一步做实。

对当前项目的具体启发：

- 原始终端输出依然保留，供开发者查看；
- `TaskCard`、`ListWorkspace`、`CanvasWorkspace` 优先消费结构化状态，而不是消费原始终端文本；
- `waiting` / `resumed` 只是第一刀，后面还可以继续补：
  - `session.started`
  - `session.closed`
  - `session.error`
  - `session.approval_required`
  - `session.usage_updated`
  - `session.agent_message`

这类拆分的价值在于：

- 监控更稳定；
- UI 逻辑更清晰；
- 后续无论切到多 provider 还是做持久化，都更容易。

### 4.4 增加 provider 适配层，别让前端直接理解 Claude/Codex 差异

`happy` 有一个很值得学的方向：先把不同 provider 的输出归一化，再对外暴露统一 session 协议。

这件事对当前项目的重要性不在“支持更多模型”，而在“避免未来把 provider 细节污染到整个系统”。

如果后续要继续做本地 agent 工作台，一个常见风险是：

- 前端为了尽快跑通，开始写大量 “如果是 Claude 就怎样，如果是 Codex 就怎样”；
- 服务端又在别处再写一遍同样逻辑；
- 最后 `TaskCard`、`Session`、运行态、事件语义都被 provider 差异撕开。

建议的吸收方式：

- 在服务端把“启动进程、读取输出、识别事件、组装结构化消息”的逻辑收敛到 adapter；
- 对外只暴露统一的 session 事件和 session 消息结构；
- 前端不知道当前 session 后面跑的是谁，只知道它是一个可输入、可观察、可等待、可关闭的 session。

这会直接降低后续引入第二种 CLI agent 的成本。

### 4.5 需要一个本地控制面，而不是只靠页面里那一个终端连接

`happy` 的 daemon 和 control server 设计说明了一个现实问题：多 session 系统不能只靠“浏览器当前打开的那个 WebSocket 页面”来维持。

可借鉴的思路不是把它完整抄过来，而是理解它解决的问题：

- session 生命周期需要脱离单页面存在；
- 新建 / 列出 / 关闭 / 重连 session，需要一个稳定的服务端入口；
- 页面刷新、切页、重连之后，不应丢掉本地 session 的基本真相。

这和当前 `v2` 已经做的 `Session Registry` 是同方向的，但后续还可以继续往前走：

- 让 session 生命周期完全由后端统一维护；
- 前端任何视图都只是连接和消费；
- `ListWorkspace`、`CanvasWorkspace`、未来可能的详情页，都从同一个 registry 读数据。

### 4.6 心跳与轻量状态上报值得吸收

`happy` 会显式维护 session 的 keep-alive 和状态上报。这在多端产品里是必需，在本地单机产品里也依然有价值。

对当前项目来说，至少有三类信号值得逐步引入：

- session 是否在线；
- session 是否处于活跃运行中；
- session 是否长时间没有新输出但仍未退出。

这类信号的价值不只是“更炫”，而是能帮助：

- `ListWorkspace` 里更准确地区分 `running`、`idle`、`lost`、`closed`；
- 避免把“暂时没输出”误判成“已经结束”；
- 为将来的 session 恢复和异常提示提供更可靠依据。

### 4.7 消息层和控制层要分开

从 `happy` 的结构看，消息同步和控制操作不是同一种东西。

- 一类是会话消息、终端输出、agent 产生的内容；
- 一类是控制命令，例如创建 session、关闭 session、发送输入、更新元信息。

这对当前项目的意义很直接：

- WebSocket 里不应该把所有事情都混成“终端文本 + 少量字符串命令”；
- 应该明确哪些是 stream，哪些是 event，哪些是 command response；
- 只有这样，后续 `TaskCard` 与 `Session` 的绑定、切换、批量监控才不会越来越乱。

### 4.8 “结构化消息”比“聊天泡泡”更重要

`happy` 的一个隐含优点是：它真正重视的是消息协议，而不是聊天 UI 的表面形态。

这对当前项目是个提醒：

- 先把 session 消息结构建稳，再考虑更复杂的前端呈现；
- 先保证 `TaskCard`、`DocCard`、`Session` 三类对象之间的数据边界清楚，再谈更花的交互；
- `CanvasWorkspace` 也应该消费结构，而不是去反向拼凑终端内容。

如果消息协议没稳，后面无论是列表、画布、详情面板，都会越来越脆弱。

## 5. 对当前 `v2` 的直接落地建议

如果只吸收 `happy` 里真正有用的部分，当前最值得做的不是重做产品形态，而是继续把下面几件事做扎实：

1. 继续扩展 `parsed events`，让 `Session` 输出更多结构化事件，而不是只停在 `waiting/resumed`。
2. 在服务端增加更明确的 session 消息层和控制层边界。
3. 为本地 CLI agent 引入 adapter 层，避免前端直接理解 provider 差异。
4. 让 `ListWorkspace` 和 `CanvasWorkspace` 都依赖同一套 session 真相，而不是各自推断。
5. 让 `TaskCard` 的运行态更彻底地绑定到 `Session`，而不是残留页面局部推断。

这几件事都比去补移动端、加密同步或远程 relay 更贴近 `v2` 的主线。

## 6. 不值得当前阶段照搬的内容

下面这些内容应当明确放在“暂不借鉴”里，不是因为它们不好，而是因为它们解决的是另一类问题。

### 6.1 端到端加密和 relay server

原因：

- `happy` 的这套设计是为了跨设备、跨网络、经第三方 relay 安全同步；
- 当前项目是本地优先、单机优先，并不需要先背上这套复杂度；
- 一旦提前引入，会显著抬高调试成本、状态排查成本和开发门槛。

对当前阶段来说，这属于明显偏离主线的复杂度。

### 6.2 手机 / Web / 桌面多端无缝接力

原因：

- 这是 `happy` 的核心卖点，但不是当前 `v2` 的最小闭环；
- 当前更需要的是把本地多 session、结构化状态和工作台对象模型做稳；
- 如果基础对象模型还没稳，就先做多端，只会把问题放大到更多入口。

换句话说，这不是“先做更完整”，而是“先把战线拉长”。

### 6.3 machine registration、设备在线状态体系

原因：

- `happy` 需要知道哪台设备在线、哪个 agent 跑在哪台机器上；
- 当前项目默认就在同一台机器本地运行，这层抽象大多没有收益；
- 过早引入会让数据模型从 `Project / TaskCard / Session` 被迫扩展成 `Machine / Device / Presence`，很容易把核心问题冲散。

### 6.4 以 session-first 取代当前的 `TaskCard/DocCard/Canvas` 主线

原因：

- `happy` 是 session-first 产品，这与当前 `v2` 的对象模型并不相同；
- 当前项目的价值恰恰在于把 `TaskCard`、`DocCard`、`Session` 分开，再通过 `ListWorkspace` 和 `CanvasWorkspace` 组织起来；
- 如果直接照搬 `happy` 的产品骨架，最后很可能会把当前项目做回“远程终端壳”，而不是“结构化 AI 工作台”。

所以应当借它的执行层和状态层，而不是借它的整个产品中心。

### 6.5 过早引入重型跨端 UI 技术栈

原因：

- `happy` 的 app 需要适配移动端、Web、桌面，技术栈天然更重；
- 当前项目已经有本地 Web 工作台和清晰的最小实现路线；
- 如果此时为了“向 `happy` 靠拢”而重做技术栈，收益非常低，且会直接打断当前里程碑推进。

### 6.6 worktree 管理本身

原因：

- `happy` 官方文档都明确写了它“还不会替你管理 git worktrees”；
- 当前项目文档也已明确把“不做 worktree 管理”列为当前阶段边界；
- 在现阶段把 worktree 拉进来，会把产品焦点从“任务 / 文档 / session 工作台”偏到“分支与目录编排”。

这不意味着以后永远不做，而是当前阶段不应把它当成主线依赖。

## 7. 最后一句

对 `happy` 最正确的借法，不是把它当成产品模板照搬，而是把它当成“本地 agent 执行层如何长得更像一个系统”的参考。

应该借的是：

- `Session` 作为真相来源；
- adapter 化的 provider 接入；
- 结构化消息与结构化状态；
- 独立于前端页面的 session 生命周期维护。

不该借的是：

- 多端同步外壳；
- 加密 relay 基建；
- 设备存在体系；
- 直接把产品中心从 `TaskCard/DocCard/CanvasWorkspace` 改成 `session-first`。
