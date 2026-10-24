# closed 不显示 subagent 会话

closed 分区只列「用户开过的会话」。pi 的 subagent（`pi-interactive-subagents` 派生的子会话）不列。

## 怎么认出来的

看会话文件旁边有没有 sidecar：

| 文件 | 谁写的 |
|---|---|
| `<session>.jsonl.loadout.json` | pi-interactive-subagents 每次 spawn pi 子进程时写 |
| `<session>.jsonl.cli.json` | 同上，外挂 claude / codex CLI 时写 |

两个都是「这个文件是被 spawn 出来的」的确切标记，而且只有它写。

## Considered Options

- **看 header 的 `parentSession`**：被否决。本机 1794 个 subagent 文件里只有 1303 个带这个字段，会漏掉 491 个；而它还会命中普通的 fork（`pi --fork` 分叉出来的会话），那些是用户自己开的，必须留。
- **看 cwd 是不是临时目录**：被否决。用户完全可以在 `/tmp` 里开会话，判据不成立。
- **看首条 user 消息是不是 `<file name=...>`**：被否决。那是 subagent 的 task 包装格式，属于另一个包的内部实现细节，比 sidecar 更容易随版本变化。

## Consequences

本机 1979 个会话文件里有 1794 个是 subagent，过滤掉之后 closed 只剩 186 行。扫描量也随之下降一个数量级——这些文件根本不会被读取。

代价是判据耦合了另一个包的文件命名。sidecar 一旦改名，closed 会重新开始显示 subagent；但它不会隐藏真实会话——最坏情况只是多显示，不会少显示。
