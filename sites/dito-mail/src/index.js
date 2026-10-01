/**
 * dito-mail — get.dito.asia
 *
 * 领取 @dito.asia 邮箱。
 * 流程：用户提交申请 → 管理员在 /admin 审核 → NAS 轮询队列开号 → 用户用申请码查结果。
 *
 * 环境变量（wrangler secret）：
 *   ADMIN_PASSWORD  管理员页面登录口令
 *   ADMIN_TOKEN     NAS 轮询接口的 Bearer 令牌
 */

const RESERVED = new Set([
  'wulong', 'dito', 'yuanjing', 'noreply', 'no-reply', 'admin', 'administrator',
  'postmaster', 'hostmaster', 'webmaster', 'abuse', 'security', 'root', 'info',
  'support', 'sales', 'billing', 'mail', 'mailer', 'mailer-daemon', 'www', 'smtp',
  'imap', 'pop3', 'pop', 'api', 'dev', 'test', 'demo', 'system', 'daemon', 'ftp',
  'ns', 'dns', 'mx', 'autoconfig', 'autodiscover', 'help', 'contact', 'office',
]);

const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
const MAX_PER_IP_PER_DAY = 3;
const MAX_GLOBAL_PER_DAY = 30;

const PLATFORMS = ['ios', 'android', 'browser', 'pc'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function ipOf(request) {
  return request.headers.get('cf-connecting-ip') || '0.0.0.0';
}

function genCode(n = 8) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function checkPrefix(p) {
  if (typeof p !== 'string' || !p) return '缺少邮箱前缀';
  p = p.trim().toLowerCase();
  if (p.length < 3) return '前缀至少 3 个字符';
  if (p.length > 30) return '前缀最多 30 个字符';
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(p))
    return '只能用 a-z 0-9 . _ -，且首尾必须是字母或数字';
  if (/[._-]{2,}/.test(p)) return '符号不能连续出现';
  if (RESERVED.has(p)) return '这个前缀已保留，换一个';
  return null;
}

function checkPassword(pw) {
  if (typeof pw !== 'string') return '密码格式不对';
  if (pw.length < 8) return '密码至少 8 位';
  if (pw.length > 64) return '密码最多 64 位';
  if (/\s/.test(pw)) return '密码不能含空格';
  return null;
}

/** 计数限流：返回 true 表示超限 */
async function overLimit(env, key, max, ttl) {
  const cur = parseInt((await env.MAIL_KV.get(key)) || '0', 10);
  if (cur >= max) return true;
  await env.MAIL_KV.put(key, String(cur + 1), { expirationTtl: ttl });
  return false;
}

// ---------------------------------------------------------------- 用户接口

