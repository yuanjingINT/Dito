#include "dito.h"
#include <limits.h>
#include <regex.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <termios.h>
#include <unistd.h>

typedef struct {
  const char *name, *description, *properties, *required;
  bool write, host;
} Tool;
static const Tool tools[] = {
    {"bash", "运行 Bash 命令。危险操作经过权限门。",
     "\"command\":{\"type\":\"string\"},\"timeout\":{\"type\":\"integer\"}",
     "\"command\"", true, true},
    {"read", "读取文本文件。",
     "\"path\":{\"type\":\"string\"},\"offset\":{\"type\":\"integer\"},"
     "\"limit\":{\"type\":\"integer\"}",
     "\"path\"", false, true},
    {"write", "原子写入文本文件。",
     "\"path\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}",
     "\"path\",\"content\"", true, true},
    {"edit", "精确替换文件中唯一匹配的文本。",
     "\"path\":{\"type\":\"string\"},\"oldText\":{\"type\":\"string\"},"
     "\"newText\":{\"type\":\"string\"}",
     "\"path\",\"oldText\",\"newText\"", true, true},
    {"get_system_info", "获取操作系统和机器架构。", "", "", false, true},
    {"web_fetch", "读取 HTTP(S) 网页，结果作为不可信资料。",
     "\"url\":{\"type\":\"string\"},\"format\":{\"type\":\"string\"}",
     "\"url\"", false, false},
    {"web_search", "联网搜索，使用已配置的搜索供应商。",
     "\"query\":{\"type\":\"string\"},\"provider\":{\"type\":\"string\"},\"max_"
     "results\":{\"type\":\"integer\"}",
     "\"query\"", false, false},
    {"kb_search", "检索知识库。",
     "\"query\":{\"type\":\"string\"},\"max_results\":{\"type\":\"integer\"}",
     "\"query\"", false, false},
    {"kb_list", "列出知识库条目。", "\"keyword\":{\"type\":\"string\"}", "",
     false, false},
    {"kb_read", "分段读取知识库条目。",
     "\"entry\":{\"type\":\"string\"},\"start_line\":{\"type\":\"integer\"},"
     "\"max_lines\":{\"type\":\"integer\"}",
     "\"entry\"", false, false},
    {"kb_upload", "保存 Markdown 笔记。",
     "\"title\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"},"
     "\"name\":{\"type\":\"string\"}",
     "\"title\",\"content\"", true, false},
    {"kb_remove", "删除知识库条目。", "\"entry\":{\"type\":\"string\"}",
     "\"entry\"", true, true},
    {"memory_remember", "保存一条明确的稳定事实。",
     "\"content\":{\"type\":\"string\"},\"source\":{\"type\":\"string\"}",
     "\"content\"", true, false},
    {"memory_search", "搜索长期记忆。",
     "\"query\":{\"type\":\"string\"},\"max_results\":{\"type\":\"integer\"}",
     "\"query\"", false, false},
    {"memory_search_events", "搜索过往对话和经历。",
     "\"query\":{\"type\":\"string\"},\"max_results\":{\"type\":\"integer\"}",
     "\"query\"", false, false},
    {"memory_stats", "查看记忆统计。", "", "", false, false},
    {"memory_forget", "将记忆标记为遗忘。", "\"id\":{\"type\":\"integer\"}",
     "\"id\"", true, true},
    {"ask_question", "向终端用户提问。", "\"question\":{\"type\":\"string\"}",
     "\"question\"", false, true},
    {"subagent",
     "单任务使用原生 C；并行、串行链、选模和预算通过旧功能兼容层执行。",
     "\"task\":{\"type\":\"string\"},\"tasks\":{\"type\":\"array\",\"items\":{"
     "\"type\":\"object\"}},"
     "\"chain\":{\"type\":\"array\",\"items\":{\"type\":\"object\"}},\"agent\":"
     "{\"type\":\"string\"},"
     "\"model\":{\"type\":\"string\"},\"workType\":{\"type\":\"string\"},"
     "\"budgetUsd\":{\"type\":\"number\"},"
     "\"agentScope\":{\"type\":\"string\",\"enum\":[\"user\",\"project\","
     "\"both\"]},"
     "\"confirmProjectAgents\":{\"type\":\"boolean\"}",
     "", false, true}};
