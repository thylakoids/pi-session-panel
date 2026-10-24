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
- 在输入框第一行行首再按一次 **左方向键** 打开面板
- 面板里再按一次 **左方向键**、`Esc` 或 `q` 关闭

## 配置

`~/.pi/agent/session-panel/config.json`，首次启动自动生成（空文件）。

只写一行模型 id 就行：

```
glm-5.3-flash
```

也可以写成 JSON，两种都认：

```json
{ "titleModel": "glm-5.3-flash" }
```

**留空就不起名** —— 插件不带默认值，用哪个模型由你决定。

模型 id 不需要写 provider 前缀：同名模型存在于多个 provider 时，优先用你当前会话的 provider，其次用 `settings.json` 里的 `defaultProvider`。真的无法判断时会提示你该写哪个。

起名规则：会话没有名字、且已经有 user 消息时，生成一个短标题写进 `session_info`。有名字就不再改。

## 三个分区

| 分区 | 来源 | X 键的含义 |
|---|---|---|
| Working | 注册表里 `state: "working"` 的进程 | 打断当前运行（向 tmux pane 发 Esc） |
| Idle | 注册表里 `state: "idle"` 的进程 | 优雅退出（SIGTERM），立刻落入 Closed |
| Closed | `SessionManager.listAll()`，与 `pi -r` 同源 | 删除磁盘上的会话文件（需确认） |

## 按键

| 键 | 动作 |
|---|---|
| `j` / `k` | 上下移动 |
| `gg` / `G` | 跳到第一行 / 最后一行 |
| `Enter` | Working、Idle：跳到那个 tmux pane；Closed：恢复到 tmux session `pi-sessions` 的新窗口 |
| `X` | 见上表 |
| `r` | 改名（写入 `session_info`，与 `pi -r` 共享） |
| `/` | 搜索（与 `pi -r` 同一套：模糊词、`"短语"`、`re:正则`） |
| `R` | 重新扫描 closed 分区 |
| `q` / `Esc` / `←` | 关闭面板 |

## 它看不见什么

只认注册表，没有任何兜底扫描。装了本包、但**早于安装就开着**的 pi 不会出现，要等它 `/reload` 或重启。这是刻意的，见 ADR 0001。

## 渲染开销

spinner 每 200ms 才换一帧，面板只在那一刻重绘，其余 tick 由缓存直接返回。

| | 成本 |
|---|---|
| 缓存命中 | 7 µs |
| 完整重建（1165 条 closed） | 0.75 ms |
| 重绘频率 | 每 200 ms 一次 |

## 开发

```bash
npm test
```

9 个测试，每一个都用「先埋 bug、确认测试变红」验证过，没有装饰性的测试。

## 文档

- [GLOSSARY.md](./GLOSSARY.md) — Session、Registry、Working、Idle、Closed、Unregistered
- [docs/adr/0001](./docs/adr/0001-self-reported-registry-only.md) — 只认自报注册表，不做兜底
- [docs/adr/0002](./docs/adr/0002-x-key-is-three-actions.md) — X 在三个分区里是三个动作
- [docs/adr/0003](./docs/adr/0003-closed-index-in-memory.md) — closed 索引在内存里
- [docs/adr/0004](./docs/adr/0004-left-arrow-gesture-editor.md) — 左方向键手势与全局编辑器替换
- [docs/adr/0005](./docs/adr/0005-animation-costs-only-when-the-glyph-steps.md) — 动画只在字形真正变化时付出代价
- [docs/adr/0006](./docs/adr/0006-reopen-in-a-fixed-tmux-session.md) — 恢复会话放进固定名字的 tmux session
- [docs/adr/0007](./docs/adr/0007-session-naming.md) — 自动起名：一个检查，两个触发点
