# Idle 退出前核对目标实例

仅凭 `kill(pid, 0)` 不能证明 PID 仍属于登记的 Pi。异常退出留下的记录可能在 PID 被复用后继续显示为 live；Idle 退出不能只凭这个列表提示发信号。

## 初始决定与修正原因

初始实现为 Linux 登记 boot UUID + `/proc/<pid>/stat` 启动 tick，退出前匹配所选行、最新 registry 和内核身份。macOS 因缺少 procfs 被有意拒绝，导致本机 Idle 退出失效，重载也无法解决。`ps lstart` 的秒精度时间不足以替代该校验。

为恢复 macOS，同时避免新增原生依赖，改用 Node 内置的本地 Unix socket，让目标实例自行退出。保留现有 Linux 校验作为旧记录的兼容路径，不将它作为新通道失败后的 fallback。

## 决定

1. 每次加载扩展，在私有临时目录建立独有 socket，生成随机实例凭据。监听成功后将 endpoint 和凭据随自己的 registry 记录发布；不发现或扫描其他进程。
2. 面板严格解析选中行的 PID，核对最新记录仍为 Idle，且会话文件、endpoint 和凭据均与所选行一致。
3. 面板向该 endpoint 发送凭据、PID 和会话文件。目标核对自己的凭据，并读取当前的会话文件及 Idle 状态；检查与调用 `ctx.shutdown()` 之间没有 await。
4. 目标先写入接受响应，再调用自己的 Pi 优雅退出 API，不给远程 PID 发信号；接受只代表退出请求已交给 Pi，不代表终端已完成清理。重复请求不会重复触发 shutdown。
5. 错误凭据、PID 复用、Working、会话变化、损坏/缺失记录及失联通道都拒绝。客户端等待最多 2 秒，失败不插入 Closed，也不 fallback 到 SIGTERM。
6. reload、会话 shutdown 和重新登记会关闭旧通道；异步监听若在 shutdown 后才完成，立即关闭，不重新发布残留记录。每次重新登记都使用新 endpoint 和凭据。

名称、cwd、tmux pane 和命令行中的 `pi` 都不作为身份凭据。注册表仍是唯一发现来源，`kill(pid, 0)` 仅用于列表存活提示。

## 平台与升级

- macOS 和 Linux 使用相同的 Node 本地 socket 路径，不需要原生模块或额外工具。
- socket 置于 `mkdtemp` 创建的私有临时目录；注册表应由同一用户、同一主机使用。该机制不防御拥有同权限、可读写注册表的恶意本机用户。
- 面板宿主与目标均需更新。目标在空闲时 `/reload` 或重启后自行登记；不能用当前 PID 的存在替旧记录补造凭据。
- 无通道的旧 Linux 记录继续走原有 boot UUID + 启动 tick 核对，再发 SIGTERM。该旧路径仍有检查与信号之间的 TOCTOU 边界；新通道不受 PID 重用后给其他进程发信号的风险影响。
- 无通道且无可验证 Linux 身份的记录保留显示、拒绝退出，提示重载目标；不再提示用户改用 Linux 主机。
- socket 不能建立时，其余面板功能仍可用；macOS 拒绝退出，Linux 仅可使用已有的完整启动身份校验，不降低检查。

## 验证

保留模拟 Linux 身份校验的旧测试。新增使用真实临时本地 socket、模拟 shutdown 回调的测试，覆盖 macOS 的生产 X 键路径、正常/重复请求、旧凭据与同 PID 新实例、Working、会话变化、丢失/变更登记、失联/超时、reload 清理，以及 shutdown 期间尚未完成的监听不复活记录。测试不停止真实 Pi，也不向真实进程发送 SIGTERM。

另有默认跳过的真实应用 E2E：`PI_PANEL_EXIT_LIVE=1 node --test --experimental-strip-types test/exit-live.test.ts`。它在专用 tmux server 中启动已安装的 Pi TUI，使用临时 registry/settings，真正从宿主面板按 `x` 让目标调用自身 shutdown 并以 0 退出，同时验证同 PID 的实际 reload 更换凭据、旧行/错误凭据拒绝。忙状态检查在真实 `before_agent_start` 暂停，首个 provider 请求不执行；结束时 abort 后由 Pi 正常退出。此测试不模拟面板或 shutdown，但不覆盖模型已经流式输出的阶段。