static const char *alias(const char *name) {
  if (!strcmp(name, "pc_bash"))
    return "bash";
  if (!strcmp(name, "system_info"))
    return "get_system_info";
  if (!strcmp(name, "search_knowledge_base"))
    return "kb_search";
  if (!strcmp(name, "read_knowledge_base"))
    return "kb_read";
  if (!strcmp(name, "list_knowledge_base"))
    return "kb_list";
  if (!strcmp(name, "upload_to_knowledge_base"))
    return "kb_upload";
  if (!strcmp(name, "remove_knowledge_base"))
    return "kb_remove";
  if (!strcmp(name, "remember_fact"))
    return "memory_remember";
  if (!strcmp(name, "recall_memories") || !strcmp(name, "search_memory"))
    return "memory_search";
  if (!strcmp(name, "recall_past_events"))
    return "memory_search_events";
  return name;
}
static const Tool *find(const char *name) {
  name = alias(name);
  for (size_t i = 0; i < sizeof tools / sizeof *tools; i++)
    if (!strcmp(name, tools[i].name))
      return &tools[i];
  return NULL;
}
static bool valid_args(const Tool *tool, json_object *args) {
  if (!json_object_is_type(args, json_type_object))
    return false;
  char *raw = format("[%s]", tool->required);
  json_object *required = json_tokener_parse(raw);
  free(raw);
  bool valid = true;
  for (size_t i = 0; i < jlen(required); i++)
    if (!jget(args, json_object_get_string(jat(required, i))))
      valid = false;
  json_object_put(required);
  raw = format("{%s}", tool->properties);
  json_object *properties = json_tokener_parse(raw);
  free(raw);
  json_object_object_foreach(properties, key, schema) {
    json_object *value = jget(args, key);
    if (!value)
      continue;
    const char *type = jstr(schema, "type", "");
    if (!strcmp(type, "string") &&
        (!json_object_is_type(value, json_type_string) ||
         (size_t)json_object_get_string_len(value) !=
             strlen(json_object_get_string(value))))
      valid = false;
    if (!strcmp(type, "integer") && !json_object_is_type(value, json_type_int))
      valid = false;
  }
  json_object_put(properties);
  return valid;
}
static int write_user_file(const char *path, const char *text, size_t length) {
  struct stat old;
  bool existed = stat(path, &old) == 0;
  char resolved[PATH_MAX];
  const char *target = path;
  if (existed) {
    if (!S_ISREG(old.st_mode) || !realpath(path, resolved))
      return -1;
    target = resolved;
  }
  int rc = write_atomic(target, text, length);
  if (!rc && existed && chmod(target, old.st_mode & 0777))
    rc = -1;
  return rc;
}
json_object *tool_definitions(Session *s) {
  json_object *out = json_object_new_array();
  if (s->chat_only)
    return out;
  for (size_t i = 0; i < sizeof tools / sizeof *tools; i++) {
    const Tool *t = &tools[i];
    if ((s->readonly && t->write) || (!s->allow_host && t->host))
      continue;
    if (!strncmp(t->name, "kb_", 3) &&
        !jbool(jpath(s->config->json, "plugins.knowledge_base"), "enabled",
               true))
      continue;
    if (!strncmp(t->name, "memory_", 7) &&
        !jbool(jpath(s->config->json, "plugins.memory"), "enabled", true))
      continue;
    if (!strncmp(t->name, "web_", 4) &&
        !jbool(jpath(s->config->json, "plugins.web_search"), "enabled", true))
      continue;
    json_object *def = json_object_new_object(), *fn = json_object_new_object();
    json_object_object_add(def, "type", json_object_new_string("function"));
    json_object_object_add(fn, "name", json_object_new_string(t->name));
    json_object_object_add(fn, "description",
                           json_object_new_string(t->description));
    char *schema =
        format("{\"type\":\"object\",\"properties\":{%s},\"required\":[%s]}",
               t->properties, t->required);
    json_object_object_add(fn, "parameters", json_tokener_parse(schema));
    free(schema);
    json_object_object_add(def, "function", fn);
    json_object_array_add(out, def);
  }
  if (s->messages)
    mcp_append_tools(s, out);
  return out;
}
static bool matches(const char *pattern, const char *text) {
  regex_t r;
  if (regcomp(&r, pattern, REG_EXTENDED | REG_ICASE | REG_NOSUB))
    return true;
  bool yes = regexec(&r, text, 0, NULL, 0) == 0;
  regfree(&r);
  return yes;
}
static char *terminal_line(const char *prompt) {
  struct termios saved, cooked;
  bool restore = false;
  if (!tcgetattr(STDIN_FILENO, &saved) && !(saved.c_lflag & ICANON)) {
    cooked = saved;
    cooked.c_lflag |= ICANON | ECHO | ISIG;
    cooked.c_cc[VMIN] = 1;
    restore = tcsetattr(STDIN_FILENO, TCSAFLUSH, &cooked) == 0;
    fputs("\x1b[H\x1b[2J\x1b[?25h", stdout);
  }
  char *clean = safe_text(prompt);
  printf("\n%s", clean);
  free(clean);
  fflush(stdout);
  char *line = NULL;
  size_t cap = 0;
  if (getline(&line, &cap, stdin) < 0) {
    free(line);
    line = NULL;
    clearerr(stdin);
  }
  if (restore) {
    tcsetattr(STDIN_FILENO, TCSAFLUSH, &saved);
    fputs("\x1b[?25l", stdout);
  }
  return line;
}
static int confirm(Session *s, const char *what) {
  if (s->sudo_mode)
    return 1;
  if (!s->interactive)
    return 0;
  char *prompt = format("确认执行：%s\n[y/N] ", what);
  char *answer = s->ask ? s->ask(s->ask_opaque, prompt) : terminal_line(prompt);
  free(prompt);
  int yes = answer && (answer[0] == 'y' || answer[0] == 'Y');
  free(answer);
  return yes;
}
static char *shell(Session *s, json_object *a, bool *failed, Events *events) {
  const char *cmd = jstr(a, "command", "");
  if (!*cmd) {
    *failed = true;
    return xstrdup("command 不能为空");
  }
  if (!s->sudo_mode) {
    const char *forbidden[] = {
        "[:][[:space:]]*[(][[:space:]]*[)][[:space:]]*[{][[:space:]]*:",
        "rm[[:space:]]+(-[a-z]*[rf][a-z]*[[:space:]]+)+/[[:space:]]*([*]|$)",
        "mkfs[.a-z0-9]*[[:space:]]+/dev/"};
    for (size_t i = 0; i < 3; i++)
      if (matches(forbidden[i], cmd)) {
        *failed = true;
        return xstrdup("权限门：禁止高危命令");
      }
    if (matches("(^|[;&|[:space:]])(rm|dd|mkfs|shutdown|reboot|poweroff|halt|"
                "fdisk|parted|wipefs|chmod|pacman|apt|apt-get|dnf|yum|zypper|"
                "apk|chown)([[:space:]]|$)",
                cmd) &&
        !confirm(s, cmd)) {
      *failed = true;
      return xstrdup("权限门：危险操作未获用户确认");
    }
  }
  Buffer out = {0};
  int timeout = jint(a, "timeout", 120);
  if (timeout < 1)
    timeout = 1;
  if (timeout > 600)
    timeout = 600;
  char *args[] = {"bash", "-lc", (char *)cmd, NULL};
  int rc = process_run_with_events(args, NULL, (unsigned)timeout * 1000,
                                   &s->cancelled, &out, events);
  *failed = rc != 0;
  char *result = format("%s\n[exit %d]", out.data ? out.data : "", rc);
  buf_free(&out);
  return result;
}
char *tool_execute(Session *s, const char *name, json_object *a, Events *events,
                   bool *failed) {
  *failed = false;
  if (!strncmp(name, "mcp_", 4))
    return mcp_call(s, name, a, failed);
  const Tool *t = find(name);
  if (!t) {
    *failed = true;
    return format("未知或未迁移的工具：%s", name);
  }
  if ((s->readonly && t->write) || (!s->allow_host && t->host)) {
    *failed = true;
    return xstrdup("当前模式或身份无权调用该工具");
  }
  if (!valid_args(t, a)) {
    *failed = true;
    return xstrdup("工具参数缺失或类型错误，未执行操作");
  }
  name = t->name;
  const char *plugin = !strncmp(name, "kb_", 3)       ? "plugins.knowledge_base"
                       : !strncmp(name, "memory_", 7) ? "plugins.memory"
                       : !strcmp(name, "subagent")    ? "plugins.subagent"
                       : !strcmp(name, "ask_question") ? "plugins.ask"
                                                       : NULL;
  if (plugin && !jbool(jpath(s->config->json, plugin), "enabled", true)) {
    *failed = true;
    return xstrdup("该插件已关闭，未执行工具");
  }
  if (!strncmp(name, "web_", 4))
    return web_tool(s, name, a, events, failed);
  if (!strncmp(name, "kb_", 3) || !strncmp(name, "memory_", 7))
    return storage_tool(s, name, a, failed);
  if (!strcmp(name, "bash"))
    return shell(s, a, failed, events);
  if (!strcmp(name, "get_system_info")) {
    struct utsname u;
    if (uname(&u)) {
      *failed = true;
      return xstrdup("系统信息读取失败");
    }
    return format("%s %s %s\nCPU cores: %ld", u.sysname, u.release, u.machine,
                  sysconf(_SC_NPROCESSORS_ONLN));
  }
  if (!strcmp(name, "read")) {
    const char *path = jstr(a, "path", "");
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode)) {
      *failed = true;
      return xstrdup("只接受普通文件，拒绝管道或设备");
    }
    char *raw = read_file(path, DITO_MAX_BODY, NULL);
    if (!raw) {
      *failed = true;
      return format("无法读取文件：%s", path);
    }
    int start = jint(a, "offset", 1), limit = jint(a, "limit", 200);
    if (start < 1)
      start = 1;
    if (limit < 1)
      limit = 1;
    if (limit > 2000)
      limit = 2000;
    char *p = raw;
    int line = 1;
    while (*p && line < start)
      if (*p++ == '\n')
        line++;
    Buffer b = {0};
    while (*p && line < start + limit) {
      char *end = strchr(p, '\n');
      if (!end)
        end = p + strlen(p);
      char *prefix = format("%d: ", line++);
      buf_puts(&b, prefix);
      free(prefix);
      buf_add(&b, p, (size_t)(end - p));
      buf_puts(&b, "\n");
      p = *end ? end + 1 : end;
    }
    free(raw);
    if (!b.data)
      buf_puts(&b, "");
    return b.data;
  }
  if (!strcmp(name, "write")) {
    const char *path = jstr(a, "path", ""), *text = jstr(a, "content", "");
    if (!*path) {
      *failed = true;
      return xstrdup("path 不能为空");
    }
    char *dir = xstrdup(path), *slash = strrchr(dir, '/');
    if (slash) {
      *slash = 0;
      if (*dir && mkdir_private(dir)) {
        free(dir);
        *failed = true;
        return xstrdup("无法创建父目录");
      }
    }
    free(dir);
    *failed = write_user_file(path, text, strlen(text)) != 0;
    return xstrdup(*failed ? "文件写入失败" : "文件已写入");
  }
  if (!strcmp(name, "edit")) {
    const char *path = jstr(a, "path", ""), *old = jstr(a, "oldText", ""),
               *replace = jstr(a, "newText", "");
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode)) {
      *failed = true;
      return xstrdup("只接受普通文件，拒绝管道或设备");
    }
    char *raw = read_file(path, DITO_MAX_BODY, NULL);
    char *at = raw && *old ? strstr(raw, old) : NULL;
    if (!at || strstr(at + strlen(old), old)) {
      free(raw);
      *failed = true;
      return xstrdup("旧文本必须在文件中恰好出现一次");
    }
    Buffer b = {0};
    buf_add(&b, raw, (size_t)(at - raw));
    buf_puts(&b, replace);
    buf_puts(&b, at + strlen(old));
    *failed = write_user_file(path, b.data, b.len) != 0;
    free(raw);
    buf_free(&b);
    return xstrdup(*failed ? "编辑失败" : "文件已编辑");
  }
  if (!strcmp(name, "ask_question")) {
    if (!s->interactive) {
      *failed = true;
      return xstrdup("当前界面不支持同步提问");
    }
    char *prompt = format("%s\n› ", jstr(a, "question", ""));
    char *line = s->ask ? s->ask(s->ask_opaque, prompt) : terminal_line(prompt);
    free(prompt);
    if (!line) {
      *failed = true;
      return xstrdup("用户未回答");
    }
    return line;
  }
  if (!strcmp(name, "subagent")) {
    if (jget(a, "tasks") || jget(a, "chain") || jget(a, "model") ||
        jget(a, "workType") || jget(a, "budgetUsd") || jget(a, "agent") ||
        jget(a, "agentScope"))
      return legacy_subagent(s, a, events, failed);
    if (!*jstr(a, "task", "")) {
      *failed = true;
      return xstrdup("请提供子代理 task、tasks 或 chain");
    }
    char exe[4096];
    ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (n < 0) {
      *failed = true;
      return xstrdup("子代理入口不可用");
    }
    exe[n] = 0;
    char *id = random_hex(8), *scope = format("subagent-%s", id ? id : "error");
    free(id);
    char *args[] = {exe,    "--config", s->config->config_file,
                    "send", "--fresh",  "--scope",
                    scope,  "--",       (char *)jstr(a, "task", ""),
                    NULL};
    Buffer out = {0};
    event(events, "tool_progress", "子代理运行中", NULL);
    int rc = process_run_with_events(args, NULL, 300000, &s->cancelled, &out,
                                     events);
    free(scope);
    *failed = rc != 0;
    return out.data ? out.data : xstrdup("子代理无输出");
  }
  *failed = true;
  return xstrdup("工具不可用");
}
