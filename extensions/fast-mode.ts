/** GPT Fast / Ultrafast via Pi's public hooks. Usage, sources and checks: ../tools/fast-mode.md */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type FastMode = "off" | "priority" | "ultrafast";
type FastModeState = Record<string, boolean | "priority" | "ultrafast">;
type ModelLike = NonNullable<ExtensionContext["model"]>;

type PayloadRecord = Record<string, unknown>;

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
if (!AGENT_DIR) throw new Error("GPT Fast 需要 PI_CODING_AGENT_DIR；请通过便携启动器运行 Pi。");
const STATE_DIR = join(AGENT_DIR, "state");
const STATE_PATH = join(STATE_DIR, "openai-fast-mode.json");
const FAST_APIS = new Set(["openai-codex-responses", "openai-responses", "openai-completions"]);
const ULTRA_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

function isRecord(value: unknown): value is PayloadRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelKey(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

function supportsFastMode(model: ModelLike | undefined): boolean {
  return Boolean(model && FAST_APIS.has(model.api) && /^(gpt-|codex-|o[1-9](?:$|[-.]))/i.test(model.id));
}

function supportsUltrafast(model: ModelLike): boolean {
  return ULTRA_MODELS.has(model.id) && (model.api === "openai-responses" || model.api === "openai-codex-responses");
}

// Validate only on explicit selection, never on the token/request hot path.
async function ultrafastProblem(model: ModelLike, ctx: ExtensionContext): Promise<string | undefined> {
  if (!supportsUltrafast(model)) return "Ultrafast 目前仅支持 GPT-6 Astra / GPT-6.1 Sol 的 Responses/Codex 接口；保持原档位。";
  if (model.api !== "openai-codex-responses") return;
  try {
    const url = new URL(model.baseUrl);
    // A proxy may support the tier, but has no standard account-entitlement endpoint.
    // Never send ChatGPT credentials to a proxy or follow a cross-origin redirect.
    if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/backend-api")) return;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return "无法获取 Codex 登录凭据以核验 Ultrafast；请先 /login，原档位不变。";
    if (auth.baseUrl && new URL(auth.baseUrl).origin !== url.origin) return "实际端点与模型端点不一致，无法安全核验 Ultrafast；原档位不变。";
    url.pathname = "/backend-api/codex/models";
    // Known catalog protocol version with service_tiers support; not an inference request.
    url.search = "?client_version=0.162.0";
    url.hash = "";
    const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${auth.apiKey}` });
    for (const [key, value] of Object.entries({ ...model.headers, ...auth.headers })) {
      if (key.toLowerCase() === "chatgpt-account-id" && typeof value === "string") headers.set(key, value);
    }
    if (!headers.has("chatgpt-account-id")) {
      try {
        const claims = JSON.parse(Buffer.from(auth.apiKey.split(".")[1], "base64url").toString("utf8"));
        const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof accountId === "string") headers.set("chatgpt-account-id", accountId);
      } catch { /* A token need not be a JWT; the server remains authoritative. */ }
    }
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      await response.body?.cancel();
      return `Ultrafast 权限查询失败（HTTP ${response.status}）；保持原档位，请稍后重试。`;
    }
    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.models)) return "模型目录格式无法识别，不能确认 Ultrafast 权限；保持原档位。";
    const entry = data.models.find(item => isRecord(item) && item.slug === model.id);
    if (!isRecord(entry) || !Array.isArray(entry.service_tiers) || !entry.service_tiers.some(tier => isRecord(tier) && tier.id === "ultrafast")) {
      return "当前 Codex 账户/模型目录未开放 Ultrafast；需要符合条件的订阅及工作区权限。保持原档位。";
    }
  } catch {
    return "无法核验 Ultrafast 权限（网络、登录或目录异常）；保持原档位。";
  }
}

async function readState(): Promise<FastModeState> {
  try {
    const value: unknown = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (!isRecord(value) || Object.values(value).some(mode => typeof mode !== "boolean" && mode !== "priority" && mode !== "ultrafast")) {
      throw new Error(`GPT Fast 状态格式无效：${STATE_PATH}`);
    }
    return value as FastModeState;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error; // Do not silently erase a corrupt or unreadable preference file.
  }
}

async function setFastMode(model: ModelLike, value: FastMode | boolean): Promise<void> {
  const mode = typeof value === "boolean" ? (value ? "priority" : "off") : value;
  // Serializes sessions within Pi Web; atomic rename protects readers in the CLI too.
  // ponytail: independent Pi processes are last-writer-wins; use a cross-process lock if needed.
  await withFileMutationQueue(STATE_PATH, async () => {
    const state = await readState();
    const key = modelKey(model);
    if (mode === "off") delete state[key];
    else state[key] = mode === "priority" ? true : "ultrafast";
    await mkdir(STATE_DIR, { recursive: true });
    const temporaryPath = `${STATE_PATH}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, STATE_PATH);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
}

async function getFastMode(model: ModelLike): Promise<FastMode> {
  const value = (await readState())[modelKey(model)];
  return value === "ultrafast" ? (supportsUltrafast(model) ? "ultrafast" : "off")
    : value === true || value === "priority" ? "priority" : "off";
}

async function isFastModeEnabled(model: ModelLike): Promise<boolean> {
  return (await getFastMode(model)) !== "off";
}

function modeLabel(mode: FastMode): string {
  return mode === "priority" ? "ON (Fast)" : mode === "ultrafast" ? "Ultrafast" : "OFF";
}

function currentStatus(model: ModelLike, mode: FastMode, reportedTier?: string): string {
  const tier = mode !== "off" ? `请求 ${mode} · 上游: ${reportedTier ?? "未回报"}` : "不注入档位 · /fast on 开启";
  return `GPT Fast: ${modeLabel(mode)} · ${model.provider}/${model.id} · ${tier}`;
}

export default function fastMode(pi: ExtensionAPI): void {
  let reportedTier: string | undefined;
  let requestedMode: FastMode = "off";
  function showStatus(ctx: ExtensionContext, model: ModelLike | undefined, mode: FastMode): void {
    if (!ctx.hasUI) return;
    const supported = supportsFastMode(model);
    // Pi Web >=0.12 renders command: status keys as native buttons; no frontend fork.
    for (const [arg, value, label] of [["off", "off", "关闭"], ["on", "priority", "Fast"], ["ultra", "ultrafast", "Ultrafast"]] as const) {
      ctx.ui.setStatus(`command:/fast ${arg}`, supported && ctx.mode === "rpc"
        ? `${mode === value ? "✓ " : ""}${label}` : undefined);
    }
    ctx.ui.setStatus("gpt-fast", supported
      ? `GPT Fast: ${modeLabel(mode)}${mode !== "off" && reportedTier ? ` / ${reportedTier}` : ""}`
      : undefined);
    ctx.ui.setWidget("gpt-fast", supported && model
      ? [`${currentStatus(model, mode, reportedTier)} · /fast menu`]
      : undefined);
  }

  async function refresh(ctx: ExtensionContext, model = ctx.model): Promise<void> {
    reportedTier = undefined;
    requestedMode = "off";
    showStatus(ctx, model, model && supportsFastMode(model) ? await getFastMode(model) : "off");
  }

  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("session_switch", (_event, ctx) => refresh(ctx));
  pi.on("model_select", (event, ctx) => refresh(ctx, event.model));

  pi.on("before_provider_request", async (event, ctx) => {
    const model = ctx.model;
    if (!supportsFastMode(model) || !model || !isRecord(event.payload)) return;
    // Do not apply the selected model's preference to a different request model.
    if (typeof event.payload.model === "string" && event.payload.model !== model.id) return;
    const mode = await getFastMode(model);
    reportedTier = undefined;
    requestedMode = mode;
    showStatus(ctx, model, mode);
    if (mode !== "off") return { ...event.payload, service_tier: mode };
  });

  // Native Codex/CPA routing hint. Standard API-key requests need only service_tier.
  pi.on("before_provider_headers", async (event, ctx) => {
    const model = ctx.model;
    if (!model || model.api !== "openai-codex-responses" || !supportsFastMode(model)) return;
    const mode = await getFastMode(model);
    if (mode === "off") return;
    // Respect explicit operator headers, case-insensitively, just like CPA.
    if (Object.keys({ ...model.headers, ...event.headers }).some(key => key.toLowerCase() === "x-codex-routing-hint")) return;
    if (/[\r\n;]/.test(model.id)) return;
    event.headers["x-codex-routing-hint"] = `model=${model.id};tier=${mode}`;
  });

  // Observe, never rewrite, the server's answer. A requested tier is not proof of delivery.
  pi.on("provider_stream_event", (event, ctx) => {
    const model = ctx.model;
    if (requestedMode === "off" || !model || event.provider !== model.provider || event.model !== model.id || event.api !== model.api) return;
    const data = event.data;
    if (!isRecord(data)) return;
    if (model.api !== "openai-completions" && data.type !== "response.completed" && data.type !== "response.done") return;
    const response = isRecord(data.response) ? data.response : data;
    const tier = response.service_tier;
    if (typeof tier !== "string" || !["priority", "fast", "default", "auto", "flex", "scale", "ultrafast"].includes(tier)) return;
    if (reportedTier === tier) return;
    reportedTier = tier;
    showStatus(ctx, model, requestedMode);
  });

  pi.registerCommand("fast", {
    description: "GPT 速度：/fast [menu|on|ultra|off|status]（Fast / Ultrafast，增加费用/额度消耗）",
    getArgumentCompletions: prefix => [
      { value: "menu", label: "menu — 选择速度档位" },
      { value: "on", label: "on — Fast (priority)" },
      { value: "ultra", label: "ultra — Ultrafast（更高消耗）" },
      { value: "off", label: "off — 关闭注入 / 跟随上游" },
      { value: "status", label: "status — 查看当前档位" },
    ].filter(item => item.value.startsWith(prefix.trim().toLowerCase())),
    handler: async (args, ctx) => {
      const model = ctx.model;
      if (!supportsFastMode(model) || !model) {
        ctx.ui.notify("仅支持 GPT/Codex/o 系列的 OpenAI Responses、Codex 或 Chat Completions 接口；上游需支持所选速度档位。", "warning");
        return;
      }
      let normalized = args.trim().toLowerCase();
      if (!["", "menu", "on", "fast", "priority", "ultra", "ultrafast", "off", "status"].includes(normalized)) {
        ctx.ui.notify("用法：/fast [menu|on|ultra|off|status]；无参数切换 Fast/关闭。", "warning");
        return;
      }
      const current = await getFastMode(model);
      if (normalized === "status") {
        showStatus(ctx, model, current);
        ctx.ui.notify(currentStatus(model, current, reportedTier), "info");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("请等待当前请求结束再切换速度；未修改档位。", "warning");
        return;
      }
      if (normalized === "menu") {
        if (!ctx.hasUI) {
          ctx.ui.notify("当前模式无选择界面，请使用 /fast on、/fast ultra 或 /fast off。", "warning");
          return;
        }
        const choices = [
          { label: "关闭 — 不注入档位，跟随上游配置", value: "off" },
          { label: "Fast — 快速 (priority)，增加消耗", value: "on" },
          ...(supportsUltrafast(model) ? [{ label: "Ultrafast — 超快（订阅额度 8× / credits 6×；API另计，需权限）", value: "ultra" }] : []),
        ];
        const selected = await ctx.ui.select(`GPT 速度 · ${model.id}`, choices.map(item => item.label));
        const choice = choices.find(item => item.label === selected);
        if (!choice) return;
        normalized = choice.value;
      }
      const mode: FastMode = normalized === "ultra" || normalized === "ultrafast" ? "ultrafast"
        : normalized === "off" || (normalized === "" && current !== "off") ? "off" : "priority";
      if (mode === "ultrafast") {
        const problem = await ultrafastProblem(model, ctx);
        if (problem) {
          ctx.ui.notify(problem, "warning");
          return;
        }
      }
      if (!ctx.isIdle() || !ctx.model || modelKey(ctx.model) !== modelKey(model) || ctx.model.api !== model.api || ctx.model.baseUrl !== model.baseUrl) {
        ctx.ui.notify("模型已切换或请求正在进行；未修改速度档位，请重试。", "warning");
        return;
      }
      await setFastMode(model, mode);
      reportedTier = undefined;
      requestedMode = "off";
      showStatus(ctx, model, mode);
      const warning = mode === "ultrafast" ? "；Ultrafast 消耗显著更高：符合条件的 ChatGPT 订阅内含额度 8×、购买 credits 6×；API/中转按供应商计费，是否放行由上游决定。"
        : mode === "priority" ? "；Fast 可能增加费用/额度消耗，是否兑现由上游决定。" : "；保留供应商默认档位。";
      ctx.ui.notify(`${currentStatus(model, mode)}${warning}`, "info");
    },
  });
}

export { FAST_APIS, STATE_PATH, isFastModeEnabled, modelKey, setFastMode, supportsFastMode };
