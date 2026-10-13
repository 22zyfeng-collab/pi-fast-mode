# Pi Fast Mode

为 Pi / Pi Web 提供 **关闭、Fast、Ultrafast** 控制，使用 Pi 公开扩展接口，不修改 SDK 内核或替换 provider。

Fast / Ultrafast controls for Pi, with native Pi Web buttons, per-model preferences, and Codex entitlement checks.

> **请求加速不等于上游保证。** 扩展不会绕过账户权限，不保证延迟或加速倍数。两档都可能增加费用或额度消耗；实际以供应商政策和结算为准。

## 功能

- `/fast` 命令与 Pi Web 原生底栏按钮，共用同一套设置逻辑。
- Fast 请求 `service_tier=priority`；Ultrafast 请求 `service_tier=ultrafast`。
- “关闭”停止本扩展注入，保留供应商原有档位，**不强制 Standard/default**。
- 按供应商/模型保存，兼容旧的布尔值配置，不自动升级到 Ultrafast。
- 明确区分客户端请求与上游回报；未回报时不冒充确认。
- Codex 直连的 Ultrafast 选择会校验账户模型目录；拒绝、网络异常或模型变化时保留原档位。
- 不修改模型、思考强度、token 预算或 Pi 的原生 HTTP/WebSocket 传输选择。

## 安装

需要已有 Pi 环境，并在启动前显式设置 **`PI_CODING_AGENT_DIR`**，指向自己的 agent 数据目录。这是便携版的保护措施：未设置时扩展拒绝加载，不回退到电脑 HOME。

在已配置该环境变量的终端中安装：

```bash
pi install git:github.com/22zyfeng-collab/pi-fast-mode
```

便携 Pi 用户请通过自己的启动器执行上述安装命令。仓库通过 `package.json` 的 `pi.extensions` 声明入口，SDK 由 Pi 提供，无额外运行时依赖。仅通过 Git 分发，未发布到 npm；`private: true` 用于防止误执行 npm publish，不影响公开 GitHub 仓库或 Git 安装。

也可手动复制 `extensions/fast-mode.ts` 到 `$PI_CODING_AGENT_DIR/extensions/`。

**两种安装方式选一种。** 如果已手动安装同名扩展，切换到包安装前先备份并移出旧副本，避免 `/fast` 重复注册。不要删除速度状态文件。

安装后，等当前回复结束，在会话里执行一次 `/reload`，或使用界面的扩展重载功能。

## Pi Web 按钮

Pi Web **0.12+** 原生支持 `command:` 状态键。支持的模型会在已启动会话的底栏显示：

```text
关闭 | ✓ Fast | Ultrafast
```

- `✓` 表示当前保存的**请求档位**，不是上游已兑现加速。
- 点击按钮即可切换；忙碌期间由 Web 禁用，命令处理函数也会检查状态。
- 展开的 `gpt-fast` 长说明仍只读，请点击底栏按钮。
- 单独刷新网页不会重载已有会话的扩展代码；更新扩展后使用 `/reload`，无需重编译前端。
- 尚未启动运行时的全新空白会话可能没有状态栏，启动会话后才出现。
- 终端使用下列命令，保持普通状态文本显示。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/fast menu` | 选择关闭 / Fast / Ultrafast；取消不改设置 |
| `/fast on` | 选择 Fast；也接受 `fast`、`priority` |
| `/fast ultra` | 选择 Ultrafast；也接受 `ultrafast`，需通过检查 |
| `/fast off` | 停止扩展注入 |
| `/fast status` | 仅查看 |
| `/fast` | 关闭时开启 Fast，已开启任一加速档时关闭 |

## 支持范围与权限

- **Fast**：模型 ID 以 `gpt-`、`codex-` 或标准 `o1/o3/o4…` 形式开头，使用 `openai-codex-responses`、`openai-responses` 或 `openai-completions`。中转仍须支持和透传 priority。
- **Ultrafast**：当前代码名单为 `gpt-6-astra`、`gpt-6.1-sol`，仅 Responses / Codex Responses。名单是实现时快照，不代表所有账户都具备权限；未来支持范围变化时需审核更新代码。
- 官方 Codex 直连在**明确选择 Ultrafast 时**查询模型目录；普通推理、Fast 开关不增加权益查询。
- 独立 API、中转的计费和权限由各自供应商决定；没有通用中转权益查询接口，扩展不会编造一个。
- 上游回报 `default` 不会被改写成 priority，也不能仅凭这个值推算账单或保证实际加速。

状态文件：`$PI_CODING_AGENT_DIR/state/openai-fast-mode.json`。它是个人配置，**不属于仓库内容**。

实现细节见 [tools/fast-mode.md](tools/fast-mode.md)。

## 测试

```bash
# 在仓库根目录、已设置 PI_CODING_AGENT_DIR 的环境中运行
# 显式传入已安装的 SDK 包目录，例如全局 CLI 的 SDK：
node tools/fast-mode.test.mjs "$(npm root -g)/@earendil-works/pi-coding-agent"

# 标准便携目录布局可省略参数，默认寻找 agent 同级的 web-ui SDK
npm test
```

测试加载的是**本仓库的扩展源码**，使用真实 Pi loader、runner、provider 序列化器，模拟 HTTP、WebSocket 和权益目录。测试状态放在 agentDir 的临时缓存子目录，结束后清理，不读取真实凭据或调用付费推理。

已在 Node.js 24 环境、Pi SDK **1.2.0 / 1.0.4** 下分别通过 **17 项**测试，覆盖原生按钮、持久化、序列化、旧状态、权益拒绝、凭据 origin 隔离及并发保护。另在官方 Pi Web **0.12.1** 上完成桌面/手机浏览器点击验收；机器专用的浏览器测试脚本不随包发布。

## 安全与限制

- 仓库不包含 API Key、登录态、个人设置、实际状态文件或会话记录。
- 同进程写入经过队列与原子替换；不同 Pi 进程同时修改同一文件仍为最后写入者胜出。
- 损坏状态文件会报错，不会静默覆盖。
- 不记录账户 token；目录请求禁止重定向，拒绝把官方凭据转发到不同 origin。
- 不增加额外重试或付费测速，不自行计算账单；费用提示和模型名单以当前实现及供应商最新说明为准。

## 参考

- [Codex 速度模式](https://developers.openai.com/codex/speed)
- [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
- [Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)
- [Pi Web](https://github.com/agegr/pi-web)
