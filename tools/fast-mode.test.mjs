// Run from this checkout: node tools/fast-mode.test.mjs [pi-coding-agent package directory]
// Real Pi loader/runner; isolated USB state; no credentials or network requests.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { after, test } from "node:test";

const agentDir = process.env.PI_CODING_AGENT_DIR;
assert.ok(agentDir, "Use the portable launcher (PI_CODING_AGENT_DIR is required)");
const sdkDir = process.argv[2] ?? join(dirname(agentDir), "web-ui/node_modules/@earendil-works/pi-coding-agent");
await mkdir(join(agentDir, "cache"), { recursive: true });
const sandbox = await mkdtemp(join(agentDir, "cache/fast-mode-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
after(async () => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await rm(sandbox, { recursive: true, force: true });
});
const { loadExtensions } = await import(pathToFileURL(join(sdkDir, "dist/core/extensions/loader.js")));
const { ExtensionRunner } = await import(pathToFileURL(join(sdkDir, "dist/core/extensions/runner.js")));
const extensionPath = fileURLToPath(new URL("../extensions/fast-mode.ts", import.meta.url));
const statePath = join(sandbox, "state/openai-fast-mode.json");
const codex = { provider: "openai-codex", id: "gpt-6-astra", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };

async function harness(model = codex, mode = "rpc", options = {}) {
  const loaded = await loadExtensions([extensionPath], sandbox);
  assert.deepEqual(loaded.errors, []);
  const errors = [], notifications = [], statuses = new Map(), widgets = new Map();
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, sandbox, {}, options.registry ?? {});
  runner.bindCore({}, {
    getModel: () => model, getScopedModels: () => [], isIdle: () => options.idle !== false,
    isProjectTrusted: () => true, getSignal: () => undefined, abort() {},
    hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined,
    compact() {}, getSystemPrompt: () => "",
  });
  runner.onError(error => errors.push(error));
  if (mode !== "print") runner.setUIContext({
    setStatus: (key, value) => statuses.set(key, value),
    setWidget: (key, value) => widgets.set(key, value),
    notify: (message, type) => notifications.push({ message, type }),
    select: options.select ?? (async () => undefined),
  }, mode);
  return {
    runner, errors, notifications, statuses, widgets,
    command: args => runner.getCommand("fast").handler(args, runner.createCommandContext()),
    select: async next => {
      const previousModel = model;
      model = next;
      await runner.emit({ type: "model_select", model, previousModel, source: "set" });
    },
  };
}

async function seed(state = { "openai-codex/gpt-6-astra": true }) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
}

test("saved Fast mode is visible after startup/reload in TUI and Web/RPC", async () => {
  await seed();
  for (const mode of ["tui", "rpc"]) {
    const h = await harness(codex, mode);
    await h.runner.emit({ type: "session_start" });
    assert.match(h.statuses.get("gpt-fast") ?? "", /Fast.*ON/);
    assert.match(h.widgets.get("gpt-fast")?.join(" ") ?? "", /gpt-6-astra.*priority/);
    assert.deepEqual(h.errors, []);
  }
});

