# pi-session-panel

一个统一页面，用来管理这台机器上所有正在运行和历史 pi 会话。

## 安装

```bash
pi install git:github.com/thylakoids/pi-session-panel
```

装上之后每次开 pi 都自动加载，不需要任何参数。

**本机开发时**装本地路径更省事，改完代码下次开 pi 就生效：

```bash
pi install ~/Agent/pi-session-panel
```

## 跑起来

- `/sessions` 打开面板
- 输入框完全为空时按 **左方向键** 打开面板；有草稿、补全或粘贴时保留编辑行为
- 面板里再按一次 **左方向键**、`Esc` 或 `q` 关闭

## 配置

`~/.pi/agent/session-panel/config.json`，首次启动自动生成 `{}\n`。

```json
{
  "titleModel": "your-provider/your-model"
}
```

必须写全 `provider/model`。model id 本身可能带斜杠，所以只按第一个斜杠切分 provider。

**留空就不起名** —— 插件不带默认值，用哪个模型由你决定。

起名规则：会话没有名字、且 user 消息累计至少有 3 个信息单位时（每个汉字/假名/谚文音节或每段英文单词/数字算 1 个，标点不算），生成一个短标题写进 `session_info`。有名字就不再改；请求等待期间由其他面板设置的名字也优先保留。修改 `titleModel` 后，自动命名和手动生成都在下次请求读取新配置，无需重启。自动请求返回时也会复查配置；等待期间关闭或更换模型，旧请求的结果不再写入。

手动重新生成：在面板里选中会话，按 `r` 进入 Rename，再按 `Ctrl+G` 调用同一个 `titleModel`、命名提示词和模型接口。它读取选中会话当前分支的全部 user prompt（不含助手和工具输出），拼接后若超过 16,000 字符，保留开头任务与最近内容、省略中间部分并注明省略字数。生成结果只填入编辑框，可以继续修改，按 Enter 才保存；生成期间按 Esc 取消。未配置模型或调用失败时显示错误，不覆盖原名和手动草稿。

自动命名读取分支上每一条真人 user 消息及尚未入分支的当前 prompt，拼接后在 1000 字符内保留开头任务与最近内容（可用正文预算约 40% / 60%），省略中间并标注。手动生成使用同一截断规则和更大的 16,000 字符预算。沿用 Claude Code 2.1.304 的标题规则与 `<session>` 包装，语言指令写在 user turn。细节见 [ADR 0008](./docs/adr/0008-title-context-follows-claude-code.md)。

命名请求在本地最长等待 30 秒，最多生成 512 token；超时、损坏的 JSON、无效标题字段和截断输出都按失败处理，自动命名可在下次用户输入时重试。兼容纯文本标题，保存前移除终端控制序列和方向覆盖字符，并按 Unicode 码点限制到 60 字符。手动生成的失败保留草稿，Esc 可随时取消。

切换、fork、树导航开始时取消旧的自动命名请求，退出或 reload 时也会取消；即使 provider 忽略取消，迟到结果也不会写入或重新登记已关闭的会话。新会话启动、树导航完成后按当前分支重新检查是否需要起名。如果导航被其他扩展取消，下次用户输入仍可重试。

## 三个分区

| 分区 | 来源 | x 键的含义 |
|---|---|---|
| Working | 注册表里 `state: "working"` 的进程 | 打断当前运行（向 tmux pane 发 Esc） |
| Idle | 注册表里 `state: "idle"` 的进程 | 目标核对实例凭据、会话和 Idle 状态后自行优雅退出 |
| Closed | `SessionManager.listAll()`，与 `pi -r` 同源 | 删除磁盘上的会话文件（需确认） |

Idle 退出支持 macOS 和 Linux：更新后的目标 Pi 登记私有本地 socket 和每次加载独有的凭据，面板发送退出请求，目标在同一次回调中检查当前会话及 Idle 状态，再调用 Pi 的 `shutdown()`。PID 被复用、旧行、已开始 Working、会话变化或通道失联时拒绝；通道失败不会退回按 PID 强制退出。请求最多等 2 秒。

升级后，**面板宿主和每个需要退出的目标 Pi 都要在空闲时 `/reload` 或重启**，再重新打开 `/sessions`。仅重载面板宿主不能替旧目标登记通道。旧 Linux 记录仍可使用原有 boot ID + 启动 tick 校验路径；没有可验证登记的旧记录提示重载目标，不能自动补造身份。详见 [ADR 0013](./docs/adr/0013-verify-process-identity-before-exit.md)。

## 显示名

当前所在会话使用固定的整行背景色（Pi 的 `customMessageBg`）和加粗名称，不随光标移动。打开面板时默认定位到当前会话；`❯` 表示键盘正在操作的行，选中其他会话使用 `selectedBg`，与当前会话背景区分。不添加文字标签。

会话没有名字时，回退到 `pi -r` 用的那个名字：有 name 用 name，否则取首条 user 消息。两样都没有（刚开、还没说话）就显示 `(new session)`，不用所在目录的名字冒充。

## 按键

