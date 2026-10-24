# 自动起名：一个检查，两个触发点

会话没有名字、且已经有 user 消息时，用配置的模型生成一个短标题，写进 `session_info`。

判据只有这一条，不区分场景：

| 情况 | 结果 |
|---|---|
| 已经有名字 | 不动 |
| 还没有 user 消息 | 等下一次 |
| 有消息、没名字 | 生成 |

## Considered Options

- **按场景分别处理**（新会话在第一次 prompt 后、恢复的旧会话在启动时）：被否决。两个入口、两套判断，而判据其实是同一个，分开写只会让两边慢慢分叉。
- **用 "进程内是否尝试过" 做标志**：被否决。issue 原本这么写，但它和"失败下次再试"矛盾：成功时标志与名字检查重复，失败时标志必须不设。真正需要挡的是**并发**，不是"尝试过"。

## 触发点

| 钩子 | 覆盖 |
|---|---|
| `session_start` | 恢复的旧会话（已有消息、没有名字），立刻起名 |
| `before_agent_start`（`messageType === "user"`） | 新会话说了第一句话；也包括上次失败后的重试 |

两个都不 await，起名不拖慢启动，也不拖慢第一轮回复。

## 并发

`session_start` 和 `before_agent_start` 可能几乎同时触发。用一个 in-flight 标志挡住：正在生成时直接返回，`finally` 里清掉，成功失败都清。这样一个会话最多花一次模型调用，失败还能重试。

## Consequences

`before_agent_start` 触发时，当前这条 prompt 还没有进入 branch，所以文本必须从 `event.prompt` 传入；`session_start` 那条从 branch 读。两处共用同一个 `firstUserText`。

模型 id 可能自带斜杠（如 `auto/glm-5.3-flash`），配置写成 `provider/model` 时只按第一个斜杠切分，切不出来再整体当作 id 逐个 provider 找一遍。
