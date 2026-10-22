# X 键在三个分区里是三个不同动作

同一个键 `X` 按所在分区改变含义：

| 分区 | 动作 | 机制 | 确认 |
|---|---|---|---|
| Working | 打断当前运行 | tmux `send-keys -t <pane> Escape` | 否 |
| Idle | 优雅退出 | `SIGTERM` | 否 |
| Closed | 删除磁盘文件 | 删 JSONL | 是 |

## Considered Options

- 统一成一个"kill"动作：被否决。Working 状态需要的是中止这一次运行而不是杀掉进程，SIGTERM 做不到这件事。
- 用控制文件让被管的 pi 自己 poll 到就 abort：被否决，tmux send-keys 是字面上的"在输入框按一次 Esc"，行为与手动操作完全一致。

## Consequences

Working 分区里的 Session 如果不在 tmux 里，就没有 pane 可发 Esc，打断动作置灰。Idle 的退出用 SIGTERM，不保证会话文件干净收尾。
