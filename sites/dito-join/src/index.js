// join.dito.asia —— dito chat 入坑教程页
// 注册令牌由部署环境 MATRIX_REGISTRATION_TOKEN 提供，不写进仓库。

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

    const response = new Response(res.body, { status: res.status, headers });
    if (res.headers.get("content-type")?.includes("text/html")) {
      return new HTMLRewriter().on("#tokenval", {
        element(element) {
          element.setInnerContent(env.MATRIX_REGISTRATION_TOKEN || "");
        },
      }).transform(response);
    }
    return response;
  },
};
