/**
 * dito.asia 顶级域名的 well-known 委派
 *
 * 作用：让 Matrix 客户端填「dito.asia」也能找到真正的服务器，同时
 *      让 `@user:dito.asia` 这种 ID 能被正确解析。
 *
 * 真正的 Matrix 服务在 mx.dito.asia，这里是标准做法里的 delegation。
 */

const HOMESERVER = "https://mx.dito.asia";
const SERVER_NAME = "dito.asia";
const SITE = "https://dito.dito.asia";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "*",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...CORS,
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 客户端发现：告诉客户端 API 真正的地址
    if (path === "/.well-known/matrix/client") {
      return json({
        "m.homeserver": { base_url: HOMESERVER },
      });
    }

    // 服务器发现：告诉别的 Matrix 服务器怎么找我们
    if (path === "/.well-known/matrix/server") {
      return json({ "m.server": "mx.dito.asia:443" });
    }

    // 联邦用的 key 查询走真实服务器
    if (path.startsWith("/_matrix/")) {
      return Response.redirect(HOMESERVER + path + url.search, 302);
    }

    // 其余路径一律回官网
    return Response.redirect(SITE, 302);
  },
};
