/* Dito Web UI 前端 —— Xiaomi MiMo 设计语言（浅色暖调） */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 桌面版标识：Electron 壳加载时会带 ?desktop=1
if (new URLSearchParams(location.search).has("desktop")) {
  const badge = $(".brand-badge");
  if (badge) badge.textContent = "DESKTOP";
}

// ── SVG 图标（替代 emoji） ────────────────────────────────
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  model: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>`,
  persona: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>`,
  kb: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>`,
  memory: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><path d="M12 3a4 4 0 0 0-4 4 4 4 0 0 0-2 7 4 4 0 0 0 2 7 4 4 0 0 0 8 0 4 4 0 0 0 2-7 4 4 0 0 0-2-7 4 4 0 0 0-4-4z"/><circle cx="12" cy="11" r="2"/></svg>`,
  search: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  voice: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 24 24" ${stroke}><path d="M12 5v14M5 12h14"/></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 24 24" ${stroke}><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" ${stroke}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>`,
  edit: `<svg width="12" height="12" viewBox="0 0 24 24" ${stroke}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" ${stroke}><path d="M20 6 9 17l-5-5"/></svg>`,
  send: `<svg width="15" height="15" viewBox="0 0 24 24" ${stroke}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/></svg>`,
  trace: `<svg width="13" height="13" viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  tool: `<svg width="12" height="12" viewBox="0 0 24 24" ${stroke}><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 10.4 5.2 7.3 4.3l-.9 2.9 2 2.1a4 4 0 0 0 5 5l-2.2 2.2a4 4 0 0 0 5 5L18.4 19l-1.6-1.6 1.5-1.5 1.6 1.6 2.2-2.2a4 4 0 0 0-5-5l-2.1 2z"/></svg>`,
  ok: `<svg width="12" height="12" viewBox="0 0 24 24" ${stroke}><path d="M20 6 9 17l-5-5"/></svg>`,
  mode: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><path d="M4 6h16M4 12h16M4 18h10"/></svg>`,
  permission: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/><path d="M9 12l2 2 4-4"/></svg>`,
  ask: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.8.3-1.4 1-1.4 1.7v.5"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/></svg>`,
  system: `<svg width="17" height="17" viewBox="0 0 24 24" ${stroke}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 7h6M7 10h10"/></svg>`,
};

// ── 全局状态 ──────────────────────────────────────────────
const state = {
  view: "chat",
  config: null,
  plugins: [],
  personas: [],
  identities: [],
  chatStream: null,
  chatBusy: false,
  mode: "standard",
  providerEditor: null,
};

// ── API 工具 ──────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `HTTP ${res.status}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

// ── 视图切换 ──────────────────────────────────────────────
function switchView(view) {
  state.view = view;
  $$(".ds-nav a").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "config") loadConfigForm();
  if (view === "kb") loadKb();
  if (view === "memory") loadMemoryStats();
  if (view === "chat") scrollChatBottom();
}
$$(".ds-nav a").forEach((n) => n.addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = n.dataset.view;
  switchView(n.dataset.view);
}));

// ── 聊天 ──────────────────────────────────────────────────
const chatScroll = $("#chat-scroll");
const chatMessages = $("#chat-messages");
const chatEmpty = $("#chat-empty");
const chatInput = $("#chat-input");
const chatSend = $("#chat-send");
const traceBody = $("#trace-body");
const traceCount = $("#trace-count");

function scrollChatBottom() { chatScroll.scrollTop = chatScroll.scrollHeight; }

function addUserMsg(text) {
  chatEmpty.classList.add("hidden");
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="msg-meta">你</div><div class="msg-bubble">${esc(text)}</div>`;
  chatMessages.appendChild(el);
  scrollChatBottom();
}

function addAssistantMsg() {
  chatEmpty.classList.add("hidden");
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="msg-meta">蒂特</div><div class="thinking" style="display:none"></div><div class="msg-bubble"><span class="typing">思考中</span></div>`;
  chatMessages.appendChild(el);
  scrollChatBottom();
  return el;
}

function ensureTraceEmpty() {
  traceBody.innerHTML = "";
  const el = document.createElement("div");
  el.className = "trace-empty";
  el.textContent = "本轮还没有工具调用，开始对话后这里会记录每一步";
  traceBody.appendChild(el);
}
ensureTraceEmpty();

function addTrace(info) {
  const el = document.createElement("div");
  el.className = `trace-item ${info.cls || ""}`;
  el.innerHTML = `<span class="t-name">${info.icon || ""} ${esc(info.name)}</span>` + (info.detail ? ` <span class="t-args">${esc(info.detail)}</span>` : "");
  traceBody.appendChild(el);
  traceCount.textContent = traceBody.querySelectorAll(".trace-item").length;
  traceBody.scrollTop = traceBody.scrollHeight;
}

function clearTraces() {
  traceBody.innerHTML = "";
  traceCount.textContent = "0";
  ensureTraceEmpty();
}