test("Web/RPC exposes native speed buttons, marks the saved mode and clears them on unsupported models", async () => {
  await seed();
  const keys = ["command:/fast off", "command:/fast on", "command:/fast ultra"];
  const h = await harness();
  await h.runner.emit({ type: "session_start" });
  assert.deepEqual(keys.map(key => h.statuses.get(key)), ["关闭", "✓ Fast", "Ultrafast"]);
  await h.command("off");
  assert.deepEqual(keys.map(key => h.statuses.get(key)), ["✓ 关闭", "Fast", "Ultrafast"]);
  await h.select({ ...codex, provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet" });
  assert.deepEqual(keys.map(key => h.statuses.get(key)), [undefined, undefined, undefined]);
  const tui = await harness(codex, "tui");
  await tui.runner.emit({ type: "session_start" });
  assert.deepEqual(keys.map(key => tui.statuses.get(key)), [undefined, undefined, undefined]);
  assert.deepEqual(h.errors, []);
});

test("Fast ON sends standard priority across GPT APIs without changing reasoning", async () => {
  const models = [codex,
    { ...codex, provider: "openai", api: "openai-responses" },
    { ...codex, provider: "cpa", api: "openai-completions" },
    { ...codex, provider: "sub2api", api: "openai-responses" },
  ];
  await seed(Object.fromEntries(models.map(m => [`${m.provider}/${m.id}`, true])));
  for (const model of models) {
    const h = await harness(model);
    for (const tier of [undefined, "auto", "default", "flex", "fast", "priority"]) {
      const payload = { model: model.id, reasoning: { effort: "high" }, input: [], ...(tier === undefined ? {} : { service_tier: tier }) };
      const original = structuredClone(payload);
      const result = await h.runner.emitBeforeProviderRequest(payload);
      assert.deepEqual(result, { ...original, service_tier: "priority" });
      assert.deepEqual(payload, original, "do not mutate another extension's payload");
    }
    assert.deepEqual(h.errors, []);
  }
});

test("status and invalid arguments never toggle; explicit commands persist per model", async () => {
  await seed();
  const h = await harness();
  await h.command("status");
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "priority");
  await h.command("typo");
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "priority");
  assert.equal(h.notifications.at(-1).type, "warning");
  await h.command("off");
  const payload = { model: codex.id, service_tier: "flex" };
  assert.deepEqual(await h.runner.emitBeforeProviderRequest(payload), payload);
  assert.match(h.statuses.get("gpt-fast"), /OFF/);
  await h.command("on");
  await h.select({ ...codex, id: "gpt-6-sol" });
  assert.match(h.statuses.get("gpt-fast"), /OFF/);
  await h.command("");
  assert.match(h.statuses.get("gpt-fast"), /ON/);
  const reloaded = await harness();
  await reloaded.runner.emit({ type: "session_start" });
  assert.match(reloaded.statuses.get("gpt-fast"), /ON/);
  assert.deepEqual(h.errors, []);
});

