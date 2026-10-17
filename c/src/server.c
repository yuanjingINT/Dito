#include "dito.h"
#include <arpa/inet.h>
#include <errno.h>
#include <openssl/crypto.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <unistd.h>

typedef struct {
  Config *config;
  const char *kind;
  int port;
  pthread_mutex_t agent_lock;
} Server;
static volatile sig_atomic_t stopping;
static Session *server_active;
static char *header_value(const char *headers, const char *name) {
  size_t n = strlen(name);
  const char *p = headers;
  while ((p = strstr(p, "\r\n"))) {
    p += 2;
    if (!strncasecmp(p, name, n) && p[n] == ':') {
      p += n + 1;
      while (*p == ' ' || *p == '\t')
        p++;
      const char *end = strstr(p, "\r\n");
      if (!end)
        return NULL;
      char *value = xmalloc((size_t)(end - p) + 1);
      memcpy(value, p, (size_t)(end - p));
      value[end - p] = 0;
      return value;
    }
  }
  return NULL;
}
static void stop_server(int sig) {
  (void)sig;
  stopping = 1;
  if (server_active)
    server_active->cancelled = 1;
}
static int send_all(int fd, const char *text, size_t n) {
  size_t at = 0;
  while (at < n) {
    ssize_t k = send(fd, text + at, n - at, MSG_NOSIGNAL);
    if (k < 0 && errno == EINTR)
      continue;
    if (k <= 0)
      return -1;
    at += (size_t)k;
  }
  return 0;
}
static void response(int fd, int status, json_object *body) {
  char *raw = json_text(body);
  char *header = format("HTTP/1.1 %d %s\r\nContent-Type: application/json; "
                        "charset=utf-8\r\nContent-Length: %zu\r\nConnection: "
                        "close\r\nX-Content-Type-Options: nosniff\r\n\r\n",
                        status,
                        status == 200   ? "OK"
                        : status == 202 ? "Accepted"
                        : status == 401 ? "Unauthorized"
                                        : "Error",
                        strlen(raw));
  send_all(fd, header, strlen(header));
  send_all(fd, raw, strlen(raw));
  free(header);
  free(raw);
}
static json_object *error_json(const char *text) {
  json_object *j = json_object_new_object();
  json_object_object_add(j, "error", json_object_new_string(text));
  return j;
}
static json_object *mcp_result(json_object *id, json_object *result,
                               const char *error) {
  json_object *out = json_object_new_object();
  json_object_object_add(out, "jsonrpc", json_object_new_string("2.0"));
  json_object_object_add(out, "id", json_copy(id));
  if (error) {
    json_object *e = json_object_new_object();
    json_object_object_add(e, "code", json_object_new_int(-32602));
    json_object_object_add(e, "message", json_object_new_string(error));
    json_object_object_add(out, "error", e);
    if (result)
      json_object_put(result);
  } else
    json_object_object_add(out, "result", result);
  return out;
}
static bool mcp_allowed(const char *name, bool bash) {
  return !strncmp(name, "kb_", 3) || !strncmp(name, "memory_", 7) ||
         !strcmp(name, "get_system_info") || !strcmp(name, "system_info") ||
         !strcmp(name, "web_fetch") || !strcmp(name, "web_search") ||
         (bash && (!strcmp(name, "bash") || !strcmp(name, "pc_bash")));
}
static json_object *mcp(Server *server, json_object *request) {
  const char *method = jstr(request, "method", "");
  json_object *id = jget(request, "id"), *result = json_object_new_object();
  if (!strcmp(method, "initialize")) {
    json_object_object_add(result, "protocolVersion",
                           json_object_new_string("2025-03-26"));
    json_object *info = json_object_new_object();
    json_object_object_add(info, "name", json_object_new_string("dito"));
    json_object_object_add(info, "version",
                           json_object_new_string(DITO_VERSION));
    json_object_object_add(result, "serverInfo", info);
    json_object *caps = json_object_new_object();
    json_object_object_add(caps, "tools", json_object_new_object());
    json_object_object_add(result, "capabilities", caps);
    return mcp_result(id, result, NULL);
  }
  Session s = {.config = server->config,
               .allow_host = true,
               .scope = "",
               .interactive = false};
  bool bash = jbool(jpath(server->config->json, "plugins.mcp.server"),
                    "allowBash", false);
  if (!strcmp(method, "tools/list")) {
    json_object *all = tool_definitions(&s), *list = json_object_new_array();
    for (size_t i = 0; i < jlen(all); i++) {
      json_object *fn = jget(jat(all, i), "function");
      if (!mcp_allowed(jstr(fn, "name", ""), bash))
        continue;
      json_object *tool = json_object_new_object();
      json_object_object_add(tool, "name", json_copy(jget(fn, "name")));
      json_object_object_add(tool, "description",
                             json_copy(jget(fn, "description")));
      json_object_object_add(tool, "inputSchema",
                             json_copy(jget(fn, "parameters")));
      json_object_array_add(list, tool);
    }
    json_object_put(all);
    json_object_object_add(result, "tools", list);
    return mcp_result(id, result, NULL);
  }
  if (!strcmp(method, "tools/call")) {
    json_object *p = jget(request, "params");
    const char *name = jstr(p, "name", "");
    if (!mcp_allowed(name, bash))
      return mcp_result(id, result, "工具未暴露或权限不足");
    json_object *args = jget(p, "arguments");
    if (!args || !json_object_is_type(args, json_type_object))
      return mcp_result(id, result, "arguments 必须是对象");
    bool failed = false;
    pthread_mutex_lock(&server->agent_lock);
    server_active = &s;
    char *text = tool_execute(&s, name, args, NULL, &failed);
    server_active = NULL;
    pthread_mutex_unlock(&server->agent_lock);
    json_object *content = json_object_new_array(),
                *item = json_object_new_object();
    json_object_object_add(item, "type", json_object_new_string("text"));
    json_object_object_add(item, "text", json_object_new_string(text));
    free(text);
    json_object_array_add(content, item);
    json_object_object_add(result, "content", content);
    json_object_object_add(result, "isError", json_object_new_boolean(failed));
    return mcp_result(id, result, NULL);
  }
  return mcp_result(id, result, "不支持的 JSON-RPC 方法");
}
static void redact(json_object *j) {
  if (json_object_is_type(j, json_type_object)) {
    json_object_object_foreach(j, key, value) {
      if (secret_key(key))
        json_object_object_add(j, key, json_object_new_string("[hidden]"));
      else
        redact(value);
    }
  } else if (json_object_is_type(j, json_type_array))
    for (size_t i = 0; i < jlen(j); i++)
      redact(jat(j, i));
}
typedef struct {
  int fd;
  Session *session;
} Streaming;
static void stream_event(void *opaque, const char *kind, const char *text,
                         json_object *data) {
  Streaming *s = opaque;
  if (!strcmp(kind, "tick"))
    return;
  json_object *payload = json_object_new_object();
  json_object_object_add(payload, "type", json_object_new_string(kind));
  json_object_object_add(payload, "text", json_object_new_string(text));
  if (data)
    json_object_object_add(payload, "data", json_copy(data));
  char *raw = json_text(payload), *line = format("data: %s\n\n", raw);
  if (send_all(s->fd, line, strlen(line)))
    s->session->cancelled = 1;
  free(raw);
  free(line);
  json_object_put(payload);
}
static void handle(Server *s, int fd) {
  struct timeval timeout = {10, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
  Buffer request = {0};
  char chunk[4096];
  char *end = NULL;
  while (request.len < 65536 && !end) {
    ssize_t n = recv(fd, chunk, sizeof chunk, 0);
    if (n <= 0)
      goto cleanup;
    buf_add(&request, chunk, (size_t)n);
    end = strstr(request.data, "\r\n\r\n");
  }
  if (!end)
    goto cleanup;
  size_t header_len = (size_t)(end - request.data) + 4;
  char *headers = xmalloc(header_len + 1);
  memcpy(headers, request.data, header_len);
  headers[header_len] = 0;
  char method[16], path[2048];
  if (sscanf(headers, "%15s %2047s", method, path) != 2) {
    free(headers);
    goto cleanup;
  }
  size_t body_len = 0;
  bool valid = true;
  char *line = headers;
  while ((line = strstr(line, "\r\n"))) {
    line += 2;
    if (!strncasecmp(line, "Content-Length:", 15)) {
      char *tail;
      unsigned long value = strtoul(line + 15, &tail, 10);
      if ((*tail != '\r' && *tail != ' ' && *tail != '\t') ||
          value > DITO_MAX_BODY)
        valid = false;
      body_len = (size_t)value;
    }
    if (!strncasecmp(line, "Transfer-Encoding:", 18))
      valid = false;
  }
  char *host = header_value(headers, "Host"),
       *allowed_host = format("127.0.0.1:%d", s->port),
       *allowed_localhost = format("localhost:%d", s->port);
  bool host_ok = host && (!strcasecmp(host, allowed_host) ||
                          !strcasecmp(host, allowed_localhost) ||
                          (s->port == 80 && (!strcasecmp(host, "localhost") ||
                                             !strcmp(host, "127.0.0.1"))));
  free(host);
  free(allowed_host);
  free(allowed_localhost);
  if (!host_ok) {
    json_object *e = error_json("Host 不被允许");
    response(fd, 403, e);
    json_object_put(e);
    free(headers);
    goto cleanup;
  }
  char *origin = header_value(headers, "Origin"),
       *content_type = header_value(headers, "Content-Type");
  char *expected_origin = format("http://127.0.0.1:%d", s->port),
       *localhost_origin = format("http://localhost:%d", s->port);
  bool origin_ok = !origin || !strcmp(origin, expected_origin) ||
                   !strcmp(origin, localhost_origin);
  free(origin);
  free(expected_origin);
  free(localhost_origin);
  bool json_type_ok =
      !body_len ||
      (content_type && !strncasecmp(content_type, "application/json", 16));
  free(content_type);
  if (!origin_ok || (!strcmp(method, "POST") && !json_type_ok)) {
    json_object *e = error_json("跨站请求或 Content-Type 不被允许");
    response(fd, 403, e);
    json_object_put(e);
    free(headers);
    goto cleanup;
  }
  const char *token = jstr(jpath(s->config->json, "native.http"), "token", "");
  if (*token) {
    char *expected = format("Bearer %s", token),
         *provided = header_value(headers, "Authorization");
    if (!provided || strlen(provided) != strlen(expected) ||
        CRYPTO_memcmp(provided, expected, strlen(expected))) {
      json_object *e = error_json("需要 Bearer 鉴权");
      response(fd, 401, e);
      json_object_put(e);
      free(expected);
      free(provided);
      free(headers);
      goto cleanup;
    }
    free(expected);
    free(provided);
  }
  free(headers);
  if (!valid) {
    json_object *e = error_json("请求头或请求体大小无效");
    response(fd, 400, e);
    json_object_put(e);
    goto cleanup;
  }
  while (request.len - header_len < body_len) {
    ssize_t n = recv(fd, chunk, sizeof chunk, 0);
    if (n <= 0)
      goto cleanup;
    if (request.len + (size_t)n > DITO_MAX_BODY + 65536)
      goto cleanup;
    buf_add(&request, chunk, (size_t)n);
  }
  request.data[header_len + body_len] = 0;
  json_object *body =
      body_len ? json_tokener_parse(request.data + header_len) : NULL;
  json_object *out = NULL;
  int status = 200;
  if (!strcmp(path, "/health") || !strcmp(path, "/api/status")) {
    out = json_object_new_object();
    json_object_object_add(out, "ok", json_object_new_boolean(true));
    json_object_object_add(out, "runtime", json_object_new_string("C17"));
    json_object_object_add(out, "migrationComplete",
                           json_object_new_boolean(false));
  } else if (!strcmp(path, "/mcp") && !strcmp(method, "POST")) {
    if (!body || !json_object_is_type(body, json_type_object)) {
      out = error_json("请求必须是 JSON-RPC 对象");
      status = 400;
    } else if (!jget(body, "id")) {
      out = json_object_new_object();
      status = 202;
    } else
      out = mcp(s, body);
  } else if (!strcmp(path, "/api/config") && !strcmp(method, "GET")) {
    out = json_copy(s->config->json);
    redact(out);
  } else if (!strcmp(path, "/api/sessions") && !strcmp(method, "GET"))
    out = session_list(s->config, NULL);
  else if (!strcmp(path, "/api/chat") && !strcmp(method, "POST")) {
    const char *text = jstr(body, "text", "");
    if (!*text) {
      out = error_json("text 不能为空");
      status = 400;
    } else {
      const char *header = "HTTP/1.1 200 OK\r\nContent-Type: "
                           "text/event-stream\r\nCache-Control: "
                           "no-store\r\nConnection: close\r\n\r\n";
      send_all(fd, header, strlen(header));
      pthread_mutex_lock(&s->agent_lock);
      Session session;
      if (!session_open(&session, s->config, jbool(body, "fresh", false), NULL,
                        "web")) {
        Streaming stream = {fd, &session};
        Events events = {stream_event, &stream};
        server_active = &session;
        agent_turn(&session, text, NULL, &events);
        server_active = NULL;
      }
      session_close(&session);
      pthread_mutex_unlock(&s->agent_lock);
      if (body)
        json_object_put(body);
      goto cleanup;
    }
  } else {
    status = 404;
    out = error_json("原生版本尚未实现该接口");
  }
  response(fd, status, out);
  json_object_put(out);
  if (body)
    json_object_put(body);
cleanup:
  buf_free(&request);
}
int serve_http(Config *config, const char *kind, int port) {
  int sock = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (sock < 0)
    return 1;
  int yes = 1;
  setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  struct sockaddr_in addr = {.sin_family = AF_INET,
                             .sin_port = htons((unsigned short)port)};
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  if (bind(sock, (struct sockaddr *)&addr, sizeof addr) || listen(sock, 16)) {
    perror("本地 HTTP 服务");
    close(sock);
    return 1;
  }
  Server server = {.config = config,
                   .kind = kind,
                   .port = port,
                   .agent_lock = PTHREAD_MUTEX_INITIALIZER};
  stopping = 0;
  signal(SIGINT, stop_server);
  signal(SIGTERM, stop_server);
  printf("Dito C %s @ http://127.0.0.1:%d%s\n", kind, port,
         !strcmp(kind, "mcp") ? "/mcp" : "");
  fflush(stdout);
  while (!stopping) {
    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(sock, &fds);
    struct timeval tv = {0, 200000};
    int n = select(sock + 1, &fds, NULL, NULL, &tv);
    if (n <= 0)
      continue;
    int fd = accept4(sock, NULL, NULL, SOCK_CLOEXEC);
    if (fd < 0)
      continue;
    handle(&server, fd);
    close(fd);
  }
  close(sock);
  pthread_mutex_destroy(&server.agent_lock);
  return 0;
}
