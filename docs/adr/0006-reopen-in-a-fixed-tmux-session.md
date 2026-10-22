# 恢复会话放进一个固定名字的 tmux session

对 Closed 行按 Enter 时，把会话恢复到 tmux session `pi-sessions` 里的一个新窗口：cwd 设为会话原来的目录，命令是 `pi --session <file>`，然后把客户端切过去。

`pi-sessions` 只在第一次恢复时创建，之后每次恢复都是往里加一个窗口。

## Considered Options

- **在当前 tmux session 里开新窗口**：被否决。恢复出来的是历史会话，你是有意去看它的；把它混进正在工作的那个 session，会把真正在用的窗口挤走。
- **在当前窗口 `switchSession`**：被否决，两个原因：`switchSession` 只存在于 `ExtensionCommandContext`，所以只有 `/sessions` 打开时才可用，手势打开会报错；而且它会把当前会话顶掉。
- **每次恢复都新建一个 tmux session**：被否决。会话名字固定不下来，恢复几次就多几个 session，列表很快失控。

## Consequences

恢复出来的会话和你的工作区彻底分开，关掉 `pi-sessions` 就等于一次性关掉所有恢复出来的会话。

`switchSession` 不再被使用，面板从命令上下文和手势上下文进入时走的是同一条代码路径。

副作用：`o` 键被删除。它原本表示"在当前窗口接管"，这个语义随 `switchSession` 一起消失，剩下的部分与 Enter 重复。留着它只会在 live 行上于同一个会话文件启动第二个 pi 进程。
