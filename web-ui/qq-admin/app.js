/**
 * Dito QQ 管理后台前端（vanilla JS，无构建）。
 * REST + SSE（/api/*），8 个 tab。
 */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtTime = (t) => {
    const d = typeof t === "number" ? new Date(t * (t > 1e12 ? 1 : 1000)) : new Date(t ?? Date.now());
    return isNaN(d) ? "" : d.toLocaleString("zh", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  let status = null;
  let currentTab = "overview";
  let currentChatKey = null;
  let friends = [], groups = [];

  function toast(text) {
    const t = $("#toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.hidden = true), 2600);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── 导航 ────────────────────────────────────────────────────────
  const TABS = [
    ["overview", "总览", renderOverview],
    ["feed", "消息流", renderFeed],
    ["chats", "聊天", renderChats],
    ["friends", "好友", () => renderContacts("friends")],
    ["groups", "群列表", () => renderContacts("groups")],
    ["affinity", "好感度", renderAffinity],
    ["memes", "表情包", renderMemes],
    ["config", "配置", renderConfig],
    ["actions", "动作台", renderActions],
  ];
  function buildNav() {
    const nav = $("#nav");
    nav.innerHTML = "";
    for (const [id, label] of TABS) {
      const b = document.createElement("button");
      b.textContent = label;
      b.dataset.tab = id;
      b.onclick = () => switchTab(id);
      nav.appendChild(b);
    }
  }
  function switchTab(id) {
    currentTab = id;
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
    const tab = TABS.find(([t]) => t === id);
    $("#main").innerHTML = "";
    if (tab) tab[2]().catch((e) => ($("#main").innerHTML = `<div class="card">加载失败：${esc(e.message)}</div>`));
  }

  // ── 总览 ────────────────────────────────────────────────────────
  async function renderOverview() {
    status = await (await fetch("/api/status")).json();
    const s = status;
    const login = s.login || {};
    const up = Math.floor((s.uptimeMs ?? 0) / 60000);
    $("#main").innerHTML = `
      <h2>总览</h2>
      <div class="grid">
        <div class="cell"><div class="stat">${esc(login.nickname || (s.noBot ? "未启用" : "未连接"))}</div><div class="stat-label">登录号 ${esc(login.user_id ?? "-")}</div></div>
        <div class="cell"><div class="stat">${s.botConnected ? "在线" : "离线"}</div><div class="stat-label">SnowLuma · ${up} 分钟</div></div>
        <div class="cell"><div class="stat">${s.stats.memes}</div><div class="stat-label">表情包</div></div>
        <div class="cell"><div class="stat">${s.stats.affinityKeys}</div><div class="stat-label">好感度记录</div></div>
        <div class="cell"><div class="stat">${s.stats.sessions}</div><div class="stat-label">Dito 会话</div></div>
        <div class="cell"><div class="stat">${s.config.groups.length}</div><div class="stat-label">响应群数</div></div>
      </div>
      <div class="card">
        <h3>快捷开关（保存即时生效）</h3>
        <div class="form-row"><label>响应私聊</label><input type="checkbox" id="q-friends" ${s.config.friends ? "checked" : ""}></div>
        <div class="form-row"><label>戳一戳戳回去</label><input type="checkbox" id="q-poke" ${s.config.pokeBack ? "checked" : ""}></div>
        <div class="form-row"><label>自动表情回应</label><input type="checkbox" id="q-react" ${s.config.autoReact ? "checked" : ""}></div>
        <div class="form-row"><label>自动同意请求</label><input type="checkbox" id="q-approve" ${s.config.autoApprove ? "checked" : ""}></div>
        <button class="btn" id="quick-save">保存</button>
        <span class="muted" style="margin-left:10px">主人：${s.config.owners.map(esc).join("、") || "未配置"}</span>
      </div>`;
    $("#quick-save").onclick = async () => {
      await api("/api/config/qq", { method: "PATCH", body: JSON.stringify({
        friends: $("#q-friends").checked, pokeBack: $("#q-poke").checked,
        autoReact: $("#q-react").checked, autoApprove: $("#q-approve").checked,
      }) });
      toast("已保存");
    };
  }

  // ── 消息流（SSE） ───────────────────────────────────────────────
  let feedItems = [];
  async function renderFeed() {
    $("#main").innerHTML = `
      <h2>消息流 <span class="muted">（实时）</span></h2>
      <div class="form-row">
        <select id="feed-filter"><option value="">全部</option><option value="private">私聊</option><option value="group">群聊</option><option value="notice">通知</option><option value="request">请求</option></select>
        <button class="btn ghost" id="feed-clear">清空</button>
      </div>
      <div class="feed" id="feed"></div>`;
    const draw = () => {
      const f = $("#feed-filter").value;
      const items = f ? feedItems.filter((i) => i.kind === f) : feedItems;
      $("#feed").innerHTML = items.slice(-200).map((i) => `<div class="item"><div class="meta">${esc(i.meta)}</div>${esc(i.text)}</div>`).join("") || `<div class="muted">暂无事件，等一条 QQ 消息进来…</div>`;
    };
    $("#feed-filter").onchange = draw;
    $("#feed-clear").onclick = () => { feedItems = []; draw(); };
    draw();
  }
  function feedPush(kind, meta, text) {
    feedItems.push({ kind, meta, text });
    if (feedItems.length > 500) feedItems = feedItems.slice(-300);
    if (currentTab === "feed") {
      const f = $("#feed-filter")?.value;
      if (!f || f === kind) {
        const feed = $("#feed");
        if (feed) {
          const div = document.createElement("div");
          div.className = "item";
          div.innerHTML = `<div class="meta">${esc(meta)}</div>${esc(text)}`;
          feed.appendChild(div);
          while (feed.children.length > 200) feed.removeChild(feed.firstChild);
        }
      }
    }
  }

  // ── 聊天 ────────────────────────────────────────────────────────
  async function renderChats() {
    const { chats } = await api("/api/chats");
    $("#main").innerHTML = `
      <h2>聊天</h2>
      <div class="chat-wrap">
        <div class="chat-list" id="chat-list"></div>
        <div class="chat-body">
          <div class="chat-msgs" id="chat-msgs"><div class="muted">选择左侧会话查看记录</div></div>
          <div class="chat-input">
            <input id="chat-text" placeholder="手动发送消息到当前会话…">
            <button class="btn" id="chat-send" disabled>发送</button>
          </div>
        </div>
      </div>`;
    const list = $("#chat-list");
    list.innerHTML = chats.length ? chats.map((c) => {
      const isGroup = c.key.startsWith("qq-group-");
      return `<div class="chat-item" data-key="${esc(c.key)}">${isGroup ? "群" : "私"} ${esc(c.key.replace(/^qq-(private|group)-/, ""))}
        <div class="sub">${c.messages} 条 · ${esc(fmtTime(c.lastTs))}</div></div>`;
    }).join("") : `<div class="muted" style="padding:8px">暂无 Dito 会话（等一条消息进来）</div>`;
    list.querySelectorAll(".chat-item").forEach((el) => {
      el.onclick = () => {
        list.querySelectorAll(".chat-item").forEach((x) => x.classList.remove("active"));
        el.classList.add("active");
        currentChatKey = el.dataset.key;
        $("#chat-send").disabled = !status?.botConnected;
        loadHistory(currentChatKey);
      };
    });
    $("#chat-send").onclick = async () => {
      const input = $("#chat-text");
      if (!input.value.trim() || !currentChatKey) return;
      $("#chat-send").disabled = true;
      try {
        await api(`/api/chats/${currentChatKey}/send`, { method: "POST", body: JSON.stringify({ text: input.value.trim() }) });
        input.value = "";
        toast("已发送");
        setTimeout(() => loadHistory(currentChatKey), 800);
      } catch (e) { toast(`发送失败：${e.message}`); }
      $("#chat-send").disabled = false;
    };
  }
  async function loadHistory(key) {
    const box = $("#chat-msgs");
    box.innerHTML = `<div class="muted">加载中…</div>`;
    try {
      const data = await api(`/api/chats/${key}/history?limit=120`);
      const msgs = [];
      // Dito 会话（模型视角）
      for (const t of data.ditoTurns || []) msgs.push({ who: t.role === "user" ? "用户" : "Dito", role: t.role, text: t.text });
      // OneBot 原始记录（QQ 视角，补充私聊群聊里所有人的发言）
      const messages = data.onebot?.messages ?? [];
      for (const m of messages) {
        const who = m.sender?.card || m.sender?.nickname || String(m.sender?.user_id ?? m.user_id ?? "");
        const segs = Array.isArray(m.message) ? m.message : [];
        const text = segs.map((s) => (s.type === "text" ? s.data?.text ?? "" : s.type === "image" ? "[图片]" : s.type === "face" ? "[表情]" : `[${s.type}]`)).join("");
        if (text.trim()) msgs.push({ who, role: "other", text, ts: m.time });
      }
      msgs.sort((a, b) => 0); // 保持各自顺序拼接：先 OneBot 原始（时间序），后 Dito 会话
      box.innerHTML = msgs.length ? msgs.map((m) =>
        `<div class="msg ${m.role}">${m.who ? `<div class="who">${esc(m.who)}${m.ts ? " · " + esc(fmtTime(m.ts)) : ""}</div>` : ""}${esc(m.text.length > 800 ? m.text.slice(0, 800) + "…" : m.text)}</div>`
      ).join("") : `<div class="muted">暂无记录</div>`;
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      box.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
    }
  }

  // ── 好友 / 群 ───────────────────────────────────────────────────
  async function renderContacts(kind) {
    const isFriends = kind === "friends";
    $("#main").innerHTML = `<h2>${isFriends ? "好友" : "群列表"}</h2><div class="muted">加载中…</div>`;
    try {
      const data = await api(isFriends ? "/api/friends" : "/api/groups");
      const list = data.result || [];
      if (isFriends) {
        friends = list;
        $("#main").innerHTML = `<h2>好友（${list.length}）</h2>
          <div class="grid">${list.map((f) => `<div class="card"><b>${esc(f.nickname || f.remark || f.user_id)}</b><div class="muted">QQ ${esc(f.user_id)}${f.remark && f.remark !== f.nickname ? " · 备注 " + esc(f.remark) : ""}</div></div>`).join("") || '<div class="muted">空</div>'}</div>`;
      } else {
        groups = list;
        $("#main").innerHTML = `<h2>群列表（${list.length}）</h2>
          <div class="grid">${list.map((g) => `<div class="card"><b>${esc(g.group_name || g.group_id)}</b>
            <div class="muted">群号 ${esc(g.group_id)} · ${esc(g.member_count ?? "?")} 人</div>
            <div style="margin-top:8px"><button class="btn ghost" data-gid="${esc(g.group_id)}">成员列表</button></div></div>`).join("") || '<div class="muted">空</div>'}</div>
          <div id="members"></div>`;
        $("#main").querySelectorAll("button[data-gid]").forEach((b) => {
          b.onclick = () => showMembers(b.dataset.gid);
        });
      }
    } catch (e) {
      $("#main").innerHTML = `<div class="card">加载失败：${esc(e.message)}（SnowLuma 未连接？）</div>`;
    }
  }
  async function showMembers(gid) {
    const box = $("#members");
    box.innerHTML = `<div class="muted">加载成员中…</div>`;
    const data = await api(`/api/groups/${gid}/members`);
    const members = data.result || [];
    const aff = (await api("/api/affinity")).data;
    const owners = new Set(status?.config?.owners ?? []);
    box.innerHTML = `<h3>成员（${members.length}）</h3><table>
      <tr><th>QQ</th><th>名片/昵称</th><th>角色</th><th>好感度</th></tr>
      ${members.map((m) => {
        const score = aff[`${gid}:${m.user_id}`];
        return `<tr><td>${esc(m.user_id)}</td><td>${esc(m.card || m.nickname || "")}</td>
          <td>${m.role === "owner" ? '<span class="badge role-owner">群主</span>' : m.role === "admin" ? '<span class="badge role-owner">管理</span>' : ""}${owners.has(m.user_id) ? '<span class="badge owner">主人</span>' : ""}</td>
          <td>${score === undefined ? '<span class="muted">-</span>' : `<span class="badge ${score < 20 ? "low" : ""}">${score}</span>`}</td></tr>`;
      }).join("")}</table>`;
  }

  // ── 好感度 ──────────────────────────────────────────────────────
  async function renderAffinity() {
    const { data } = await api("/api/affinity");
    const entries = Object.entries(data);
    const byGroup = {};
    for (const [k, v] of entries) {
      const [gid, uid] = k.split(":");
      (byGroup[gid] ??= []).push([uid, v]);
    }
    const gname = (gid) => groups.find((g) => String(g.group_id) === gid)?.group_name || gid;
    $("#main").innerHTML = `
      <h2>好感度</h2>
      <div class="muted" style="margin-bottom:10px">低于 20 的群友消息会被频道忽略；改动即时落盘并热同步到 dito qq 进程。</div>
      ${entries.length === 0 ? '<div class="card muted">暂无记录（模型在群聊里用过 qq_affinity 后出现）</div>' :
        Object.entries(byGroup).map(([gid, list]) => `
          <div class="card"><h3>群 ${esc(gname(gid))}（${gid}）</h3><table>
            <tr><th>QQ</th><th>分数</th><th>调整</th></tr>
            ${list.map(([uid, v]) => `<tr>
              <td>${esc(uid)}${v < 20 ? ' <span class="badge low">将被忽略</span>' : ""}</td>
              <td><span id="aff-${gid}-${uid}">${v}</span>/100</td>
              <td>
                <button class="btn ghost" onclick="window.__aff('${gid}','${uid}',-5)">-5</button>
                <button class="btn ghost" onclick="window.__aff('${gid}','${uid}',5)">+5</button>
                <input id="affin-${gid}-${uid}" type="number" min="0" max="100" style="width:64px" value="${v}">
                <button class="btn ghost" onclick="window.__affset('${gid}','${uid}')">设定</button>
              </td></tr>`).join("")}
          </table></div>`).join("")}`;
    window.__aff = async (gid, uid, delta) => {
      const r = await api(`/api/affinity/${gid}/${uid}`, { method: "POST", body: JSON.stringify({ delta }) });
      $(`#aff-${gid}-${uid}`).textContent = r.value;
    };
    window.__affset = async (gid, uid) => {
      const v = Number($(`#affin-${gid}-${uid}`).value);
      if (!Number.isFinite(v)) return;
      const r = await api(`/api/affinity/${gid}/${uid}`, { method: "POST", body: JSON.stringify({ score: v }) });
      $(`#aff-${gid}-${uid}`).textContent = r.value;
    };
  }

  // ── 表情包 ──────────────────────────────────────────────────────
  async function renderMemes() {
    const { entries } = await api("/api/memes");
    $("#main").innerHTML = `
      <h2>表情包库（${entries.length}）</h2>
      <div class="memes">${entries.map((e) => `
        <div class="meme">
          <img loading="lazy" src="/api/memes/${esc(e.id)}/image" alt="">
          <button class="del" data-id="${esc(e.id)}">删除</button>
          <div class="info"><b>${esc(e.emotion)}</b> ${esc((e.tags || []).slice(0, 3).join(" "))}<br>${esc(e.desc || "")}<br><span class="muted">${esc(e.source)} · ${esc(fmtTime(e.addedAt))}</span></div>
        </div>`).join("") || '<div class="muted">库是空的：频道会自动偷表情包入库</div>'}
      </div>`;
    document.querySelectorAll(".meme .del").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("确定删除这张表情包？")) return;
        await api(`/api/memes/${b.dataset.id}`, { method: "DELETE" });
        toast("已删除");
        renderMemes();
      };
    });
  }

  // ── 配置 ────────────────────────────────────────────────────────
  async function renderConfig() {
    const { config } = await api("/api/config/qq");
    const list = (v) => (v || []).join(",");
    $("#main").innerHTML = `
      <h2>QQ 频道配置</h2>
      <div class="card">
        <div class="form-row"><label>SnowLuma 地址</label><input id="c-url" value="${esc(config.url)}" style="flex:1"></div>
        <div class="form-row"><label>启用频道</label><input type="checkbox" id="c-enabled" ${config.enabled ? "checked" : ""}></div>
        <div class="form-row"><label>自动拉起 SnowLuma</label><input type="checkbox" id="c-autostart" ${config.autoStart ? "checked" : ""}></div>
        <div class="form-row"><label>主人 QQ</label><input id="c-owners" value="${esc(list(config.owners))}" style="flex:1"><span class="muted">逗号分隔</span></div>
        <div class="form-row"><label>响应群号</label><input id="c-groups" value="${esc(list(config.groups))}" style="flex:1"><span class="muted">留空不响应任何群</span></div>
        <div class="form-row"><label>群聊唤醒词</label><input id="c-wake" value="${esc(list(config.wakeKeywords))}" style="flex:1"></div>
        <div class="form-row"><label>群聊回复概率</label><input id="c-chance" type="number" step="0.05" min="0" max="1" value="${config.groupReplyChance}"></div>
        <div class="form-row"><label>表情包概率</label><input id="c-meme" type="number" step="0.05" min="0" max="1" value="${config.memeChance}"></div>
        <div class="form-row"><label>响应私聊</label><input type="checkbox" id="c-friends" ${config.friends ? "checked" : ""}></div>
        <div class="form-row"><label>戳回去</label><input type="checkbox" id="c-poke" ${config.pokeBack ? "checked" : ""}></div>
        <div class="form-row"><label>自动表情回应</label><input type="checkbox" id="c-react" ${config.autoReact ? "checked" : ""}></div>
        <div class="form-row"><label>自动同意请求</label><input type="checkbox" id="c-approve" ${config.autoApprove ? "checked" : ""}></div>
        <button class="btn" id="c-save">保存</button>
        <span class="muted" style="margin-left:8px">写入 config.json；多数行为字段即时生效</span>
      </div>`;
    $("#c-save").onclick = async () => {
      const numList = (v) => v.split(/[,，\s]+/).map(Number).filter((n) => Number.isFinite(n) && n !== 0);
      await api("/api/config/qq", { method: "PATCH", body: JSON.stringify({
        enabled: $("#c-enabled").checked, autoStart: $("#c-autostart").checked,
        url: $("#c-url").value.trim(),
        owners: numList($("#c-owners").value), groups: numList($("#c-groups").value),
        wakeKeywords: $("#c-wake").value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
        groupReplyChance: Number($("#c-chance").value), memeChance: Number($("#c-meme").value),
        friends: $("#c-friends").checked, pokeBack: $("#c-poke").checked,
        autoReact: $("#c-react").checked, autoApprove: $("#c-approve").checked,
      }) });
      toast("已保存");
    };
  }

  // ── 动作台 ──────────────────────────────────────────────────────
  const COMMON_ACTIONS = ["get_login_info", "get_friend_list", "get_group_list", "get_group_member_list",
    "get_group_msg_history", "get_friend_msg_history", "get_msg", "get_status", "get_version_info",
    "set_group_card", "set_group_ban", "set_group_whole_ban", "set_group_admin", "set_group_leave",
    "send_group_notice", "delete_msg", "friend_poke", "group_poke", "send_like", "set_qq_profile", "set_online_status"];
  async function renderActions() {
    $("#main").innerHTML = `
      <h2>动作台 <span class="muted">（OneBot 动作白名单透传）</span></h2>
      <div class="card">
        <div class="form-row"><label>动作</label>
          <input id="a-name" list="a-list" value="get_login_info" style="flex:1">
          <datalist id="a-list">${COMMON_ACTIONS.map((a) => `<option value="${a}">`).join("")}</datalist>
        </div>
        <div class="form-row"><label>参数 JSON</label>
          <textarea id="a-params" rows="4" style="flex:1" placeholder='{"group_id": 123}'>{}</textarea>
        </div>
        <button class="btn" id="a-run">执行</button>
        <span class="muted" style="margin-left:8px">写操作（禁言/踢群/删消息等）请确认参数再执行</span>
      </div>
      <div class="card"><pre class="json" id="a-out">结果将显示在这里</pre></div>`;
    $("#a-run").onclick = async () => {
      const name = $("#a-name").value.trim();
      let params;
      try { params = JSON.parse($("#a-params").value || "{}"); } catch { toast("参数不是合法 JSON"); return; }
      $("#a-out").textContent = "执行中…";
      try {
        const r = await api(`/api/actions/${name}`, { method: "POST", body: JSON.stringify(params) });
        $("#a-out").textContent = JSON.stringify(r, null, 2);
      } catch (e) {
        $("#a-out").textContent = `失败：${e.message}`;
      }
    };
  }

  // ── SSE ─────────────────────────────────────────────────────────
  function connectSSE() {
    const es = new EventSource("/api/events/stream");
    es.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "hello") {
        setConn(m.botConnected);
      } else if (m.type === "bot.status") {
        setConn(m.connected);
        if (m.connected) toast("SnowLuma 已连接");
      } else if (m.type === "qq.event") {
        const isGroup = m.messageType === "group";
        const kind = m.post === "message" ? (isGroup ? "group" : "private") : m.post === "notice" ? "notice" : "request";
        const who = m.card || m.nickname || m.userId || "";
        const gidName = isGroup ? (groups.find((g) => String(g.group_id) === String(m.groupId))?.group_name || m.groupId) : "";
        const meta = `${fmtTime((m.time ?? 0) * 1000)} · ${kind === "private" ? "私聊" : kind === "group" ? `群 ${gidName}` : kind}`;
        const text = kind === "private" || kind === "group"
          ? `${who}: ${m.rawMessage}`
          : kind === "notice" ? `${m.noticeType} · ${who}${m.groupId ? ` @群${m.groupId}` : ""}` : `${m.requestType} · ${who}: ${m.comment || ""}`;
        feedPush(kind, meta, text);
      } else if (m.type === "qq.sent") {
        feedPush("private", fmtTime(Date.now()), `[后台发送 → ${m.key}] ${m.text}`);
      }
    };
    es.onerror = () => setConn(false);
  }
  function setConn(on) {
    $("#conn-dot").className = `dot ${on ? "on" : "off"}`;
    $("#conn-text").textContent = on ? "SnowLuma 在线" : "SnowLuma 离线";
    if (status) status.botConnected = on;
  }

  // ── 启动 ────────────────────────────────────────────────────────
  buildNav();
  switchTab("overview");
  fetch("/api/status").then((r) => r.json()).then(async (s) => {
    setConn(s.botConnected);
    // 预取群名（消息流显示用）
    if (s.botConnected) {
      try { groups = (await (await fetch("/api/groups")).json()).result || []; } catch {}
    }
  }).catch(() => setConn(false));
  connectSSE();
})();
