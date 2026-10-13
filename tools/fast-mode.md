# 实现说明

入口：[`../extensions/fast-mode.ts`](../extensions/fast-mode.ts)。

## 档位与状态

| 选择 | 请求字段 | 保存值 |
| --- | --- | --- |
| 关闭 | 不注入；保留原请求配置 | 删除该模型条目 |
| Fast | `service_tier: "priority"` | `true`，兼容旧格式 |
| Ultrafast | `service_tier: "ultrafast"` | `"ultrafast"` |

状态键是 `provider/modelId`。读取也接受 `false` 和 `"priority"`；新模型默认关闭。状态固定写入显式设置的 `PI_CODING_AGENT_DIR`，使用同目录临时文件、原子 rename 和 Pi 的 `withFileMutationQueue`。

该队列协调同一进程的多会话，不是跨进程锁。独立进程并发修改仍为最后写入者胜出。无效 JSON 或状态值会报错，避免静默抹掉旧配置。

## 请求与回报

- `before_provider_request` 注入明确选择的档位，保留其他字段。
- `before_provider_headers` 为 Codex 增加 `x-codex-routing-hint`；已有显式同名头优先，普通 API 不增加 Codex 专用头。
- `provider_stream_event` 只观察匹配供应商、模型和 API 的回报，不改服务端事件。
- `请求 priority/ultrafast` 与服务端 `service_tier` 分开显示；未回报时不自行填充。
- 不强制 SSE，不接管 WebSocket 缓存；真实 SDK 的离线测试确认档位变化会开始新的响应链，不沿用旧档位的 `previous_response_id`。

## Ultrafast 校验

先检查模型/协议名单，再对官方 Codex 直连查询：

```text
https://chatgpt.com/backend-api/codex/models?client_version=0.162.0
```

使用 Pi 原生凭据解析器，只保留所需的认证信息；禁止重定向，拒绝不一致的凭据 origin。仅当匹配模型的 `service_tiers` 明确包含 `ultrafast` 才保存。

查询仅在用户选择 Ultrafast 时发生，超时 10 秒。网络、登录、目录或权益异常保持原档位，不自动重试或调用模型测速。已保存的选择在重载时恢复，之后仍由上游决定是否接受。

独立 Responses API 和第三方代理没有通用的订阅目录接口；扩展仅按代码支持范围发送用户选择，不能保证权益或中转透传。授权、支持模型及计费以供应商为准。

## UI 与命令

终端和 Web 共用注册的 `/fast` 命令。RPC 模式另外发布三个状态：

```text
command:/fast off
command:/fast on
command:/fast ultra
```

Pi Web 0.12+ 将这些状态渲染为原生按钮。点击经 Web 的命令提交路径到达 SDK；已注册的 `/fast` 在进入模型前消费命令，不需要模型生成设置结果。TUI 保留普通状态文本。

`✓` 只标记保存的请求档位，不标记实际加速。后端在选择前后检查忙碌及模型变化；Ultrafast 权限拒绝保留原档。`/fast status`、取消菜单和无效参数不切换档位。

升级扩展后，已有会话需要在空闲时 `/reload`；仅刷新网页不会重载运行时中的扩展。不要同时通过本地文件和包安装重复加载该扩展。

## 回归测试

[`fast-mode.test.mjs`](fast-mode.test.mjs) 使用仓库源码和指定的真实 Pi SDK，在 agentDir 内创建临时状态目录，模拟所有上游请求。覆盖 17 项行为，包括原生按钮、请求字段、旧状态、权限失败、同进程多会话、WebSocket 响应链及凭据保护。

测试 token、账户标识和域名均为离线虚构值。测试不请求真实推理，不包含或依赖个人登录文件。执行方法见仓库 README。
