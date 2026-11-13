# 测试与验证

验证日期：2026-11-13。环境：macOS arm64，Node v22.21.1。

## 当前结果

| 检查 | 结果 |
|---|---|
| `npm test` | 165 项：159 通过，6 跳过，0 失败 |
| `npm run test:coverage` | 159 通过，6 跳过，0 失败 |
| 生产代码覆盖率 | 行 96.31%，分支 90.19%，函数 90.37% |
| 真实 Pi/tmux 退出测试 | 1 通过，0 跳过 |

覆盖率只统计 `extension/**`，采用 Node 内置覆盖率、同进程串行模式汇总。默认测试仍采用进程隔离；两种运行方式的覆盖率不混用比较。

6 项默认跳过包括 4 项仅 Linux 适用的测试，以及真实 Pi/tmux、真实模型命名两个可选测试。本轮单独启用了真实 Pi/tmux 测试；未调用真实模型，也未在 macOS 上执行 Linux 专用测试。

## 本次收尾

- 真实 TUI 测试的 40 条历史样例均写入用户消息，符合空会话不进入 Closed 的规则。
- 空会话退出测试统一放在 `closed-transition.test.ts`，删除重复的 `empty-transition.test.ts`；保留零消息文件删除与尚未落盘会话不生成 Closed 行两个场景。
- 历史扫描期间删除、改名与退出的修改不会被旧扫描结果覆盖；测试同时检查缓存与搜索文本。
- 快照测试检查绘制与移动不重复读取注册表、完整字段变化使缓存失效，以及关闭后清理定时器。
- 测试整理合并了重复的打开、命名、搜索和 spinner 检查；保留真实行为断言、退出身份校验、取消与失败路径。
- 真实 Pi/tmux 验证 Idle 退出、40 条历史下的 Closed 置顶、reload 后凭据更新、旧凭据拒绝、忙状态拒绝和资源清理。忙状态验证停在 provider 请求之前。

## 复现

```bash
npm test
npm run test:coverage
PI_PANEL_EXIT_LIVE=1 node --test --experimental-strip-types test/exit-live.test.ts
```

真实 TUI 测试使用 `/tmp` 下的独立 agent 目录和 tmux socket，保留运行证据并清理测试进程，不调用模型。
