# 用左方向键手势打开面板，全局替换输入框

在输入框里，当光标停在第 0 行第 0 列时再按一次左方向键，打开面板。面板打开时，同一个手势关闭面板，效果等同 Esc 和 q。

为此本包在 `session_start` 时调用 `ctx.ui.setEditorComponent()` 替换整个输入框，继承 `CustomEditor`，只拦截这一个条件，其余输入全部 `super` 透传。

## Considered Options

- 只提供一个快捷键：被否决，丢掉了 Claude Code 的手感，而这正是这个项目的出发点。
- 只在输入框为空时触发：被否决，比 Claude Code 更严格，且"行首再按左"已经是足够精确的条件。

## Consequences

每个加载本包的 pi 会话都会跑本包的编辑器。pi 升级若改变 `Editor` 内部状态形状（`state.cursorLine` / `state.cursorCol`），手势会静默失效而不是报错，因此需要一条针对该形状的测试。
