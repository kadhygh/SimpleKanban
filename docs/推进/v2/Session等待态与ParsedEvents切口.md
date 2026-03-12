# Session 等待态与 Parsed Events 切口

最后更新：2026-03-12

## 1. 这份文档解决什么问题

`M8.1` 当前已经完成“多 Session 最小闭环”，但有一个明显脆弱点：

- `waiting` / `input required` 的判断目前仍以启发式关键词和正则为主。

这次你本人验证时，`Read-Host "Need input"` 一开始没有被识别出来，说明当前方案虽然可用，但还不够稳。

因此，这份文档的目的不是推翻 `M8.1`，而是明确：

1. 是否值得参考 `vibekanban` 的 CLI 处理思路；
2. 如果参考，应该参考到哪一层；
3. 下一刀应如何小步引入 `parsed events`。

## 2. 当前结论

结论：值得参考，但不照搬。

当前最值得借的是这一点：

- 把 **原始 PTY 数据流** 和 **解析后的状态事件** 分成两条通道。

也就是：

- 一条通道继续把原始终端输出完整送给 xterm；
- 另一条通道只负责产出结构化事件，例如：
  - `session.waiting`
  - `session.running`
  - `session.exited`
  - `session.error`
  - `session.prompt`

这比“只有一条原始字符串流，再由任务层顺手猜状态”更稳。

## 3. 为什么要这样做

### 3.1 当前方案的问题

当前等待态检测散落在服务端会话输出处理里，特点是：

- 实现快；
- 改一个词就能补一个 case；
- 对最小闭环足够。

但问题也很明显：

- 容易漏掉新的提示词；
- CLI / shell / 脚本一换，规则就会失灵；
- `waiting`、`confirm`、`password`、`permission` 这些语义混在一起，不够结构化；
- 后续 `ListWorkspace` 做稳定监控时，事件来源会不够可信。

### 3.2 `vibekanban` 值得借的点

`docs/rescource/vibe-kanban-cli-analysis.md` 里最值得借的不是某个具体 executor，而是这种思路：

- PTY 原始数据继续保留；
- 同时产出 parsed state/event；
- 前端既能看原始终端，也能看结构化状态。

这和我们现在的需求是对齐的。

## 4. 当前不建议做什么

当前不建议为了这个切口直接做下面这些重活：

- 不重写整套终端协议；
- 不引入完整的 JSON Patch 状态系统；
- 不为了某个特定 LLM CLI 先绑定一整套专属协议；
- 不把所有 shell 输出都强行结构化；
- 不在这一刀就做完整终端历史仓库。

原因很简单：

- 这些都超出当前最小问题范围；
- 当前真正要补的是“状态事件层”，不是“完整终端平台重构”。

## 5. 建议的最小实现

建议下一刀只做一个很轻的 `parsed events` 层。

### 5.1 服务端新增一个解析层

在 `Session Registry` 输出回流处增加一个轻量解析器，例如：

- 输入：单条 PTY 输出片段
- 输出：零个或多个结构化事件

事件形态先控制在最小集合：

- `session.waiting`
- `session.resumed`
- `session.exited`
- `session.error`

### 5.2 原始输出和状态事件并行存在

不要替换现有输出流，而是并存：

- `output`: 原始终端文本
- `parsed_event`: 结构化状态事件

这样可以保持：

- xterm 继续完整显示原始输出；
- `TaskCard` / `ListWorkspace` 只消费结构化状态。

### 5.3 第一版解析规则先做启发式封装

即使第一版仍然是关键词 / 正则，也要把它从业务逻辑里抽出来，变成独立解析层。

这样做的价值是：

- 后续规则可单独迭代；
- 后续如果某个 CLI 支持更明确的 machine-readable 输出，也能直接接进这个层；
- 不需要改一堆任务同步逻辑。

## 6. 推荐的推进顺序

建议按这个顺序推进：

1. 抽出 `session-output-parser` 一类的轻量模块；
2. 把当前 `waiting` 检测从 `server.mjs` 内联逻辑迁进去；
3. 给 websocket 增加 `parsed_event` 消息；
4. 让 `TaskCard` / `ListWorkspace` 优先消费 `parsed_event`；
5. 最后再决定是否为某些特定 CLI 增加更强的专属解析。

## 7. 通过标准

这条切口的通过标准应是：

- `waiting` 检测逻辑不再散落在任务同步逻辑里；
- 原始终端输出仍完整可见；
- 结构化状态事件可以单独被前端消费；
- 后续增加新规则时，不需要再碰终端主链路。

## 8. 一句话结论

参考 `vibekanban` 是对的，但当前应该参考的是：

- **双通道思路**

而不是：

- **整套实现照搬**

下一刀最合理的做法是：

- 先把 `waiting` / `input required` 抽成一个轻量 `parsed events` 层，
- 再让它服务 `M8.2 ListWorkspace` 的稳定监控。