function closeStream() {
  if (state.chatStream) { state.chatStream.close(); state.chatStream = null; }
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || state.chatBusy) return;
  state.chatBusy = true;
  chatSend.disabled = true;
  chatInput.value = "";
  chatInput.style.height = "auto";
  clearTraces();
  addUserMsg(text);
  const assistantEl = addAssistantMsg();
  const bubble = $(".msg-bubble", assistantEl);
  const thinkingEl = $(".thinking", assistantEl);
  bubble.innerHTML = "";

  closeStream();
  state.chatStream = new EventSource("/api/chat/stream");
  let done = false;

  const finish = () => {
    done = true;
    state.chatBusy = false;
    chatSend.disabled = false;
    closeStream();
    if (!bubble.textContent.trim()) bubble.innerHTML = "（无回复）";
    if (thinkingEl && !thinkingEl.textContent.trim()) thinkingEl.style.display = "none";
    scrollChatBottom();
  };

  state.chatStream.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    handleChatEvent(e, assistantEl, { bubble, thinkingEl, finish });
  };
  state.chatStream.onerror = () => { state.chatStream.close(); if (!done) finish(); };

  try {
    await api("/api/chat", { method: "POST", body: JSON.stringify({ text }) });
  } catch (err) {
    if (!done) { finish(); bubble.innerHTML = `<span style="color:#ff7a70">发送失败：${esc(err.message)}</span>`; }
  }
}

function handleChatEvent(e, assistantEl, { bubble, thinkingEl, finish }) {
  switch (e.type) {
    case "greeting":
    case "turn_start":
      return;
    case "thinking_start":
      thinkingEl.style.display = "block";
      thinkingEl.innerHTML = `<div class="th-label">思考中</div>`;
      return;
    case "thinking_delta":
      thinkingEl.style.display = "block";
      thinkingEl.insertAdjacentHTML("beforeend", esc(e.delta));
      return;
    case "thinking_end":
      if (!thinkingEl.textContent.trim()) thinkingEl.style.display = "none";
      thinkingEl.style.opacity = "0.55";
      return;
    case "text_delta":
      thinkingEl.style.display = "none";
      bubble.insertAdjacentHTML("beforeend", esc(e.delta));
      scrollChatBottom();
      return;
    case "tool_start":
      addTrace({ cls: "exec", icon: ICONS.tool, name: `${e.toolName}`, detail: summarizeArgs(e.args) });
      return;
    case "tool_end":
      addTrace({ cls: e.isError ? "error" : "done", icon: ICONS.ok, name: `${e.toolName}` + (e.isError ? " 失败" : " 完成"), detail: summarizeResult(e.result) });
      return;
    case "error":
      bubble.insertAdjacentHTML("beforeend", `<span style="color:#ff7a70">${esc(e.message)}</span>`);
      return;
    case "done":
      finish();
      return;
  }
}

function summarizeArgs(args) {
  if (args == null) return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? flat.slice(0, 100) + "…" : flat;
}
function summarizeResult(r) {
  if (r == null) return "";
  let s = "";
  if (typeof r === "string") s = r;
  else if (Array.isArray(r)) s = JSON.stringify(r);
  else if (typeof r === "object") s = r.text || r.content || JSON.stringify(r);
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > 100 ? flat.slice(0, 100) + "…" : flat;
}

chatSend.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});

$("#btn-new-session").addEventListener("click", async () => {
  await api("/api/session/new", { method: "POST" }).catch(() => {});
  chatMessages.innerHTML = "";
  chatEmpty.classList.remove("hidden");
  clearTraces();
  loadStatus();
});

// 模式切换
const MODE_HINTS = { chat: "轻松聊天 · 不调用工具", standard: "完整助手 · 全部工具", plan: "只读探索 · 产出计划" };
const MODE_LABELS = { chat: "闲聊", standard: "标准", plan: "计划" };
$$(".chip").forEach((chip) => chip.addEventListener("click", async () => {
  const mode = chip.dataset.mode;
  $$(".chip").forEach((c) => c.classList.toggle("active", c === chip));
  state.mode = mode;
  $("#mode-hint").textContent = MODE_HINTS[mode];
  $("#composer-mode").textContent = MODE_LABELS[mode];
  await api("/api/mode", { method: "POST", body: JSON.stringify({ mode }) }).catch(() => {});
}));

// 顶部状态
async function loadStatus() {
  try {
    const s = await api("/api/status");
    $("#chat-model-name").textContent = s.modelName || "未选模型";
    $("#header-model").textContent = s.modelName || "未选模型";
  } catch { /* ignore */ }
}

// ── 配置表单 ──────────────────────────────────────────────
const configRoot = $("#config-root");
const configLoading = $("#config-loading");

async function loadConfigForm() {
  configLoading.classList.remove("hidden");
  configRoot.classList.add("hidden");
  try {
    const [cfg, personas, identities, pluginInfo] = await Promise.all([
      api("/api/config"),
      api("/api/personas"),
      api("/api/identities"),
      api("/api/plugins"),
    ]);
    state.config = cfg;
    state.personas = personas;
    state.identities = identities;
    state.plugins = pluginInfo.plugins || [];
    renderConfig();
  } catch (err) {
    configLoading.textContent = `载入失败：${err.message}`;
  } finally {
    configLoading.classList.add("hidden");
    configRoot.classList.remove("hidden");
  }
}

$("#config-reload").addEventListener("click", loadConfigForm);
$("#config-save").addEventListener("click", saveConfig);