| 键 | 动作 |
|---|---|
| `j` / `k`、`↑` / `↓` | 上下移动。搜索中方向键选结果，`j` / `k` 是输入字符 |
| `Home` / `End`、`gg` / `G` | 跳到第一行 / 最后一行；输入框中 `Home` / `End` 移动文字光标 |
| `Page Up` / `Page Down` | 列表和搜索结果按可见高度翻页 |
| `Enter` / `→`（列表中） | Working、Idle：切换客户端到目标 pane（支持跨 tmux session）；Closed：恢复到 tmux session `pi-sessions` 的新窗口 |
| `x` | 见上表；Closed 的删除仍需确认 |
| `r` | 改名。`←` `→` `Home` `End` 移动光标，`Enter` 保存，`Esc` 取消 |
| `Ctrl+G`（Rename 中） | 用自动命名配置的模型生成新草稿；再次按 Enter 才保存 |
| `/` | 搜索（与 `pi -r` 同一套：模糊词、`"短语"`、`re:正则`）。`↑` `↓` 选结果，`Enter` 直接打开，`Esc` 清空；无结果或打开失败时保持可编辑 |
| `?` | 显示当前可用操作；内容过长时 `↑` / `↓`、`j` / `k` 滚动，其他键关闭 |
| `R` | 重新扫描 closed 分区 |
| `q` / `Esc` | 关闭面板；有过滤条件时，`Esc` 先清空过滤 |
| `←`（仅在列表里） | 关闭面板。在搜索或改名框里它是光标左移，不会关面板 |

底部优先显示关闭、帮助和打开等主要操作，并按宽度省略完整提示。`?` 显示全部按键，其中 `x` 的说明随选中会话显示打断、退出或删除。

标题和状态图标使用中性色，Working、Idle 通过分区和图标区分；Closed 标题使用柔和的灰色，选中后恢复正常文字对比度并整行高亮。边框保持低调，警告、错误和删除确认保留强调色。窗口变窄时依次隐藏目录、时间，优先保留标题。上下还有内容时显示滚动箭头，后台刷新保留同组行序、选择和输入状态。

搜索和改名使用 pi-tui 原生输入框，支持粘贴、撤销和按单词编辑。动作执行期间显示进行状态，避免连续按键重复打开或提交。

按键执行、`?` 帮助和底部提示共用 `extension/panel.ts` 的 `commands()` 注册表。每个操作定义按键、说明和执行函数；新增操作后帮助自动包含它，同一操作的多个按键显示在同一行。

## 它看不见什么

只认注册表，没有任何兜底扫描。装了本包、但**早于安装就开着**的 pi 不会出现，要等它 `/reload` 或重启。这是刻意的，见 ADR 0001。

## 渲染开销

spinner 每 200ms 才换一帧，面板只在那一刻重绘，其余 tick 由缓存直接返回。

| | 成本 |
|---|---|
| 缓存命中 | 7 µs |
| 完整重建（186 条 closed） | 0.75 ms |
| 重绘频率 | spinner 每 200 ms 一步 |
| closed 冷扫描 | ~1.5 s（仅首次，之后读缓存） |
| closed 增量扫描 | ~11 ms |

## 开发

```bash
npm test
```

运行测试覆盖列表、搜索、改名、删除确认和会话动作。

真实退出端到端测试（默认跳过，不调用模型）：

```bash
PI_PANEL_EXIT_LIVE=1 node --test --experimental-strip-types test/exit-live.test.ts
```

使用已安装的 Pi 与独立 tmux socket，在临时设置、registry 和会话里验证真实 `/sessions` 的 Idle `x`、目标正常退出、真实 `/reload` 和旧凭据拒绝。忙状态由真实运行停在首个 provider 请求前构造，验证退出拒绝后先 abort，再正常退出；不测试模型流式响应中的退出，也不接触现有会话。结果和终端文本保存在输出的 `/tmp/pi-panel-exit-live-*` 目录；可用 `PI_TEST_PI` 指定 Pi 可执行文件。

真实模型检查（会产生一次命名调用，默认测试跳过）：

```bash
PI_PANEL_NAMING_LIVE=1 node --test test/rename-live.test.ts
```

使用官方 Pi 和已配置的 `titleModel`；可用 `PI_TEST_PI` 指定 Pi 路径，`PI_TEST_TITLE_MODEL=provider/model` 显式指定测试模型。测试只创建临时 Pi 会话，验证真实返回值先进入 Rename 草稿、Enter 后才写入，保留临时目录中的结果供检查。

## 文档

- [GLOSSARY.md](./GLOSSARY.md) — Session、Registry、Working、Idle、Closed、Unregistered
- [docs/adr/0001](./docs/adr/0001-self-reported-registry-only.md) — 只认自报注册表，不做兜底
- [docs/adr/0002](./docs/adr/0002-x-key-is-three-actions.md) — 状态动作键在三个分区里的含义
- [docs/adr/0003](./docs/adr/0003-closed-index-in-memory.md) — closed 索引在内存里
- [docs/adr/0004](./docs/adr/0004-left-arrow-gesture-editor.md) — 左方向键手势与全局编辑器替换
- [docs/adr/0005](./docs/adr/0005-animation-costs-only-when-the-glyph-steps.md) — 动画只在字形真正变化时付出代价
- [docs/adr/0006](./docs/adr/0006-reopen-in-a-fixed-tmux-session.md) — 恢复会话放进固定名字的 tmux session
- [docs/adr/0007](./docs/adr/0007-session-naming.md) — 自动起名：一个检查，两个触发点
- [docs/adr/0008](./docs/adr/0008-title-context-follows-claude-code.md) — 起名的 context 对齐 Claude Code
- [docs/adr/0009](./docs/adr/0009-one-spinner-clock.md) — 所有 working 行共用一个 spinner 时钟
- [docs/adr/0010](./docs/adr/0010-closed-hides-subagent-sessions.md) — closed 不显示 subagent 会话
- [docs/adr/0011](./docs/adr/0011-closed-index-cached-on-disk.md) — closed 索引缓存到磁盘
- [docs/adr/0012](./docs/adr/0012-frame-key-covers-every-visible-state.md) — 每一帧先算完整再取 key
