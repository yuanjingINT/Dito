// join.dito.asia —— dito chat 入坑教程页
// 纯静态资源，Worker 只负责兜一层响应头（禁索引）

const NOINDEX = "noindex, nofollow, noarchive";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "X-Robots-Tag": NOINDEX } });
    }

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("X-Robots-Tag", NOINDEX);
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");

    return new Response(res.body, { status: res.status, headers });
  },
};