test("non-OpenAI models and unrelated payload models are never modified", async () => {
  for (const model of [
    { ...codex, provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet" },
    { ...codex, provider: "proxy", api: "openai-completions", id: "deepseek-chat" },
  ]) {
    await seed({ [`${model.provider}/${model.id}`]: true });
    const h = await harness(model);
    const payload = { model: model.id };
    assert.deepEqual(await h.runner.emitBeforeProviderRequest(payload), payload);
    await h.runner.emit({ type: "session_start" });
    assert.equal(h.widgets.get("gpt-fast"), undefined);
    await h.command("on");
    assert.equal(h.notifications.at(-1).type, "warning");
  }
  await seed();
  const h = await harness();
  for (const payload of [null, [], "raw", { model: "claude-sonnet" }]) {
    assert.deepEqual(await h.runner.emitBeforeProviderRequest(payload), payload);
  }
});

test("Codex priority adds the native routing hint; API-key paths and explicit headers are untouched", async () => {
  await seed({ "openai-codex/gpt-6-astra": true, "openai/gpt-6-astra": true });
  const h = await harness();
  assert.equal((await h.runner.emitBeforeProviderHeaders({}))["x-codex-routing-hint"], "model=gpt-6-astra;tier=priority");
  const custom = { "X-Codex-Routing-Hint": "operator-override" };
  assert.deepEqual(await h.runner.emitBeforeProviderHeaders({ ...custom }), custom);
  const configured = await harness({ ...codex, headers: custom });
  assert.deepEqual(await configured.runner.emitBeforeProviderHeaders({}), {}, "model-configured routing hints also take precedence");
  await h.command("off");
  assert.deepEqual(await h.runner.emitBeforeProviderHeaders({}), {});
  const api = await harness({ ...codex, provider: "openai", api: "openai-responses" });
  assert.deepEqual(await api.runner.emitBeforeProviderHeaders({}), {});
});

test("UI distinguishes requested priority from upstream default/priority and never invents confirmation", async () => {
  await seed();
  const h = await harness();
  await h.runner.emitBeforeProviderRequest({ model: codex.id });
  const widget = () => h.widgets.get("gpt-fast").join(" ");
  assert.match(widget(), /上游.*未回报/);
  const response = (tier, overrides = {}) => h.runner.emit({
    type: "provider_stream_event", provider: codex.provider, api: codex.api, model: codex.id,
    data: { type: "response.completed", response: { service_tier: tier } }, ...overrides,
  });
  await response("priority", { provider: "unrelated" });
  assert.match(widget(), /上游.*未回报/);
  await response("default");
  assert.match(widget(), /上游.*default/);
  await h.command("status");
  assert.match(h.notifications.at(-1).message, /上游.*default/);
  await h.runner.emitBeforeProviderRequest({ model: codex.id });
  assert.match(widget(), /上游.*未回报/);
  await response("priority");
  assert.match(widget(), /上游.*priority/);
  await h.select({ ...codex, id: "gpt-6-sol" });
  assert.match(h.statuses.get("gpt-fast"), /OFF/);
  await response("priority");
  assert.match(h.statuses.get("gpt-fast"), /OFF/);
});

test("corrupt state is reported without overwriting saved preferences", async () => {
  await seed();
  await writeFile(statePath, "{broken-json");
  const h = await harness();
  await assert.rejects(h.command("on"));
  assert.equal(await readFile(statePath, "utf8"), "{broken-json");
});

test("parallel Web sessions preserve both model preferences and headless mode still shapes requests", async () => {
  await seed({});
  const a = await harness();
  const b = await harness({ ...codex, id: "gpt-6-sol" });
  await Promise.all([a.command("on"), b.command("on")]);
  const reloaded = await harness(codex, "print");
  await reloaded.runner.emit({ type: "session_start" });
  assert.equal((await reloaded.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "priority");
  await reloaded.select({ ...codex, id: "gpt-6-sol" });
  assert.equal((await reloaded.runner.emitBeforeProviderRequest({ model: "gpt-6-sol" })).service_tier, "priority");
  assert.deepEqual(reloaded.errors, []);
});

test("Ultrafast is an explicit persistent tier, while legacy Fast settings remain Fast", async () => {
  await seed();
  const model = { ...codex, provider: "openai", api: "openai-responses" };
  const h = await harness(model);
  await h.command("ultra");
  const payload = { model: model.id, service_tier: "priority", reasoning: { effort: "high" } };
  assert.deepEqual(await h.runner.emitBeforeProviderRequest(payload), { ...payload, service_tier: "ultrafast" });
  assert.match(h.statuses.get("gpt-fast"), /Ultrafast/i);
  await h.command("status");
  assert.match(h.notifications.at(-1).message, /ultrafast/i);
  const reloaded = await harness(model);
  await reloaded.runner.emit({ type: "session_start" });
  assert.match(reloaded.statuses.get("gpt-fast"), /Ultrafast/i);
  const legacy = await harness();
  assert.equal((await legacy.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "priority");
  await h.command("fast");
  assert.equal((await h.runner.emitBeforeProviderRequest(payload)).service_tier, "priority");
  await h.command("ultrafast");
  assert.equal((await h.runner.emitBeforeProviderRequest(payload)).service_tier, "ultrafast");
  await h.command("off");
  assert.deepEqual(await h.runner.emitBeforeProviderRequest({ model: model.id }), { model: model.id });
  assert.deepEqual(h.errors, []);
});

test("Ultrafast refuses unsupported models/protocols without changing Fast", async () => {
  for (const model of [
    { ...codex, id: "gpt-6-sol", provider: "openai", api: "openai-responses" },
    { ...codex, provider: "proxy", api: "openai-completions" },
  ]) {
    await seed({ [`${model.provider}/${model.id}`]: true });
    const h = await harness(model);
    await h.command("ultra");
    assert.equal(h.notifications.at(-1).type, "warning");
    assert.equal((await h.runner.emitBeforeProviderRequest({ model: model.id })).service_tier, "priority");
  }
});

test("Codex Ultrafast requires advertised account entitlement; failures leave Fast unchanged", async t => {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } };
  const token = `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`;
  const registry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) };
  const requests = [];
  let status = 200, tiers = [{ id: "priority" }];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: new URL(url), init });
    return new Response(JSON.stringify({ models: [{ slug: codex.id, service_tiers: tiers }] }), { status });
  });
  await seed();
  const h = await harness(codex, "rpc", { registry });
  await h.command("ultra");
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "priority");
  assert.match(h.notifications.at(-1).message, /未.*开放|不.*支持/);
  tiers = [{ id: "priority" }, { id: "ultrafast" }];
  await h.command("ultra");
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "ultrafast");
  assert.equal((await h.runner.emitBeforeProviderHeaders({}))["x-codex-routing-hint"], "model=gpt-6-astra;tier=ultrafast");
  assert.match(h.notifications.at(-1).message, /8×/);
  await h.runner.emit({ type: "provider_stream_event", provider: codex.provider, api: codex.api, model: codex.id,
    data: { type: "response.completed", response: { service_tier: "default" } } });
  assert.match(h.widgets.get("gpt-fast").join(" "), /Ultrafast.*上游.*default/);
  await h.command("on");
  status = 403;
  await h.command("ultra");
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "priority");
  assert.equal(h.notifications.at(-1).type, "warning");
  assert.equal(requests.length, 3, "only explicit Ultra selection fetches metadata, never inference turns");
  assert.equal(requests[0].url.origin, "https://chatgpt.com");
  assert.equal(requests[0].url.pathname, "/backend-api/codex/models");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(new Headers(requests[0].init.headers).get("chatgpt-account-id"), "offline-account");
  assert.ok(!JSON.stringify(h.notifications).includes(token), "credentials must not reach the UI");
});