function renderConfig() {
  const c = state.config;
  configRoot.innerHTML = `
    <div class="config-section">
      <div class="sec-title"><p class="ds-section-label">Plugins</p><h2>插件总览</h2></div>
      <div class="ds-grid-plugins">
        ${(state.plugins || []).map((p) => pluginCardDynamic(p)).join("")}
      </div>
    </div>

    <div class="config-section">
      <div class="sec-title"><p class="ds-section-label">Model &amp; Provider</p><h2>模型与供应商</h2></div>
      <div class="ds-card">${renderModelSection()}</div>
    </div>

    <div class="config-section">
      <div class="sec-title"><p class="ds-section-label">Persona</p><h2>提示词设定</h2></div>
      <div class="ds-card">${renderPersonaSection()}</div>
    </div>

    <div class="config-section">
      <div class="sec-title"><p class="ds-section-label">Knowledge Base</p><h2>知识库</h2></div>
      <div class="ds-card">${renderKbSection()}</div>
    </div>

    <div class="config-section">
      <div class="sec-title"><p class="ds-section-label">Memory</p><h2>记忆</h2></div>
      <div class="ds-card">${renderMemorySection()}</div>
    </div>

    <div class="config-section">
      <div class="sec-title"><p class="ds-section-label">Web Search</p><h2>网络搜索</h2></div>
      <div class="ds-card">${renderSearchSection()}</div>
    </div>

    <div class="config-section">
      <div class="sec-title"><p class="ds-section-label">Voice</p><h2>语音</h2></div>
      <div class="ds-card">${renderVoiceSection()}</div>
    </div>

    <div class="config-section">
      <div class="sec-title"><p class="ds-section-label">Permission</p><h2>权限与 sudo</h2></div>
      <div class="ds-card">${renderPermissionSection()}</div>
    </div>
  `;
  bindConfigEvents();
}

function pluginCardDynamic(p) {
  const icon = ICONS[p.icon] || ICONS.model;
  const checked = p.enabled !== false;
  const section = state.config.plugins?.[p.id];
  const extra = p.dependencies?.length
    ? `<div style="font-size:11px;color:var(--ds-color-text-placeholder);font-family:var(--ds-font-mono);margin-top:4px">DEPENDS ON ${p.dependencies.map(esc).join(", ")}</div>`
    : "";
  const badge = p.alwaysOn
    ? `<span style="font-size:11px;color:var(--ds-color-text-placeholder);font-family:var(--ds-font-mono)">ALWAYS ON</span>`
    : `<label class="ds-switch" title="启用 / 停用插件">
        <input type="checkbox" data-plugin-enable="${esc(p.id)}" ${checked ? "checked" : ""}/>
        <span class="slider"></span>
      </label>`;
  return `<div class="plugin-card" data-plugin-card="${esc(p.id)}">
    <div class="pc-head">
      <div class="pc-icon">${icon}</div>
      <div style="min-width:0"><div class="pc-title">${esc(p.name)}</div><div class="pc-sub">${esc(p.description)}</div>${extra}</div>
      <div class="pc-right">${badge}</div>
    </div>
  </div>`;
}

function provModels() {
  const c = state.config;
  const p = c.providers.find((x) => x.id === c.model.provider) || c.providers[0];
  return p ? p.models : [];
}

function renderModelSection() {
  const c = state.config;
  const provs = c.providers.map((p, i) => `
    <div class="provider-item ${p.id === c.model.provider ? "active-p" : ""}">
      <div style="flex:1;min-width:0">
        <div>
          <span class="p-name">${esc(p.name)}</span><span class="p-id">${esc(p.id)}</span>
          ${p.id === c.model.provider ? '<span class="p-badge">CURRENT</span>' : ""}
        </div>
        <div class="p-models">${esc(p.models.map((m) => m.id).join(", ") || "无模型")}</div>
      </div>
      <div class="p-actions">
        <button class="ds-btn ds-btn-secondary ds-btn-sm" data-prov-use="${esc(p.id)}">设为当前</button>
        <button class="ds-btn ds-btn-ghost ds-btn-sm" data-prov-edit="${i}">编辑</button>
        <button class="ds-btn ds-btn-danger ds-btn-sm" data-prov-del="${i}">${ICONS.trash}</button>
      </div>
    </div>`).join("");

  const models = provModels();
  const chatOpts = models.map((m) => `<option value="${esc(m.id)}" ${m.id === c.model.chat ? "selected" : ""}>${esc(m.name || m.id)} (${esc(m.id)})</option>`).join("");
  const visionOpts = models.filter((m) => (m.input || []).includes("image")).map((m) => `<option value="${esc(m.id)}" ${m.id === c.model.vision ? "selected" : ""}>${esc(m.name || m.id)}</option>`).join("");

  return `
    <div class="provider-list">${provs}</div>
    <button class="ds-btn ds-btn-secondary ds-btn-sm" data-prov-add>${ICONS.plus} 新增供应商</button>
    <div id="provider-editor-slot"></div>
    <div class="ds-two-cols" style="margin-top:14px">
      <div class="ds-field"><label>聊天模型</label><select class="ds-select" data-model-chat>${chatOpts}</select></div>
      <div class="ds-field"><label>视觉模型</label><select class="ds-select" data-model-vision>${visionOpts || '<option value="">（无视觉模型）</option>'}</select></div>
    </div>
    <button class="ds-btn ds-btn-ghost ds-btn-sm" data-model-refresh style="margin-top:12px">${ICONS.refresh} 从 API 刷新当前供应商模型列表</button>
    <span id="model-refresh-msg" class="save-flash"></span>`;
}

