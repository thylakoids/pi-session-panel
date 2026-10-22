# 恢复会话开新窗口，不替换当前会话

对 Closed 行按 Enter 时，在一个新的 tmux 窗口里用 `pi --session <file>` 重新打开它，cwd 设为该会话原来的目录，然后跳过去。当前正在用的会话完全不受影响。

## Considered Options

- **在当前窗口 `switchSession`**：这是最初的做法。被否决，两个原因：
  1. `switchSession` 只存在于 `ExtensionCommandContext`，所以只有用 `/sessions` 打开面板时才可用；用左方向键手势打开时会报错。两种打开方式行为不一致。
  2. 恢复一个已经关掉的会话，语义上不该把你的当前会话顶掉。
- **在新的 tmux session 里开窗口**：被否决。用户已经在某个 tmux session 里工作，新窗口应该出现在手边，而不是另一个 session 里。

## Consequences

`switchSession` 不再被使用，面板从命令上下文和手势上下文进入时走的是**同一条代码路径**，B 类问题从根上消失。

副作用：`o` 键被删除。它原本表示"在当前窗口接管"，这个语义随 `switchSession` 一起消失，剩下的部分与 Enter 重复。留着它只会在 live 行上于同一个会话文件启动第二个 pi 进程。