test("failed eligibility checks preserve Fast and never forward credentials to another origin", async t => {
  await seed();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("offline metadata failure"); });
  const registry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-test-token" }) };
  const h = await harness(codex, "rpc", { registry });
  await h.command("ultra");
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "priority");
  assert.equal(h.notifications.at(-1).type, "warning");
  registry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "offline-test-token", baseUrl: "https://unrelated.invalid" });
  await h.command("ultra");
  assert.equal(requests, 1, "do not send credentials to an auth-overridden origin");
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "priority");
  const proxy = await harness({ ...codex, provider: "proxy", baseUrl: "https://proxy.invalid" });
  await proxy.command("ultra");
  assert.equal(requests, 1, "do not invent a proxy entitlement API");
  assert.equal((await proxy.runner.emitBeforeProviderRequest({ model: codex.id })).service_tier, "ultrafast");
  assert.ok(!JSON.stringify(h.notifications).includes("offline-test-token"));
});

test("speed menu exposes both tiers, preserves cancellation, and completes explicit arguments", async () => {
  await seed({});
  const model = { ...codex, provider: "openai", api: "openai-responses" };
  let choice = "Ultrafast", menuOptions;
  const h = await harness(model, "rpc", { select: async (_title, items) => {
    menuOptions = items;
    return items.find(item => item.includes(choice));
  } });
  await h.command("menu");
  assert.ok(menuOptions.some(item => item.includes("Fast")));
  assert.ok(menuOptions.some(item => item.includes("Ultrafast") && item.includes("8×")));
  assert.ok(menuOptions.some(item => item.includes("关闭")));
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: model.id })).service_tier, "ultrafast");
  choice = "cancel";
  await h.command("menu");
  assert.equal((await h.runner.emitBeforeProviderRequest({ model: model.id })).service_tier, "ultrafast");
  const completions = await h.runner.getCommand("fast").getArgumentCompletions("ul");
  assert.ok(completions.some(item => item.value === "ultra"));
  const print = await harness(model, "print");
  await print.command("menu");
  assert.equal((await print.runner.emitBeforeProviderRequest({ model: model.id })).service_tier, "ultrafast");
});

test("busy sessions and model changes during selection never alter speed", async () => {
  await seed({});
  const model = { ...codex, provider: "openai", api: "openai-responses" };
  const busy = await harness(model, "rpc", { idle: false });
  await busy.command("ultra");
  assert.equal((await busy.runner.emitBeforeProviderRequest({ model: model.id })).service_tier, undefined);
  const h = await harness(model, "rpc", { select: async (_title, items) => {
    await h.select({ ...model, id: "gpt-6-sol" });
    return items.find(item => item.includes("Ultrafast"));
  } });
  await h.command("menu");
  const reloaded = await harness(model);
  assert.equal((await reloaded.runner.emitBeforeProviderRequest({ model: model.id })).service_tier, undefined);
  assert.equal(h.notifications.at(-1).type, "warning");
});