function renderProviderEditor(p) {
  const modelRows = p.models.map((m, i) => {
    const vision = (m.input || []).includes("image");
    const reasoning = !!m.reasoning;
    return `
    <tr data-mrow="${i}">
      <td><input type="text" class="ds-input" data-mid="${i}" value="${esc(m.id)}" style="min-width:130px"/></td>
      <td><input type="text" class="ds-input" data-mname="${i}" value="${esc(m.name || m.id)}" style="min-width:110px"/></td>
      <td style="min-width:100px">
        <label class="check"><input type="checkbox" data-mvis="${i}" ${vision ? "checked" : ""}/>视觉</label>
        <label class="check"><input type="checkbox" data-mreason="${i}" ${reasoning ? "checked" : ""}/>推理</label>
      </td>
      <td><input type="number" class="ds-input" data-mctx="${i}" value="${m.contextWindow || 128000}" style="min-width:90px"/></td>
      <td><input type="number" class="ds-input" data-mmax="${i}" value="${m.maxTokens || 16384}" style="min-width:90px"/></td>
      <td><button class="ds-btn ds-btn-danger ds-btn-sm" data-mdel="${i}">${ICONS.trash}</button></td>
    </tr>`;
  }).join("");

  return `
    <div class="provider-editor">
      <div class="ds-two-cols">
        <div class="ds-field"><label>ID</label><input type="text" class="ds-input" id="pedit-id" value="${esc(p.id)}"/></div>
        <div class="ds-field"><label>名称</label><input type="text" class="ds-input" id="pedit-name" value="${esc(p.name)}"/></div>
        <div class="ds-field"><label>Base URL</label><input type="text" class="ds-input" id="pedit-base" value="${esc(p.baseUrl)}"/></div>
        <div class="ds-field"><label>API Key（支持 $ENV_VAR 引用）</label><input type="text" class="ds-input" id="pedit-key" value="${esc(p.apiKey)}"/></div>
        <div class="ds-field"><label>API 类型</label>
          <select class="ds-select" id="pedit-api">
            <option value="openai-completions" ${p.api === "openai-completions" ? "selected" : ""}>OpenAI Completions</option>
            <option value="anthropic-messages" ${p.api === "anthropic-messages" ? "selected" : ""}>Anthropic Messages</option>
            <option value="openai-responses" ${p.api === "openai-responses" ? "selected" : ""}>OpenAI Responses</option>
          </select>
        </div>
      </div>
      <div class="ds-field">
        <label>模型列表（可编辑每个模型的 id / 名称 / 能力 / 上下文 / 最大输出）</label>
        <table class="model-table">
          <thead><tr><th>ID</th><th>名称</th><th>能力</th><th>上下文</th><th>最大输出</th><th></th></tr></thead>
          <tbody>${modelRows}</tbody>
        </table>
        <button class="ds-btn ds-btn-ghost ds-btn-sm" data-madd style="margin-top:8px">${ICONS.plus} 添加模型行</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="ds-btn ds-btn-primary ds-btn-sm" data-pedit-save>保存供应商</button>
        <button class="ds-btn ds-btn-ghost ds-btn-sm" data-pedit-cancel>取消</button>
      </div>
    </div>`;
}

function renderPersonaSection() {
  const c = state.config;
  const nameOf = (p) => (typeof p === "string" ? p : p?.name || "");
  const personas = state.personas.map((p) => `<option value="${esc(nameOf(p))}" ${nameOf(p) === c.persona.active ? "selected" : ""}>${esc(nameOf(p))}</option>`).join("");
  const identities = state.identities.map((p) => `<option value="${esc(nameOf(p))}" ${nameOf(p) === c.persona.identity ? "selected" : ""}>${esc(nameOf(p))}</option>`).join("");
  return `
    <p class="ds-hint">选择 Dito 的 AI 人格与当前用户身份，保存后立即生效。</p>
    <div class="ds-two-cols">
      <div class="ds-field"><label>AI 人格</label><select class="ds-select" data-persona>${personas || '<option>（无）</option>'}</select></div>
      <div class="ds-field"><label>用户身份</label><select class="ds-select" data-identity>${identities || '<option>（无）</option>'}</select></div>
    </div>`;
}

function renderKbSection() {
  const k = state.config.plugins.knowledge_base;
  return `
    <div class="ds-two-cols">
      <div class="ds-field"><label>数据目录 <span class="key">（空 = 默认 ~/.pi/agent/dito）</span></label><input type="text" class="ds-input" data-kb-dir value="${esc(k.dataDir)}"/></div>
    </div>`;
}

function renderMemorySection() {
  const m = state.config.plugins.memory;
  return `
    <div class="ds-field" style="display:flex;align-items:center;gap:14px">
      <label style="flex:1">自动日记 <span class="key">（每轮对话后把用户消息与回复写入短日记）</span></label>
      <label class="ds-switch"><input type="checkbox" data-memory-autodiary ${m.autoDiary ? "checked" : ""}/><span class="slider"></span></label>
    </div>`;
}

function renderSearchSection() {
  const w = state.config.plugins.web_search;
  const keyField = (label, val, data, placeholder) => `<div class="ds-field"><label>${label}</label><input type="text" class="ds-input" data-${data} value="${esc(val)}" placeholder="${placeholder}"/></div>`;
  return `
    <p class="ds-hint">不配任何 key 时自动使用 DuckDuckGo。填入 key 后按 Tavily → Firecrawl → AnySearch → Exa → Perplexity → SearXNG 顺序尝试。</p>
    <div class="ds-two-cols">
      ${keyField("Tavily Key（逗号分隔）", w.tavilyKeys.join(","), "ws-tavily", "多个 key 用逗号分隔")}
      ${keyField("Firecrawl Key", w.firecrawlKeys.join(","), "ws-firecrawl", "多个 key 用逗号分隔")}
      ${keyField("AnySearch Key", w.anysearchKeys.join(","), "ws-anysearch", "多个 key 用逗号分隔")}
      ${keyField("Exa Key", w.exaKeys.join(","), "ws-exa", "多个 key 用逗号分隔")}
      ${keyField("Perplexity Key", w.perplexityKey, "ws-perplexity", "")}
      <div class="ds-field"><label>SearXNG 地址</label><input type="text" class="ds-input" data-ws-searxng value="${esc(w.searxngUrl)}" placeholder="https://searxng.example.com"/></div>
    </div>`;
}

