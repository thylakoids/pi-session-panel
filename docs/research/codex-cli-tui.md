# Codex CLI TUI 交互调研

调研日期：2026-10-25。目标是找出适合 pi-session-panel 的简单、自然的交互。

## 证据范围

- 本机版本：`codex-cli 0.164.0-alpha.11.1`，由 ChatGPT.app 随附。
- 实际打开 `codex agents --no-alt-screen`，查看了任务列表、整行选择高亮、状态与项目分组、滚动提示和 `?` 帮助；未打开、停止或删除任何任务，检查结束后退出浏览器。
- 源码参考：OpenAI `openai/codex` 的提交 `970111f6cb62cc02fe36a82ea7d71b37a2889c97`，提交时间 2026-10-23。公开源码不等于本机 alpha 的精确构建；以下触发条件与颜色算法来自源码检查。
- 本次 PTY 的输出可以确认整行反色选择，但未呈现足以核验主题 RGB 的彩色输出；具体颜色规则以源码为依据。
- 本机二进制身份由 REA `inspect_macho` 确认，Evidence ID：`ev_e560fc1c3e5ea1e3b4c59cd825e6246bff08b4557a0310fbdc03aeeb86fd68df`。该证据仅用于身份、架构与摘要，不证明 UI 行为。
- [官方 Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)说明 `/subagents` 可以切换 agent 线程。`codex agents` 的全局任务中心与这个子 agent 选择器是不同入口。

## 已确认的设计

### 1. 左方向键只在空输入框中打开任务中心

源码同时检查：功能可用、编辑键位仍将左键定义为左移、输入框有焦点且可输入、草稿完全为空、没有粘贴或弹窗、没有待完成的 Vim 操作。只接受首次 Press，不接受长按 Repeat 或 Release。

这比我们当前“第一行行首按左键打开”的条件更保守：有文字时在行首继续按左键，应该维持编辑状态。

参考：[触发逻辑](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/bottom_pane/chat_composer/agents_navigation.rs)、[对应测试](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/bottom_pane/chat_composer/agents_navigation_tests.rs)。

### 2. 颜色分别表达身份、状态和选择

| 含义 | Codex 的做法 | 适合我们的做法 |
|---|---|---|
| 会话身份 | 从当前语法主题收集强调色，对完整 thread ID 做 FNV-1a 哈希选色；重名、改名和排序不改变映射，允许撞色 | 用稳定会话文件或会话 ID 选主题颜色，不按标题、行号或 PID 选色 |
| 运行状态 | Working 绿实心点，Ready 青空心点，Inactive 暗空心点，Needs input 红实心点，Error 红叹号 | 当前三种状态先用图标与主题色区分，保留文字分区；Needs input 需要真实事件来源再添加 |
| 当前选择 | 整行采用统一选择样式，覆盖身份色和状态色；源码测试中的选中样式为加粗反色 | 使用 pi 主题的 `selectedBg` 或统一反色，并保留箭头，让选择在单色终端也清晰 |

配色随主题变化，不能靠颜色单独传达状态。本机 pi 主题已有 `selectedBg`、`success`、`warning`、`error` 等语义 token，可直接使用。

我们的 live 行 key 是 `live:PID`，恢复会话会换 PID。若希望恢复前后身份色不变，优先取 live 和 closed 都有的 `sessionFile`；文件缺失时再退回会话 ID 或行 key。

参考：[身份颜色算法](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/thread_color.rs)、[状态定义](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/app/agents_overview_view.rs#L428)、[行样式和响应式列](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/app/agent_center/rows.rs)。

### 3. 列表中的右键可以打开，输入框中仍然编辑文字

公开源码测试验证 `→` 能打开当前高亮任务；在搜索和改名等编辑状态下不能偷走文字编辑的方向键。

我们已有 `←` 返回，可增加列表里的 `→/Enter` 打开，形成一致的空间关系。该建议不表示本次在运行中的任务上测试了打开操作。

参考：[打开和编辑状态的测试](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/app/agents_overview_tests.rs)。

### 4. 窄窗口先保留任务标题

Codex 任务行在宽度不足 56 列时隐藏状态和时间两列；较宽窗口可显示详情区。滚动区域有 `↑`、`↓` 提示，说明上下还有内容。分页使用包含分组标题和间隔的实际屏幕行布局。

我们目前一直为目录和时间预留空间，窄窗口的标题会过早截断。可先隐藏次要列，再截断标题；分页也应计入分组标题，避免跨分区时移动距离与屏幕高度不一致。

参考：[列布局与滚动提示](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/app/agent_center/rows.rs)、[分页逻辑](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/app/agent_center/navigation.rs)。

### 5. 刷新时保留用户正在做的事

Codex 同一状态组里的任务保持原有相对顺序；搜索、改名、滚动和选择保存在独立视图状态中，后台元数据刷新不会直接重建成默认界面。

我们的选中项已经按 key 保留；后续可明确保证同组顺序稳定，并测试“后台刷新时继续输入、选中项改状态、改名目标消失”等场景。

参考：[视图状态和排序](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/app/agents_overview_view.rs)。

### 6. 底部只显示主要操作

实际运行中，列表底部仅显示帮助、返回、移动、打开和新建；完整帮助才列出其他动作。帮助读取配置后的绑定，并按 Navigate、Tasks、View 分组。

我们已有动作注册表，应保留这个方向：底部优先保证打开、返回和帮助可见，完整帮助显示全部别名。同一操作的方向键、字母键、Tab 不必在底部全部展开。

参考：[帮助与底部提示](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/tui/src/app/agent_center/hints.rs)。

### 7. 危险程度不同的操作有独立入口

Codex 将 Stop、Archive、Hide、Delete 分开。我们目前的 `X` 会随状态变为打断、退出或删除；后台状态变化和连续按键可能使用户正在重复的操作变得更危险，尽管磁盘删除还有确认。

后续设计应明确区分删除与停止，至少避免长按同一键随着状态变化连续升级动作。具体键位需要与现有 ADR 0002 一并修订。

## 建议实施顺序

1. 收紧左键打开条件；列表增加右键打开；底部优先显示主要操作。
2. 整行选择高亮、独立状态图标色、稳定身份色；复用 pi 主题，保留单色可读性。
3. 窄窗口隐藏次要列，增加滚动提示，按实际屏幕行分页。
4. 评估删除独立键位，并验证实时刷新与长按输入。

状态筛选 Tab、固定任务、多种分组和宽屏详情区可等会话数量确实需要时再引入，避免现在增加操作模式。本次仅做调研，未修改产品交互。