test("real Pi provider serializers send both tiers on the wire and preserve upstream default", async () => {
  const models = [codex,
    { ...codex, provider: "openai", api: "openai-responses" },
    { ...codex, id: "gpt-6.1-sol", provider: "openai", api: "openai-responses" },
    { ...codex, provider: "sub2api", api: "openai-responses" },
    { ...codex, provider: "cpa", api: "openai-completions" },
  ];
  const cases = models.flatMap(selected => (selected.api === "openai-completions" ? ["priority"] : ["priority", "ultrafast"]).map(tier => ({ selected, tier })));
  for (const { selected, tier } of cases) {
    await seed({ [`${selected.provider}/${selected.id}`]: tier });
    const h = await harness(selected);
    const aiDir = createRequire(join(sdkDir, "package.json")).resolve.paths("@earendil-works/pi-ai")
      .map(base => join(base, "@earendil-works/pi-ai"))
      .find(base => existsSync(join(base, "package.json")));
    assert.ok(aiDir, "Resolve pi-ai from the SDK under test, including nested npm layouts");
    const { stream } = await import(pathToFileURL(join(aiDir, `dist/api/${selected.api}.js`)));
    const model = { ...selected, baseUrl: "https://offline.invalid/v1", name: selected.id,
      reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const fakeToken = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64")}.test`;
    let sent;
    const output = stream(model, { messages: [{ role: "user", content: "offline check", timestamp: 0 }] }, {
      apiKey: fakeToken, transport: "sse", maxRetries: 0, reasoningEffort: "high",
      headers: await h.runner.emitBeforeProviderHeaders({}),
      onPayload: payload => h.runner.emitBeforeProviderRequest(payload),
      onProviderStreamEvent: data => h.runner.emit({ type: "provider_stream_event", provider: selected.provider, api: selected.api, model: selected.id, data }),
      fetch: async (_url, init) => {
        const headers = new Headers(init.headers);
        const body = headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(init.body).toString("utf8") : init.body;
        sent = { payload: JSON.parse(body), headers };
        const data = selected.api === "openai-completions"
          ? { id: "chatcmpl-test", object: "chat.completion.chunk", model: selected.id, created: 0, service_tier: "default", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
          : { type: "response.completed", response: { id: "resp-test", status: "completed", model: selected.id, service_tier: "default", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
        return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const result = await output.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(sent.payload.service_tier, tier);
    assert.equal(sent.payload.reasoning?.effort ?? sent.payload.reasoning_effort, "high");
    assert.equal(sent.headers.get("x-codex-routing-hint"), selected.api === "openai-codex-responses" ? `model=${selected.id};tier=${tier}` : null);
    assert.match(h.widgets.get("gpt-fast").join(" "), /上游.*default/);
    assert.deepEqual(h.errors, []);
  }
});

test("real Codex WebSocket starts a new response chain when switching Fast to Ultrafast", async t => {
  const aiDir = createRequire(join(sdkDir, "package.json")).resolve.paths("@earendil-works/pi-ai")
    .map(base => join(base, "@earendil-works/pi-ai")).find(base => existsSync(join(base, "package.json")));
  const { stream, closeOpenAICodexWebSocketSessions } = await import(pathToFileURL(join(aiDir, "dist/api/openai-codex-responses.js")));
  const frames = [];
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends EventTarget {
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(raw) {
      const frame = JSON.parse(raw);
      frames.push(frame);
      setImmediate(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        type: "response.completed", response: { id: `resp-${frames.length}`, status: "completed", model: codex.id,
          service_tier: frame.service_tier, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      }) })));
    }
    close() { this.readyState = 3; }
  };
  const sessionId = "gpt-fast-tier-check";
  t.after(() => { closeOpenAICodexWebSocketSessions(sessionId); globalThis.WebSocket = originalWebSocket; });
  const h = await harness();
  const model = { ...codex, name: codex.id, reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-ws" } })).toString("base64url")}.test`;
  for (const tier of ["priority", "priority", "ultrafast", "ultrafast"]) {
    await seed({ [`${codex.provider}/${codex.id}`]: tier });
    const result = await stream(model, { messages: [{ role: "user", content: "offline", timestamp: 0 }] }, {
      apiKey: token, sessionId, transport: "websocket-cached", timeoutMs: 2000, websocketConnectTimeoutMs: 2000,
      headers: await h.runner.emitBeforeProviderHeaders({}),
      onPayload: payload => h.runner.emitBeforeProviderRequest(payload),
      fetch: async () => { throw new Error("Unexpected HTTP fallback in offline WebSocket check"); },
    }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
  }
  assert.deepEqual(frames.map(frame => frame.service_tier), ["priority", "priority", "ultrafast", "ultrafast"]);
  assert.equal(frames[1].previous_response_id, "resp-1", "same tier may reuse the previous response");
  assert.equal(frames[2].previous_response_id, undefined, "different tier must start a fresh response chain");
  assert.equal(frames[3].previous_response_id, "resp-3");
});