async function handleSignup(request, env) {
  if (request.method !== 'POST') return json({ error: '方法不允许' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  // 蜜罐：正常用户看不到也填不了这个字段
  if (body.website) return json({ ok: true, code: genCode() }, 200);

  const prefix = String(body.prefix || '').trim().toLowerCase();
  const password = String(body.password || '');

  const perr = checkPrefix(prefix);
  if (perr) return json({ error: perr }, 400);
  const wherr = checkPassword(password);
  if (wherr) return json({ error: wherr }, 400);

  const ip = ipOf(request);
  if (await overLimit(env, `rl:ip:${ip}:${today()}`, MAX_PER_IP_PER_DAY, 90000))
    return json({ error: '今天提交次数太多了，明天再来' }, 429);
  if (await overLimit(env, `rl:global:${today()}`, MAX_GLOBAL_PER_DAY, 90000))
    return json({ error: '今天的名额已满，明天再来' }, 429);

  const email = `${prefix}@dito.asia`;

  // 已存在的账号直接拦掉（含待审重的重复前缀）
  const taken = await env.MAIL_KV.get(`taken:${prefix}`);
  if (taken) return json({ error: '这个邮箱已经被占用了，换一个' }, 409);

  // 同一前缀有未处理的申请
  const dupKey = `dup:${prefix}`;
  if (await env.MAIL_KV.get(dupKey))
    return json({ error: '这个前缀已经有申请在审核中' }, 409);

  const code = genCode(8);
  const rec = {
    prefix,
    email,
    password,
    ip,
    ts: Date.now(),
    status: 'pending',
    platform: PLATFORMS.includes(body.platform) ? body.platform : null,
  };
  await env.MAIL_KV.put(`req:${code}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });
  await env.MAIL_KV.put(dupKey, code, { expirationTtl: 60 * 60 * 24 * 7 });

  return json({ ok: true, code, email });
}

async function handleStatus(request, env, url) {
  const code = (url.searchParams.get('code') || '').trim().toUpperCase();
  if (!code) return json({ error: '缺少申请码' }, 400);
  const raw = await env.MAIL_KV.get(`req:${code}`);
  if (!raw) return json({ error: '申请码不存在或已过期' }, 404);
  const rec = JSON.parse(raw);
  return json({
    code,
    email: rec.email,
    status: rec.status,
    ts: rec.ts,
    note: rec.note || null,
  });
}

// ---------------------------------------------------------------- 管理接口

async function isAdmin(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)adm=([^;]+)/);
  return !!env.ADMIN_COOKIE && m && m[1] === env.ADMIN_COOKIE;
}

function loginPage(err) {
  return html(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dito-mail 管理</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0a0e14;color:#d6e2f0;
       font-family:-apple-system,"Segoe UI","Noto Sans SC",sans-serif}
  form{background:#131a26;border:1px solid #1e2a3a;border-radius:14px;padding:28px 32px;width:300px}
  h1{font-size:17px;margin:0 0 18px;font-weight:600}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
        border:1px solid #1e2a3a;background:#0a0e14;color:#d6e2f0;font-size:14px}
  button{width:100%;margin-top:14px;padding:10px;border:0;border-radius:8px;
         background:#35d0ba;color:#06231f;font-weight:600;font-size:14px;cursor:pointer}
  .err{color:#e06c75;font-size:13px;margin-top:10px}
</style></head><body>
<form method="POST" action="/admin/login">
  <h1>dito-mail 管理</h1>
  <input type="password" name="password" placeholder="管理口令" autofocus required>
  <button type="submit">进入</button>
  ${err ? `<div class="err">${err}</div>` : ''}
</form></body></html>`);
}

function adminPage(records) {
  const rows = records.length
    ? records
        .map(
          (r) => `<tr>
      <td><code>${r.email}</code></td>
      <td><span class="s s-${r.status}">${r.status}</span></td>
      <td>${new Date(r.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td>
      <td>${r.ip || '-'}</td>
      <td>${r.platform || '-'}</td>
      <td class="act">
        ${r.status === 'pending'
          ? `<form method="POST" action="/admin/act" style="display:inline">
               <input type="hidden" name="code" value="${r.code}">
               <input type="hidden" name="op" value="approve">
               <button class="ok">通过</button></form>
             <form method="POST" action="/admin/act" style="display:inline">
               <input type="hidden" name="code" value="${r.code}">
               <input type="hidden" name="op" value="reject">
               <button class="no">拒绝</button></form>`
          : `<span class="dim">—</span>`}
      </td>
    </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="dim">暂无申请</td></tr>';

  return html(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dito-mail 管理</title>
<style>
  body{margin:0;background:#0a0e14;color:#d6e2f0;
       font-family:-apple-system,"Segoe UI","Noto Sans SC",sans-serif;padding:28px}
  h1{font-size:18px;margin:0 0 6px}
  .sub{color:#7d8ea3;font-size:13px;margin-bottom:20px}
  table{border-collapse:collapse;width:100%;max-width:1000px;font-size:13px}
  th,td{padding:9px 10px;border-bottom:1px solid #1e2a3a;text-align:left}
  th{color:#7d8ea3;font-weight:500}
  code{color:#6ee7b7}
  .s{padding:2px 7px;border-radius:5px;font-size:12px}
  .s-pending{background:#3a2f12;color:#febc2e}
  .s-approved{background:#12303a;color:#35d0ba}
  .s-created{background:#14301c;color:#7ee787}
  .s-rejected,.s-failed{background:#3a1a1d;color:#e06c75}
  .dim{color:#54687f}
  button{border:0;border-radius:6px;padding:5px 11px;font-size:12px;cursor:pointer;margin-right:5px}
  .ok{background:#35d0ba;color:#06231f;font-weight:600}
  .no{background:#1e2a3a;color:#d6e2f0}
</style></head><body>
<h1>dito-mail 申请管理</h1>
<div class="sub">待审的记录点「通过」后会进入 NAS 队列，NAS 轮询开号（约 1-2 分钟）</div>
<table>
  <tr><th>邮箱</th><th>状态</th><th>提交时间</th><th>IP</th><th>平台</th><th>操作</th></tr>
  ${rows}
</table>
<form method="POST" action="/admin/logout" style="margin-top:22px">
  <button class="no">退出登录</button>
</form>
</body></html>`);
}

async function handleAdmin(request, env, url) {
  if (url.pathname === '/admin/login') {
    const form = await request.formData().catch(() => null);
    const pw = form ? String(form.get('password') || '') : '';
    if (!env.ADMIN_PASSWORD || pw !== env.ADMIN_PASSWORD)
      return loginPage('口令不对');
    return new Response(null, {
      status: 302,
      headers: {
        location: '/admin',
        'set-cookie': `adm=${env.ADMIN_COOKIE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
      },
    });
  }

  if (url.pathname === '/admin/logout') {
    return new Response(null, {
      status: 302,
      headers: { location: '/admin', 'set-cookie': 'adm=; Path=/; Max-Age=0' },
    });
  }

  if (!(await isAdmin(request, env))) {
    if (request.method === 'POST') return loginPage('口令不对');
    return loginPage();
  }

  if (url.pathname === '/admin/act' && request.method === 'POST') {
    const form = await request.formData();
    const code = String(form.get('code') || '').trim().toUpperCase();
    const op = String(form.get('op') || '');
    const raw = await env.MAIL_KV.get(`req:${code}`);
    if (raw) {
      const rec = JSON.parse(raw);
      if (op === 'approve' && rec.status === 'pending') {
        rec.status = 'approved';
        await env.MAIL_KV.put(`req:${code}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });
        // 入队给 NAS 轮询
        await env.MAIL_KV.put(
          `q:${code}`,
          JSON.stringify({ code, prefix: rec.prefix, email: rec.email, password: rec.password, ts: Date.now() }),
          { expirationTtl: 60 * 60 * 24 * 7 }
        );
      } else if (op === 'reject') {
        rec.status = 'rejected';
        await env.MAIL_KV.put(`req:${code}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });
        await env.MAIL_KV.delete(`dup:${rec.prefix}`);
      }
    }
    return new Response(null, { status: 302, headers: { location: '/admin' } });
  }

  // 列表
  const list = await env.MAIL_KV.list({ prefix: 'req:', limit: 200 });
  const recs = [];
  for (const k of list.keys) {
    const raw = await env.MAIL_KV.get(k.name);
    if (raw) {
      const r = JSON.parse(raw);
      r.code = k.name.slice(4);
      recs.push(r);
    }
  }
  recs.sort((a, b) => b.ts - a.ts);
  return adminPage(recs);
}

// ---------------------------------------------------------------- NAS 轮询

async function handleQueue(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`)
    return json({ error: '未授权' }, 401);

  const list = await env.MAIL_KV.list({ prefix: 'q:', limit: 50 });
  const jobs = [];
  for (const k of list.keys) {
    const raw = await env.MAIL_KV.get(k.name);
    if (raw) jobs.push(JSON.parse(raw));
  }
  return json({ ok: true, jobs });
}

async function handleAck(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`)
    return json({ error: '未授权' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }
  const code = String(body.code || '').toUpperCase();
  const ok = body.ok === true;
  const raw = await env.MAIL_KV.get(`req:${code}`);
  if (!raw) return json({ error: '找不到该申请' }, 404);

  const rec = JSON.parse(raw);
  rec.status = ok ? 'created' : 'failed';
  if (body.note) rec.note = String(body.note).slice(0, 200);
  delete rec.password; // 开号成功后立刻抹掉明文密码
  await env.MAIL_KV.put(`req:${code}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });
  await env.MAIL_KV.delete(`q:${code}`);
  await env.MAIL_KV.delete(`dup:${rec.prefix}`);
  if (ok) await env.MAIL_KV.put(`taken:${rec.prefix}`, rec.email, { expirationTtl: 60 * 60 * 24 * 365 * 5 });

  return json({ ok: true, status: rec.status });
}

// ---------------------------------------------------------------- 入口

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 尾斜杠规范化：/admin/ -> /admin，否则会交给静态资源并落到 404 页
    const rawPath = url.pathname;
    let p = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;

    // 管理后台别名：/manage、/audit、/review 等价于 /admin
    const ADMIN_ALIAS = { '/manage': '/admin', '/audit': '/admin', '/review': '/admin' };
    if (ADMIN_ALIAS[p]) p = ADMIN_ALIAS[p];

    if (p !== rawPath) url.pathname = p;

    try {
      if (p === '/api/signup') return await handleSignup(request, env);
      if (p === '/api/status') return await handleStatus(request, env, url);
      if (p === '/api/admin/queue') return await handleQueue(request, env);
      if (p === '/api/admin/ack') return await handleAck(request, env);
      if (p === '/admin' || p === '/admin/login' || p === '/admin/logout' || p === '/admin/act')
        return await handleAdmin(request, env, url);
    } catch (e) {
      return json({ error: '服务器内部错误', detail: String(e && e.message) }, 500);
    }

    // 静态资源兜底。注意：CF 的边缘对未匹配路径会返回可缓存的 404 兜底页，
    // 所以这里显式把 4xx/5xx 改成 no-store，避免边缘缓存住 404。
    const res = await env.ASSETS.fetch(request);
    if (res.status < 400) return res;
    const headers = new Headers(res.headers);
    headers.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
