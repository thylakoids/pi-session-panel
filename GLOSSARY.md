# pi-session-panel

一个统一页面，用来管理这台机器上所有正在运行和历史 pi 会话。

## Language

**Session**:
一个 pi 会话，由磁盘上的一个 JSONL 文件表示。同一个词既指活着的进程也指已关闭的文件，靠状态区分。
_Avoid_: 会话窗口、instance、agent

**Registry**:
本包在 `~/.pi/agent/session-panel/registry/` 下维护的自报目录。每个活着的 pi 在其中写一条记录。
_Avoid_: 注册中心、数据库、索引

**Working**:
Session 状态之一：pi 进程存活，且正在执行一次运行。
_Avoid_: running、busy、active

**Idle**:
Session 状态之一：pi 进程存活，但没有在执行的运行。
_Avoid_: stopped、waiting、空闲

**Closed**:
Session 状态之一：没有对应进程，只剩磁盘上的 JSONL 文件。来源是 `SessionManager.listAll()`，与 `pi -r` 同源。
_Avoid_: dead、ended、archived

**Unregistered**:
一个没有写 Registry 的 pi。本包完全看不见它，视同不存在。
_Avoid_: 未注册、missing

**Session name**:
Session 的显示名，存于 JSONL 的 `session_info` 条目。显示规则与 `pi -r` 一致：有 name 显示 name，否则显示首条 user message，空会话显示 `(no messages)`。
_Avoid_: title、label、AI 标题