function renderVoiceSection() {
  const v = state.config.plugins.voice;
  const sel = (data, val, opts) => `<select class="ds-select" data-${data}>${opts.map(([value, label]) => `<option value="${value}" ${val === value ? "selected" : ""}>${label}</option>`).join("")}</select>`;
  return `
    <div class="ds-two-cols">
      <div class="ds-field"><label>唤醒词 <span class="key">（空 = 关闭）</span></label><input type="text" class="ds-input" data-v-wake value="${esc(v.wakeWord)}"/></div>
      <div class="ds-field"><label>STT 后端</label>${sel("v-stt", v.stt, [["whisper", "whisper（本地）"], ["xiaomi", "xiaomi（小米 MiMo ASR）"], ["custom", "custom（自定义命令）"]])}</div>
      <div class="ds-field"><label>TTS 后端</label>${sel("v-tts", v.tts, [["espeak", "espeak（本地）"], ["piper", "piper（本地）"], ["xiaomi", "xiaomi（小米 MiMo TTS）"], ["custom", "custom（自定义命令）"]])}</div>
      <div class="ds-field"><label>whisper 模型路径</label><input type="text" class="ds-input" data-v-whisper-model value="${esc(v.whisperModel)}"/></div>
      <div class="ds-field"><label>whisper 语言</label><input type="text" class="ds-input" data-v-whisper-lang value="${esc(v.whisperLanguage)}"/></div>
      <div class="ds-field"><label>espeak 音色</label><input type="text" class="ds-input" data-v-espeak-voice value="${esc(v.espeakVoice)}"/></div>
      <div class="ds-field"><label>piper 模型</label><input type="text" class="ds-input" data-v-piper-model value="${esc(v.piperModel)}"/></div>
      <div class="ds-field"><label>piper Config</label><input type="text" class="ds-input" data-v-piper-config value="${esc(v.piperConfig)}"/></div>
      <div class="ds-field"><label>小米 API Key</label><input type="text" class="ds-input" data-v-xiaomi-key value="${esc(v.xiaomiApiKey)}"/></div>
      <div class="ds-field"><label>小米 Base URL</label><input type="text" class="ds-input" data-v-xiaomi-base value="${esc(v.xiaomiBaseUrl)}"/></div>
      <div class="ds-field"><label>小米 ASR 模型</label><input type="text" class="ds-input" data-v-xiaomi-asr value="${esc(v.xiaomiAsrModel)}"/></div>
      <div class="ds-field"><label>小米 TTS 模型</label><input type="text" class="ds-input" data-v-xiaomi-tts-model value="${esc(v.xiaomiTtsModel)}"/></div>
      <div class="ds-field"><label>小米 TTS 音色</label><input type="text" class="ds-input" data-v-xiaomi-tts-voice value="${esc(v.xiaomiTtsVoice)}"/></div>
      <div class="ds-field"><label>自定义 STT 命令</label><input type="text" class="ds-input" data-v-stt-cmd value="${esc(v.customSttCommand)}" placeholder="如：whisper-cli -f {{file}}"/></div>
      <div class="ds-field"><label>自定义 TTS 命令</label><input type="text" class="ds-input" data-v-tts-cmd value="${esc(v.customTtsCommand)}" placeholder="如：piper -m zh -f {{file}}"/></div>
      <div class="ds-field"><label>最大录音秒数</label><input type="number" class="ds-input" data-v-maxrec value="${v.maxRecordSeconds}" min="1" max="120"/></div>
      <div class="ds-field"><label>问句自动听回答</label><label class="ds-switch"><input type="checkbox" data-v-autoq ${v.autoListenAfterQuestion ? "checked" : ""}/><span class="slider"></span></label></div>
      <div class="ds-field"><label>连续对话</label><label class="ds-switch"><input type="checkbox" data-v-continuous ${v.continuous ? "checked" : ""}/><span class="slider"></span></label></div>
    </div>`;
}

function renderPermissionSection() {
  const p = state.config.plugins.permission || { enabled: true, sudoMode: false, autoSudo: true, sudoCommand: "sudo" };
  const field = (label, data, val, extra) => `<div class="ds-field"><label>${label}${extra || ""}</label><input type="text" class="ds-input" data-${data} value="${esc(val)}"/></div>`;
  return `
    <p class="ds-hint">默认开启权限门：fork bomb / rm -rf / / mkfs 直接拦截，危险操作弹确认。开启「sudo 权限模式」后<strong>权限门关闭</strong>，Dito 获得 sudo 权限——需要 root 的命令（安装/卸载软件、管理服务、挂载、分区格式化等）自动在前面加 sudo。</p>
    <div class="ds-two-cols">
      <div class="ds-field" style="display:flex;align-items:center;gap:14px">
        <label style="flex:1">sudo 权限模式 <span class="key">（关闭权限门 + 自动加 sudo）</span></label>
        <label class="ds-switch"><input type="checkbox" data-p-sudo-mode ${p.sudoMode ? "checked" : ""}/><span class="slider"></span></label>
      </div>
      <div class="ds-field" style="display:flex;align-items:center;gap:14px">
        <label style="flex:1">自动为需要 root 的命令加 sudo</label>
        <label class="ds-switch"><input type="checkbox" data-p-auto-sudo ${p.autoSudo !== false ? "checked" : ""}/><span class="slider"></span></label>
      </div>
      ${field("提权命令", "p-sudo-cmd", p.sudoCommand || "sudo", ' <span class="key">（默认 sudo，可改 doas / sudo -n）</span>')}
    </div>`;
}

