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
  let pendingChatKey = null;
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
      el.onclick = () => selectChat(el);
    });
    if (pendingChatKey) {
      const el = list.querySelector(`[data-key="${pendingChatKey}"]`);
      if (el) selectChat(el);
      pendingChatKey = null;
    }
    function selectChat(el) {
      list.querySelectorAll(".chat-item").forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
      currentChatKey = el.dataset.key;
      $("#chat-send").disabled = !status?.botConnected;
      loadHistory(currentChatKey);
    }
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
        $("#main").innerHTML = `<h2>好友（${list.length}）</h2><div class="muted" style="margin-bottom:10px">点击好友打开深度配置</div>
          <div class="grid">${list.map((f) => `<div class="card" style="cursor:pointer" data-uid="${esc(f.user_id)}"><b>${esc(f.nickname || f.remark || f.user_id)}</b><div class="muted">QQ ${esc(f.user_id)}${f.remark && f.remark !== f.nickname ? " · 备注 " + esc(f.remark) : ""}</div></div>`).join("") || '<div class="muted">空</div>'}</div>`;
        $("#main").querySelectorAll(".card[data-uid]").forEach((el) => {
          el.onclick = () => openFriendModal(list.find((f) => String(f.user_id) === el.dataset.uid));
        });
      } else {
        groups = list;
        $("#main").innerHTML = `<h2>群列表（${list.length}）</h2><div class="muted" style="margin-bottom:10px">点击群打开深度配置（行为开关 / 群管 / 成员）</div>
          <div class="grid">${list.map((g) => `<div class="card" style="cursor:pointer" data-gid="${esc(g.group_id)}"><b>${esc(g.group_name || g.group_id)}</b>
            <div class="muted">群号 ${esc(g.group_id)} · ${esc(g.member_count ?? "?")} 人</div></div>`).join("") || '<div class="muted">空</div>'}</div>`;
        $("#main").querySelectorAll(".card[data-gid]").forEach((el) => {
          el.onclick = () => openGroupModal(list.find((g) => String(g.group_id) === el.dataset.gid));
        });
      }
    } catch (e) {
      $("#main").innerHTML = `<div class="card">加载失败：${esc(e.message)}（SnowLuma 未连接？）</div>`;
    }
  }

  // ── 弹窗骨架 ────────────────────────────────────────────────────
  function openModal(title, sub, bodyHtml) {
    closeModal();
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.id = "modal-mask";
    mask.innerHTML = `<div class="modal">
      <div class="m-head"><div><h3>${esc(title)}</h3>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div><button class="m-close" onclick="document.getElementById('modal-mask').remove()">关闭 ✕</button></div>
      ${bodyHtml}
    </div>`;
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
    return mask;
  }
  function closeModal() { document.getElementById("modal-mask")?.remove(); }

  /** 调动作白名单接口 */
  async function act(name, params) {
    const r = await api(`/api/actions/${name}`, { method: "POST", body: JSON.stringify(params || {}) });
    if (!r.ok) throw new Error(r.error || "动作失败");
    return r.result;
  }

  // ── 好友深度配置 ────────────────────────────────────────────────
  async function openFriendModal(f) {
    if (!f) return;
    const key = `qq-private-${f.user_id}`;
    const mask = openModal(f.nickname || f.remark || `QQ ${f.user_id}`, `QQ ${f.user_id}`, `<div class="muted">加载资料中…</div>`);
    const body = mask.querySelector(".modal");
    // 资料与会话信息并行拉
    const [infoR, chatsData] = await Promise.all([
      act("get_stranger_info", { user_id: f.user_id }).catch(() => null),
      api("/api/chats").catch(() => ({ chats: [] })),
    ]);
    const chat = chatsData.chats?.find((c) => c.key === key);
    const info = infoR?.result ?? {};
    body.querySelector(".muted").outerHTML = `
      <div class="section"><h4>资料</h4>
        <div class="kv">
          <div><div class="k">昵称</div>${esc(info.nickname || f.nickname || "-")}</div>
          <div><div class="k">QQ</div>${esc(f.user_id)}</div>
          <div><div class="k">备注</div>${esc(f.remark || "-")}</div>
          <div><div class="k">等级</div>${esc(info.level ?? "-")}</div>
        </div>
      </div>
      <div class="section"><h4>互动</h4>
        <div class="op-grid">
          <button class="btn ghost" id="fm-like">点赞 ×10</button>
          <button class="btn ghost" id="fm-poke">戳一戳</button>
          <button class="btn ghost" id="fm-chat">查看聊天记录</button>
        </div>
        <div class="row" style="margin-top:10px">
          <input id="fm-text" placeholder="给 TA 发一条私信…" style="flex:1">
          <button class="btn" id="fm-send">发送</button>
        </div>
      </div>
      <div class="section"><h4>Dito 会话</h4>
        <div class="muted">${chat ? `已有会话：${chat.messages} 条记录 · 最后 ${esc(fmtTime(chat.lastTs))}` : "暂无会话（TA 发消息后自动创建）"}</div>
        <div class="row" style="margin-top:9px">
          <button class="btn danger" id="fm-reset" ${chat ? "" : "disabled"}>重置会话</button>
          <span class="muted">清空 Dito 对 TA 的记忆，下一条消息开新会话</span>
        </div>
      </div>`;
    $("#fm-like").onclick = async () => { try { await act("send_like", { user_id: f.user_id, times: 10 }); toast("已点赞 ×10"); } catch (e) { toast(e.message); } };
    $("#fm-poke").onclick = async () => { try { await act("friend_poke", { user_id: f.user_id }); toast("戳了"); } catch (e) { toast(e.message); } };
    $("#fm-chat").onclick = () => { closeModal(); gotoChat(key); };
    $("#fm-send").onclick = async () => {
      const input = $("#fm-text");
      if (!input.value.trim()) return;
      try { await api(`/api/chats/${key}/send`, { method: "POST", body: JSON.stringify({ text: input.value.trim() }) }); input.value = ""; toast("已发送"); }
      catch (e) { toast(`发送失败：${e.message}`); }
    };
    $("#fm-reset").onclick = async () => {
      if (!confirm("确定重置与该好友的 Dito 会话？记忆清空不可恢复。")) return;
      await api(`/api/chats/${key}`, { method: "DELETE" });
      toast("会话已重置");
      closeModal();
    };
  }

  /** 跳到聊天页并选中会话 */
  async function gotoChat(key) {
    pendingChatKey = key;
    switchTab("chats");
  }

  // ── 群深度配置 ──────────────────────────────────────────────────
  async function openGroupModal(g) {
    if (!g) return;
    const gid = g.group_id;
    const key = `qq-group-${gid}`;
    const mask = openModal(g.group_name || `群 ${gid}`, `群号 ${gid}`, `<div class="muted">加载中…</div>`);
    const body = mask.querySelector(".modal");
    const cfgR = await api("/api/config/qq").catch(() => null);
    const qqCfg = cfgR?.config ?? {};
    const inGroups = (qqCfg.groups ?? []).includes(Number(gid));
    const wakeOnly = (qqCfg.wakeOnlyGroups ?? []).includes(Number(gid));
    const [infoR, membersR, noticeR] = await Promise.all([
      act("get_group_info", { group_id: gid }).catch(() => null),
      api(`/api/groups/${gid}/members`).catch(() => ({ result: [] })),
      act("get_group_notice", { group_id: gid }).catch(() => null),
    ]);
    const info = infoR?.result ?? {};
    const members = membersR.result || [];
    const aff = (await api("/api/affinity").catch(() => ({ data: {} }))).data;
    const owners = new Set(status?.config?.owners ?? []);
    const notice = noticeR?.result?.notice ?? {};
    window.__groupCfg = async (patch, msg) => {
      await api("/api/config/qq", { method: "PATCH", body: JSON.stringify(patch) });
      toast(msg);
      openGroupModal(g); // 重开刷新开关态
    };
    body.querySelector(".muted").outerHTML = `
      <div class="section"><h4>群信息</h4>
        <div class="kv">
          <div><div class="k">群名</div>${esc(info.group_name || g.group_name || "-")}</div>
          <div><div class="k">成员</div>${esc(info.member_count ?? g.member_count ?? "-")} / ${esc(info.max_member_count ?? "?")}</div>
          <div><div class="k">群号</div>${esc(gid)}</div>
        </div>
      </div>
      <div class="section"><h4>Dito 行为开关</h4>
        <div class="row">
          <span class="toggle ${inGroups ? "on" : ""}" id="g-respond">${inGroups ? "✓ " : ""}响应此群</span>
          <span class="toggle ${wakeOnly ? "on" : ""}" id="g-wakeonly">${wakeOnly ? "✓ " : ""}仅唤醒响应（不参与概率回复）</span>
        </div>
        <div class="muted">写入 channels.qq.groups / wakeOnlyGroups，即时生效</div>
      </div>
      <div class="section"><h4>群管操作（以机器人身份）</h4>
        <div class="row"><label>机器人群名片</label><input id="g-card" value="${esc(info.group_card ?? "")}" placeholder="留空不变" style="flex:1"><button class="btn ghost" id="g-card-set">设置</button></div>
        <div class="row"><label>群公告</label><textarea id="g-notice" rows="2" style="flex:1" placeholder="${esc((notice.text || "").slice(0, 80))}"></textarea><button class="btn ghost" id="g-notice-set">发布</button></div>
        <div class="op-grid">
          <button class="btn ghost" id="g-poke">戳一戳群</button>
          <button class="btn ghost" id="g-wholeban">全员禁言</button>
          <button class="btn danger" id="g-leave">退出本群</button>
        </div>
      </div>
      <div class="section"><h4>发消息 / 会话</h4>
        <div class="row"><input id="g-text" placeholder="以机器人身份发到本群…" style="flex:1"><button class="btn" id="g-send">发送</button></div>
        <div class="row">
          <button class="btn ghost" id="g-chat">查看聊天记录</button>
          <button class="btn danger" id="g-reset">重置 Dito 会话</button>
          <span class="muted">重置 = 清空 Dito 对本群的对话记忆</span>
        </div>
      </div>
      <div class="section"><h4>成员（${members.length}）</h4>
        <div style="max-height:260px;overflow-y:auto">
        <table class="mtable"><tr><th>QQ</th><th>名片/昵称</th><th>角色</th><th>好感度</th><th class="ops">操作</th></tr>
        ${members.map((m) => `<tr data-uid="${esc(m.user_id)}">
          <td>${esc(m.user_id)}</td>
          <td>${esc(m.card || m.nickname || "")}</td>
          <td>${m.role === "owner" ? '<span class="badge role-owner">群主</span>' : m.role === "admin" ? '<span class="badge role-owner">管理</span>' : ""}${owners.has(m.user_id) ? '<span class="badge owner">主人</span>' : ""}</td>
          <td>${aff[`${gid}:${m.user_id}`] !== undefined ? `<span class="badge ${aff[`${gid}:${m.user_id}`] < 20 ? "low" : ""}">${aff[`${gid}:${m.user_id}`]}</span>` : '<span class="muted">-</span>'}</td>
          <td class="ops">
            <button class="btn ghost" title="设群名片" onclick="window.__mcard('${gid}','${m.user_id}')">名片</button>
            <button class="btn ghost" title="禁言10分钟" onclick="window.__mban('${gid}','${m.user_id}')">禁言</button>
            <button class="btn ghost" title="戳一戳" onclick="window.__mpoke('${gid}','${m.user_id}')">戳</button>
          </td></tr>`).join("")}
        </table></div>
      </div>`;
    // 行为开关
    $("#g-respond").onclick = () => {
      const next = !inGroups;
      const list = new Set(qqCfg.groups ?? []);
      next ? list.add(Number(gid)) : list.delete(Number(gid));
      window.__groupCfg({ groups: [...list] }, next ? "已开启响应此群" : "已停止响应此群");
    };
    $("#g-wakeonly").onclick = () => {
      const next = !wakeOnly;
      const list = new Set(qqCfg.wakeOnlyGroups ?? []);
      next ? list.add(Number(gid)) : list.delete(Number(gid));
      window.__groupCfg({ wakeOnlyGroups: [...list] }, next ? "本群改为仅唤醒响应" : "本群恢复概率回复");
    };
    // 群管
    $("#g-card-set").onclick = async () => {
      const v = $("#g-card").value.trim();
      if (!v) { toast("名片不能为空（清空名片功能不支持）"); return; }
      try { await act("set_group_card", { group_id: gid, user_id: status?.login?.user_id, card: v }); toast("群名片已设置"); } catch (e) { toast(e.message); }
    };
    $("#g-notice-set").onclick = async () => {
      const v = $("#g-notice").value.trim();
      if (!v) { toast("公告内容为空"); return; }
      try { await act("send_group_notice", { group_id: gid, content: v }); toast("公告已发布"); } catch (e) { toast(e.message); }
    };
    $("#g-poke").onclick = async () => { try { await act("group_poke", { group_id: gid, user_id: status?.login?.user_id }); toast("戳了"); } catch (e) { toast(e.message); } };
    $("#g-wholeban").onclick = async () => {
      if (!confirm("全员禁言：确认开启？（再次执行 enable=false 可解除，本按钮仅开启）")) return;
      try { await act("set_group_whole_ban", { group_id: gid, enable: true }); toast("已开启全员禁言"); } catch (e) { toast(e.message); }
    };
    $("#g-leave").onclick = async () => {
      if (!confirm(`危险操作：机器人将退出「${g.group_name || gid}」且无法自行加回！确定？`)) return;
      if (!confirm("再次确认：真的要退群？")) return;
      try { await act("set_group_leave", { group_id: gid }); toast("已退群"); closeModal(); } catch (e) { toast(e.message); }
    };
    // 发消息 / 会话
    $("#g-send").onclick = async () => {
      const input = $("#g-text");
      if (!input.value.trim()) return;
      try { await api(`/api/chats/${key}/send`, { method: "POST", body: JSON.stringify({ text: input.value.trim() }) }); input.value = ""; toast("已发送"); }
      catch (e) { toast(`发送失败：${e.message}`); }
    };
    $("#g-chat").onclick = () => { closeModal(); gotoChat(key); };
    $("#g-reset").onclick = async () => {
      if (!confirm("确定重置 Dito 对本群的会话记忆？")) return;
      await api(`/api/chats/${key}`, { method: "DELETE" });
      toast("会话已重置");
    };
    // 成员操作
    window.__mcard = async (gid2, uid) => {
      const card = prompt("设置群名片（留空取消）：", "");
      if (card === null) return;
      try { await act("set_group_card", { group_id: Number(gid2), user_id: Number(uid), card }); toast("名片已设置"); openGroupModal(g); } catch (e) { toast(e.message); }
    };
    window.__mban = async (gid2, uid) => {
      const min = prompt("禁言时长（分钟）：", "10");
      if (min === null) return;
      const sec = Math.max(60, Math.min(43200, Number(min) * 60 || 600));
      try { await act("set_group_ban", { group_id: Number(gid2), user_id: Number(uid), duration: sec }); toast(`已禁言 ${sec / 60} 分钟`); } catch (e) { toast(e.message); }
    };
    window.__mpoke = async (gid2, uid) => {
      try { await act("group_poke", { group_id: Number(gid2), user_id: Number(uid) }); toast("戳了"); } catch (e) { toast(e.message); }
    };
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
