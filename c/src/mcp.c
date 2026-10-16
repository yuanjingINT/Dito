#include "dito.h"
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

typedef struct {
  json_object *config, *tools;
  char *session_id;
  pid_t pid;
  int input, output;
  unsigned next_id;
  Buffer pending;
} Client;
typedef struct {
  Client clients[32];
  size_t count;
} Clients;
static char *tool_name(const char *server, const char *tool) {
  char *out = format("mcp_%s_%s", server, tool);
  for (char *p = out; *p; p++)
    if (!isalnum((unsigned char)*p) && *p != '-' && *p != '_')
      *p = '_';
  return out;
}
static void close_client(Client *c) {
  if (c->input >= 0)
    close(c->input);
  if (c->output >= 0)
    close(c->output);
  if (c->pid > 0) {
    kill(-c->pid, SIGTERM);
    uint64_t until = mono_ms() + 200;
    int status;
    while (waitpid(c->pid, &status, WNOHANG) == 0 && mono_ms() < until)
      usleep(10000);
    kill(-c->pid, SIGKILL);
    while (waitpid(c->pid, &status, 0) < 0 && errno == EINTR) {
    }
  }
  if (c->tools)
    json_object_put(c->tools);
  free(c->session_id);
  buf_free(&c->pending);
  memset(c, 0, sizeof *c);
  c->input = c->output = -1;
}
static int spawn_client(Client *c) {
  const char *command = jstr(c->config, "command", "");
  if (!*command)
    return -1;
  json_object *args = jget(c->config, "args");
  size_t n = jlen(args);
  if (n > 256)
    return -1;
  char **argv = xmalloc((n + 2) * sizeof *argv);
  argv[0] = (char *)command;
  for (size_t i = 0; i < n; i++) {
    json_object *a = jat(args, i);
    argv[i + 1] = (char *)(a ? json_object_get_string(a) : "");
  }
  argv[n + 1] = NULL;
  int in[2], out[2];
  if (pipe2(in, O_CLOEXEC)) {
    free(argv);
    return -1;
  }
  if (pipe2(out, O_CLOEXEC)) {
    close(in[0]);
    close(in[1]);
    free(argv);
    return -1;
  }
  pid_t pid = fork();
  if (pid == 0) {
    setpgid(0, 0);
    dup2(in[0], STDIN_FILENO);
    dup2(out[1], STDOUT_FILENO);
    int dev = open("/dev/null", O_WRONLY);
    if (dev >= 0)
      dup2(dev, STDERR_FILENO);
    close(in[0]);
    close(in[1]);
    close(out[0]);
    close(out[1]);
    if (dev >= 0)
      close(dev);
    json_object *env = jget(c->config, "env");
    if (env && json_object_is_type(env, json_type_object)) {
      json_object_object_foreach(env, key, val) {
        const char *value = json_object_get_string(val);
        if (value)
          setenv(key, value, 1);
      }
    }
    execvp(command, argv);
    _exit(127);
  }
  free(argv);
  close(in[0]);
  close(out[1]);
  if (pid < 0) {
    close(in[1]);
    close(out[0]);
    return -1;
  }
  setpgid(pid, pid);
  c->pid = pid;
  c->input = in[1];
  c->output = out[0];
  fcntl(c->input, F_SETFL, O_NONBLOCK);
  fcntl(c->output, F_SETFL, O_NONBLOCK);
  return 0;
}
static int send_stdio(Client *c, const char *text, size_t n, Session *s) {
  size_t off = 0;
  uint64_t until = mono_ms() + 15000;
  while (off < n) {
    if (s->cancelled || dito_exit_requested || mono_ms() > until)
      return -1;
    ssize_t k = write(c->input, text + off, n - off);
    if (k > 0)
      off += (size_t)k;
    else if (errno == EAGAIN || errno == EINTR) {
      struct pollfd f = {c->input, POLLOUT, 0};
      poll(&f, 1, 40);
    } else
      return -1;
  }
  return 0;
}
static json_object *receive_stdio(Client *c, unsigned id, Session *s) {
  uint64_t until = mono_ms() + 120000;
  while (!s->cancelled && !dito_exit_requested && mono_ms() < until) {
    char *newline = c->pending.data ? strchr(c->pending.data, '\n') : NULL;
    if (newline) {
      size_t length = (size_t)(newline - c->pending.data);
      char saved = *newline;
      *newline = 0;
      json_object *j = json_tokener_parse(c->pending.data);
      *newline = saved;
      memmove(c->pending.data, newline + 1, c->pending.len - length);
      c->pending.len -= length + 1;
      if (j) {
        if ((unsigned)jint(j, "id", -1) == id)
          return j;
        json_object_put(j);
      }
      continue;
    }
    struct pollfd f = {c->output, POLLIN, 0};
    int rc = poll(&f, 1, 40);
    if (rc < 0 && errno != EINTR)
      return NULL;
    if (rc <= 0)
      continue;
    char data[8192];
    ssize_t n = read(c->output, data, sizeof data);
    if (n == 0)
      return NULL;
    if (n < 0) {
      if (errno == EINTR || errno == EAGAIN)
        continue;
      return NULL;
    }
    if ((size_t)n > DITO_MAX_BODY - c->pending.len)
      return NULL;
    buf_add(&c->pending, data, (size_t)n);
  }
  return NULL;
}
typedef struct {
  Client *client;
  Buffer body;
} HttpReply;
static size_t response_body(char *p, size_t size, size_t n, void *opaque) {
  HttpReply *r = opaque;
  size_t z = size * n;
  if (z > DITO_MAX_BODY - r->body.len)
    return 0;
  buf_add(&r->body, p, z);
  return z;
}
static size_t response_header(char *p, size_t size, size_t n, void *opaque) {
  HttpReply *r = opaque;
  size_t z = size * n;
  const char *prefix = "mcp-session-id:";
  if (z > strlen(prefix) && !strncasecmp(p, prefix, strlen(prefix))) {
    size_t start = strlen(prefix);
    while (start < z && (p[start] == ' ' || p[start] == '\t'))
      start++;
    size_t end = z;
    while (end > start &&
           (p[end - 1] == '\r' || p[end - 1] == '\n' || p[end - 1] == ' '))
      end--;
    if (end - start > 4096)
      return 0;
    free(r->client->session_id);
    r->client->session_id = xmalloc(end - start + 1);
    memcpy(r->client->session_id, p + start, end - start);
    r->client->session_id[end - start] = 0;
  }
  return z;
}
static int mcp_http_progress(void *opaque, curl_off_t a, curl_off_t b,
                             curl_off_t c, curl_off_t d) {
  (void)a;
  (void)b;
  (void)c;
  (void)d;
  Session *s = opaque;
  return s->cancelled || dito_exit_requested ? 1 : 0;
}
typedef struct {
  unsigned id;
  json_object *reply;
} SseReply;
static int http_sse(void *opaque, const char *name, const char *data) {
  (void)name;
  SseReply *r = opaque;
  json_object *j = json_tokener_parse(data);
  if (j && (unsigned)jint(j, "id", -1) == r->id) {
    if (r->reply)
      json_object_put(r->reply);
    r->reply = j;
  } else if (j)
    json_object_put(j);
  return 0;
}
static json_object *rpc(Session *s, Client *c, const char *method,
                        json_object *params, bool notification) {
  json_object *request = json_object_new_object();
  json_object_object_add(request, "jsonrpc", json_object_new_string("2.0"));
  unsigned id = ++c->next_id;
  if (!notification)
    json_object_object_add(request, "id", json_object_new_int64(id));
  json_object_object_add(request, "method", json_object_new_string(method));
  if (params)
    json_object_object_add(request, "params", json_copy(params));
  char *raw = json_text(request);
  json_object_put(request);
  json_object *reply = NULL;
  if (!strcmp(jstr(c->config, "transport", "stdio"), "stdio")) {
    Buffer line = {0};
    buf_puts(&line, raw);
    buf_puts(&line, "\n");
    if (!send_stdio(c, line.data, line.len, s) && !notification)
      reply = receive_stdio(c, id, s);
    buf_free(&line);
  } else {
    CURL *curl = curl_easy_init();
    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers,
                                "Accept: application/json, text/event-stream");
    headers = curl_slist_append(headers, "MCP-Protocol-Version: 2025-03-26");
    if (c->session_id) {
      char *h = format("Mcp-Session-Id: %s", c->session_id);
      headers = curl_slist_append(headers, h);
      free(h);
    }
    json_object *extra = jget(c->config, "headers");
    if (extra && json_object_is_type(extra, json_type_object)) {
      json_object_object_foreach(extra, key, val) {
        const char *value = json_object_get_string(val);
        if (!value || strpbrk(key, "\r\n:") || strpbrk(value, "\r\n"))
          continue;
        if (value[0] == '$') {
          const char *env = getenv(value + 1);
          value = env ? env : "";
        }
        char *h = format("%s: %s", key, value);
        headers = curl_slist_append(headers, h);
        free(h);
      }
    }
    HttpReply response = {.client = c};
    curl_easy_setopt(curl, CURLOPT_URL, jstr(c->config, "url", ""));
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, raw);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(raw));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, response_body);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, response_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response);
    curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, mcp_http_progress);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, s);
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 15000L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 120000L);
    CURLcode code = curl_easy_perform(curl);
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    if (code == CURLE_OK && status >= 200 && status < 300 &&
        response.body.data) {
      reply = json_tokener_parse(response.body.data);
      if (!reply) {
        SSE stream;
        sse_init(&stream);
        SseReply parsed = {.id = id};
        if (!sse_feed(&stream, response.body.data, response.body.len, http_sse,
                      &parsed) &&
            !sse_finish(&stream, http_sse, &parsed))
          reply = parsed.reply;
        else if (parsed.reply)
          json_object_put(parsed.reply);
        sse_free(&stream);
      }
    }
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    buf_free(&response.body);
  }
  free(raw);
  return reply;
}
static Clients *clients(Session *s) {
  if (s->mcp)
    return s->mcp;
  Clients *set = calloc(1, sizeof *set);
  if (!set)
    exit(70);
  s->mcp = set;
  json_object *config = jpath(s->config->json, "plugins.mcp");
  if (!jbool(config, "enabled", true))
    return set;
  json_object *list = jget(config, "clients");
  for (size_t i = 0; i < jlen(list) && set->count < 32; i++) {
    json_object *cfg = jat(list, i);
    if (!jbool(cfg, "enabled", true))
      continue;
    Client *c = &set->clients[set->count];
    c->config = cfg;
    c->input = c->output = -1;
    if (!strcmp(jstr(cfg, "transport", "stdio"), "stdio") && spawn_client(c))
      continue;
    json_object *params = json_object_new_object(),
                *info = json_object_new_object();
    json_object_object_add(info, "name", json_object_new_string("dito"));
    json_object_object_add(info, "version",
                           json_object_new_string(DITO_VERSION));
    json_object_object_add(params, "clientInfo", info);
    json_object_object_add(params, "protocolVersion",
                           json_object_new_string("2025-03-26"));
    json_object_object_add(params, "capabilities", json_object_new_object());
    json_object *hello = rpc(s, c, "initialize", params, false);
    json_object_put(params);
    if (!hello || jget(hello, "error")) {
      if (hello)
        json_object_put(hello);
      close_client(c);
      continue;
    }
    json_object_put(hello);
    json_object *notification =
        rpc(s, c, "notifications/initialized", NULL, true);
    if (notification)
      json_object_put(notification);
    json_object *listed = rpc(s, c, "tools/list", NULL, false);
    if (listed) {
      c->tools = json_copy(jget(jget(listed, "result"), "tools"));
      json_object_put(listed);
    }
    if (!c->tools) {
      close_client(c);
      continue;
    }
    set->count++;
  }
  return set;
}
void mcp_append_tools(Session *s, json_object *out) {
  Clients *set = clients(s);
  for (size_t i = 0; i < set->count; i++) {
    Client *c = &set->clients[i];
    for (size_t k = 0; k < jlen(c->tools) && k < 512; k++) {
      json_object *tool = jat(c->tools, k);
      bool read_only = jbool(jget(tool, "annotations"), "readOnlyHint", false);
      if ((s->readonly || !s->allow_host) && !read_only)
        continue;
      char *name = tool_name(jstr(c->config, "name", "server"),
                             jstr(tool, "name", "tool"));
      json_object *def = json_object_new_object(),
                  *fn = json_object_new_object();
      json_object_object_add(def, "type", json_object_new_string("function"));
      json_object_object_add(fn, "name", json_object_new_string(name));
      json_object_object_add(
          fn, "description",
          json_object_new_string(jstr(tool, "description", "外部 MCP 工具")));
      json_object *schema = jget(tool, "inputSchema");
      if (!schema)
        schema = json_tokener_parse("{\"type\":\"object\",\"properties\":{}}");
      else
        schema = json_copy(schema);
      json_object_object_add(fn, "parameters", schema);
      json_object_object_add(def, "function", fn);
      json_object_array_add(out, def);
      free(name);
    }
  }
}
char *mcp_call(Session *s, const char *name, json_object *args, bool *failed) {
  Clients *set = clients(s);
  *failed = true;
  for (size_t i = 0; i < set->count; i++) {
    Client *c = &set->clients[i];
    for (size_t k = 0; k < jlen(c->tools); k++) {
      json_object *tool = jat(c->tools, k);
      char *registered = tool_name(jstr(c->config, "name", "server"),
                                   jstr(tool, "name", "tool"));
      bool same = !strcmp(name, registered);
      free(registered);
      if (!same)
        continue;
      if ((s->readonly || !s->allow_host) &&
          !jbool(jget(tool, "annotations"), "readOnlyHint", false))
        return xstrdup("权限门：外部 MCP 工具未声明只读能力");
      json_object *params = json_object_new_object();
      json_object_object_add(params, "name", json_copy(jget(tool, "name")));
      json_object_object_add(params, "arguments", json_copy(args));
      json_object *reply = rpc(s, c, "tools/call", params, false);
      json_object_put(params);
      if (!reply)
        return xstrdup("外部 MCP 调用失败或超时");
      json_object *result = jget(reply, "result"),
                  *error = jget(reply, "error");
      if (error) {
        char *text = format("MCP 错误：%s", jstr(error, "message", "未知错误"));
        json_object_put(reply);
        return text;
      }
      Buffer b = {0};
      json_object *content = jget(result, "content");
      for (size_t n = 0; n < jlen(content); n++) {
        json_object *item = jat(content, n);
        if (b.len)
          buf_puts(&b, "\n");
        if (!strcmp(jstr(item, "type", ""), "text"))
          buf_puts(&b, jstr(item, "text", ""));
        else {
          char *text = json_text(item);
          buf_puts(&b, text);
          free(text);
        }
        if (b.len > DITO_MAX_TOOL) {
          b.len = DITO_MAX_TOOL;
          b.data[b.len] = 0;
          break;
        }
      }
      *failed = jbool(result, "isError", false);
      json_object_put(reply);
      if (!b.data)
        buf_puts(&b, "(空结果)");
      return b.data;
    }
  }
  return xstrdup("未注册的外部 MCP 工具");
}
void mcp_close(Session *s) {
  Clients *set = s->mcp;
  if (!set)
    return;
  for (size_t i = 0; i < set->count; i++)
    close_client(&set->clients[i]);
  free(set);
  s->mcp = NULL;
}