// ── 配置事件绑定 ──────────────────────────────────────────
function bindConfigEvents() {
  $$("[data-plugin-enable]").forEach((sw) => sw.addEventListener("change", (e) => {
    state.config.plugins[e.target.dataset.pluginEnable].enabled = e.target.checked;
  }));

  const chatSel = $("[data-model-chat]");
  const visionSel = $("[data-model-vision]");
  if (chatSel) chatSel.addEventListener("change", () => { state.config.model.chat = chatSel.value; });
  if (visionSel) visionSel.addEventListener("change", () => { state.config.model.vision = visionSel.value; });

  $("[data-prov-add]")?.addEventListener("click", () => {
    const p = { id: "custom", name: "自定义", baseUrl: "", apiKey: "", api: "openai-completions", models: [] };
    state.config.providers.push(p);
    state.providerEditor = "new";
    renderConfig();
    openProviderEditor();
  });

  $$("[data-prov-use]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.provUse;
    state.config.model.provider = id;
    const msg = $("#model-refresh-msg");
    msg.textContent = "正在获取模型列表";
    try {
      const r = await api(`/api/providers/${encodeURIComponent(id)}/refresh-models`, { method: "POST" });
      if (r?.updated) {
        const p = state.config.providers.find((x) => x.id === id);
        p.models = r.models;
        if (p.models.length) {
          state.config.model.chat = p.models[0].id;
          state.config.model.vision = (p.models.find((m) => (m.input || []).includes("image")) || p.models[0]).id;
        }
        msg.textContent = `已更新 ${r.models.length} 个模型`;
      } else msg.textContent = "获取失败，保留已有列表";
    } catch (e) { msg.textContent = "获取失败：" + e.message; }
    renderConfig();
  }));

  $$("[data-prov-edit]").forEach((b) => b.addEventListener("click", () => {
    state.providerEditor = Number(b.dataset.provEdit);
    renderConfig();
    openProviderEditor();
  }));

  $$("[data-prov-del]").forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.provDel);
    if (!confirm(`删除供应商「${state.config.providers[i].name}」？`)) return;
    const id = state.config.providers[i].id;
    state.config.providers.splice(i, 1);
    if (state.config.model.provider === id) state.config.model.provider = state.config.providers[0]?.id || "";
    renderConfig();
  }));

  $("[data-model-refresh]")?.addEventListener("click", async () => {
    const id = state.config.model.provider;
    const msg = $("#model-refresh-msg");
    msg.textContent = "正在获取模型列表";
    try {
      const r = await api(`/api/providers/${encodeURIComponent(id)}/refresh-models`, { method: "POST" });
      if (r?.updated) {
        const p = state.config.providers.find((x) => x.id === id);
        p.models = r.models;
        msg.textContent = `已更新 ${r.models.length} 个模型`;
      } else msg.textContent = "获取失败（离线或缺少 Key），保留已有列表";
    } catch (e) { msg.textContent = "获取失败：" + e.message; }
    renderConfig();
  });

  $("[data-persona]")?.addEventListener("change", (e) => { state.config.persona.active = e.target.value; });
  $("[data-identity]")?.addEventListener("change", (e) => { state.config.persona.identity = e.target.value; });

  $("[data-kb-dir]")?.addEventListener("input", (e) => { state.config.plugins.knowledge_base.dataDir = e.target.value; });
  $("[data-memory-autodiary]")?.addEventListener("change", (e) => { state.config.plugins.memory.autoDiary = e.target.checked; });

  const wsMap = {
    "ws-tavily": (v) => state.config.plugins.web_search.tavilyKeys = v.split(",").map((s) => s.trim()).filter(Boolean),
    "ws-firecrawl": (v) => state.config.plugins.web_search.firecrawlKeys = v.split(",").map((s) => s.trim()).filter(Boolean),
    "ws-anysearch": (v) => state.config.plugins.web_search.anysearchKeys = v.split(",").map((s) => s.trim()).filter(Boolean),
    "ws-exa": (v) => state.config.plugins.web_search.exaKeys = v.split(",").map((s) => s.trim()).filter(Boolean),
    "ws-perplexity": (v) => state.config.plugins.web_search.perplexityKey = v.trim(),
    "ws-searxng": (v) => state.config.plugins.web_search.searxngUrl = v.trim(),
  };
  Object.entries(wsMap).forEach(([key, fn]) => {
    $(`[data-${key}]`)?.addEventListener("input", (e) => fn(e.target.value));
  });

  const vMap = {
    "v-wake": (v) => state.config.plugins.voice.wakeWord = v,
    "v-stt": (v) => state.config.plugins.voice.stt = v,
    "v-tts": (v) => state.config.plugins.voice.tts = v,
    "v-whisper-model": (v) => state.config.plugins.voice.whisperModel = v,
    "v-whisper-lang": (v) => state.config.plugins.voice.whisperLanguage = v,
    "v-espeak-voice": (v) => state.config.plugins.voice.espeakVoice = v,
    "v-piper-model": (v) => state.config.plugins.voice.piperModel = v,
    "v-piper-config": (v) => state.config.plugins.voice.piperConfig = v,
    "v-xiaomi-key": (v) => state.config.plugins.voice.xiaomiApiKey = v,
    "v-xiaomi-base": (v) => state.config.plugins.voice.xiaomiBaseUrl = v,
    "v-xiaomi-asr": (v) => state.config.plugins.voice.xiaomiAsrModel = v,
    "v-xiaomi-tts-model": (v) => state.config.plugins.voice.xiaomiTtsModel = v,
    "v-xiaomi-tts-voice": (v) => state.config.plugins.voice.xiaomiTtsVoice = v,
    "v-stt-cmd": (v) => state.config.plugins.voice.customSttCommand = v,
    "v-tts-cmd": (v) => state.config.plugins.voice.customTtsCommand = v,
    "v-maxrec": (v) => state.config.plugins.voice.maxRecordSeconds = parseInt(v, 10) || 8,
  };
  Object.entries(vMap).forEach(([key, fn]) => {
    $(`[data-${key}]`)?.addEventListener("input", (e) => fn(e.target.value.trim()));
  });
  $("[data-v-autoq]")?.addEventListener("change", (e) => { state.config.plugins.voice.autoListenAfterQuestion = e.target.checked; });
  $("[data-v-continuous]")?.addEventListener("change", (e) => { state.config.plugins.voice.continuous = e.target.checked; });

  const perm = state.config.plugins.permission || { sudoMode: false, autoSudo: true, sudoCommand: "sudo" };
  $("[data-p-sudo-mode]")?.addEventListener("change", (e) => { perm.sudoMode = e.target.checked; });
  $("[data-p-auto-sudo]")?.addEventListener("change", (e) => { perm.autoSudo = e.target.checked; });
  $("[data-p-sudo-cmd]")?.addEventListener("input", (e) => { perm.sudoCommand = e.target.value.trim() || "sudo"; });
}

function openProviderEditor() {
  const slot = $("#provider-editor-slot");
  if (!slot) return;
  const p = state.providerEditor === "new"
    ? state.config.providers[state.config.providers.length - 1]
    : state.config.providers[state.providerEditor];
  if (!p) return;
  const savedModels = [...p.models.map((m) => ({ ...m, input: [...(m.input || [])] }))];
  slot.innerHTML = renderProviderEditor(p);

  const finish = (save) => {
    if (save) {
      p.id = $("#pedit-id").value.trim() || "custom";
      p.name = $("#pedit-name").value.trim() || p.id;
      p.baseUrl = $("#pedit-base").value.trim();
      p.apiKey = $("#pedit-key").value.trim();
      p.api = $("#pedit-api").value;
      const models = [];
      $$("[data-mid]").forEach((inp) => {
        const i = Number(inp.dataset.mid);
        const name = $(`[data-mname="${i}"]`)?.value.trim();
        const prev = savedModels[i] || {};
        const vision = $(`[data-mvis="${i}"]`)?.checked;
        const input = vision ? ["text", "image"] : (prev.input || ["text"]);
        const model = {
          id: inp.value.trim(),
          name: name || inp.value.trim(),
          reasoning: $(`[data-mreason="${i}"]`)?.checked ?? !!prev.reasoning,
          input,
          contextWindow: Number($(`[data-mctx="${i}"]`)?.value) || (prev.contextWindow || 128000),
          maxTokens: Number($(`[data-mmax="${i}"]`)?.value) || (prev.maxTokens || 16384),
        };
        if (prev.api) model.api = prev.api;
        if (prev.baseUrl) model.baseUrl = prev.baseUrl;
        models.push(model);
      });
      p.models = models.filter((m) => m.id);
      state.providerEditor = null;
    } else {
      const idx = state.config.providers.indexOf(p);
      state.config.providers[idx].models = savedModels;
      state.providerEditor = null;
    }
    renderConfig();
  };

  $("#pedit-save")?.addEventListener("click", () => finish(true));
  $("#pedit-cancel")?.addEventListener("click", () => finish(false));
  $$("[data-madd]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    const tbody = $(".model-table tbody");
    let i = 0;
    while ($$(`[data-mid="${i}"]`).length) i++;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="text" class="ds-input" data-mid="${i}" value="" style="min-width:130px"/></td>
      <td><input type="text" class="ds-input" data-mname="${i}" value="" style="min-width:110px"/></td>
      <td style="min-width:100px">
        <label class="check"><input type="checkbox" data-mvis="${i}"/>视觉</label>
        <label class="check"><input type="checkbox" data-mreason="${i}"/>推理</label>
      </td>
      <td><input type="number" class="ds-input" data-mctx="${i}" value="128000" style="min-width:90px"/></td>
      <td><input type="number" class="ds-input" data-mmax="${i}" value="16384" style="min-width:90px"/></td>
      <td><button class="ds-btn ds-btn-danger ds-btn-sm" data-mdel="${i}">${ICONS.trash}</button></td>`;
    tbody.appendChild(row);
    attachMdel();
  }));
  attachMdel();
}

function attachMdel() {
  $$("[data-mdel]").forEach((b) => b.addEventListener("click", () => b.closest("tr").remove()));
}

async function saveConfig() {
  try {
    await api("/api/config", { method: "PUT", body: JSON.stringify(state.config) });
    const flash = $("#config-save-flash");
    flash.textContent = "已保存，改动即时生效";
    setTimeout(() => (flash.textContent = ""), 2600);
  } catch (err) {
    alert("保存失败：" + err.message);
  }
}

// ── 知识库 ────────────────────────────────────────────────
const kbList = $("#kb-list");
const kbDetail = $("#kb-detail");
const kbDetailTitle = $("#kb-detail-title");
let kbCurrent = null;

async function loadKb(keyword = "") {
  kbList.innerHTML = '<div class="loading">载入中</div>';
  try {
    const r = await api(`/api/kb?keyword=${encodeURIComponent(keyword)}`);
    renderKbStats(r.stats);
    const results = r.results || [];
    kbList.innerHTML = results.length
      ? results.map((it) => `<div class="item" data-kb-id="${it.id}">
          <span class="it-badge">${esc(it.source)}</span>
          <div class="it-title">${esc(it.title)}</div>
          <div class="it-sub">${esc(it.name)}</div>
        </div>`).join("")
      : '<div class="loading">没有匹配的条目</div>';
    $$("[data-kb-id]", kbList).forEach((el) => el.addEventListener("click", () => selectKb(el)));
  } catch (err) {
    kbList.innerHTML = `<div class="loading">载入失败：${esc(err.message)}</div>`;
  }
}

function renderKbStats(stats) {
  $("#kb-stats").innerHTML = `<div class="stat-pill">总条目 <b>${stats?.total ?? 0}</b></div>`;
}

async function selectKb(el) {
  $$(".item", kbList).forEach((n) => n.classList.remove("active"));
  el.classList.add("active");
  const id = el.dataset.kbId;
  kbCurrent = { id, title: el.querySelector(".it-title").textContent, name: el.querySelector(".it-sub").textContent };
  kbDetailTitle.textContent = `${kbCurrent.title} · ${kbCurrent.name}`;
  $("#kb-delete").classList.remove("hidden");
  try {
    const r = await api(`/api/kb/${id}`);
    kbDetail.textContent = r.content || "（无内容）";
  } catch (err) {
    kbDetail.textContent = "载入失败：" + err.message;
  }
}

$("#kb-search").addEventListener("input", (e) => loadKb(e.target.value));
$("#kb-refresh").addEventListener("click", () => loadKb($("#kb-search").value));
$("#kb-add-btn").addEventListener("click", () => {
  const title = prompt("新知识条目标题：");
  if (!title) return;
  const content = prompt("内容（支持 Markdown）：");
  if (content == null) return;
  api("/api/kb", { method: "POST", body: JSON.stringify({ title, content }) })
    .then(() => loadKb($("#kb-search").value))
    .catch((e) => alert("新增失败：" + e.message));
});
$("#kb-delete").addEventListener("click", async () => {
  if (!kbCurrent) return;
  if (!confirm(`删除「${kbCurrent.title}」？`)) return;
  await api(`/api/kb/${kbCurrent.id}`, { method: "DELETE" });
  kbCurrent = null;
  $("#kb-delete").classList.add("hidden");
  kbDetail.textContent = "";
  kbDetailTitle.textContent = "选择一个条目";
  loadKb($("#kb-search").value);
});

// ── 记忆 ──────────────────────────────────────────────────
async function loadMemoryStats() { await queryMemory(""); }
async function queryMemory(keyword) {
  try {
    const r = await api(`/api/memory?query=${encodeURIComponent(keyword)}`);
    $("#memory-stats").innerHTML = `<div class="stat-pill">知识点 <b>${r.facts}</b></div><div class="stat-pill">日记 <b>${r.episodes}</b></div>`;
    const list = $("#memory-list");
    const results = r.results || [];
    if (!keyword) {
      list.innerHTML = '<div class="loading">输入关键词回忆记忆，或查看上方统计。</div>';
      return;
    }
    list.innerHTML = results.length
      ? results.map((m) => `<div class="item">
          <span class="it-badge">${m.kind === "fact" ? "知识点" : "经历"}</span>
          <div class="it-title">${esc(m.snippet || m.content || "")}</div>
          <div class="it-sub">来源 ${esc(m.source)} · ${new Date(m.timestamp).toLocaleString("zh-CN")}</div>
        </div>`).join("")
      : '<div class="loading">没有回忆到相关记忆</div>';
  } catch (err) {
    $("#memory-list").innerHTML = `<div class="loading">载入失败：${esc(err.message)}</div>`;
  }
}
$("#memory-query").addEventListener("click", () => queryMemory($("#memory-search").value));
$("#memory-search").addEventListener("keydown", (e) => { if (e.key === "Enter") queryMemory(e.target.value); });
$("#memory-clear").addEventListener("click", async () => {
  if (!confirm("确定清空全部记忆（知识点 + 日记）？此操作不可恢复。")) return;
  await api("/api/memory", { method: "DELETE" });
  queryMemory($("#memory-search").value);
});

// ── 启动 ──────────────────────────────────────────────────
const initialHash = (location.hash || "#chat").replace("#", "");
switchView(["chat", "config", "kb", "memory", "about"].includes(initialHash) ? initialHash : "chat");
window.addEventListener("hashchange", () => {
  const h = location.hash.replace("#", "");
  if (["chat", "config", "kb", "memory", "about"].includes(h)) switchView(h);
});
loadStatus();
