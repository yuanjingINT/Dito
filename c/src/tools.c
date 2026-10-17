#include "dito.h"
#include <limits.h>
#include <math.h>
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
     "\"content\"", true, false},
    {"kb_remove", "删除知识库条目。", "\"entry\":{\"type\":\"string\"}",
     "\"entry\"", true, true},
    {"memory_remember", "保存一条明确的稳定事实。",
     "\"content\":{\"type\":\"string\"},\"source\":{\"type\":\"string\"}",
     "\"content\"", true, false},
    {"memory_search", "搜索长期记忆。",
     "\"query\":{\"type\":\"string\"},\"max_results\":{\"type\":\"integer\"},"
     "\"max\":{\"type\":\"integer\"}",
     "\"query\"", false, false},
    {"memory_search_events", "搜索过往对话和经历。",
     "\"query\":{\"type\":\"string\"},\"max_results\":{\"type\":\"integer\"}",
     "\"query\"", false, false},
    {"memory_stats", "查看记忆统计。", "", "", false, false},
    {"memory_forget", "将记忆标记为遗忘。", "\"id\":{\"type\":\"integer\"}",
     "\"id\"", true, true},
    {"ask_question",
     "向用户提问。支持选项弹窗及自定义回答；无交互界面时返回问题文本。",
     "\"question\":{\"type\":\"string\",\"minLength\":1},"
     "\"options\":{\"type\":\"array\",\"maxItems\":32,\"items\":{\"type\":"
     "\"string\",\"minLength\":1,\"maxLength\":4096}}",
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
     "", true, true}};
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
  if (!strcmp(name, "recall_memories") || !strcmp(name, "search_memory") ||
      !strcmp(name, "memory_recall"))
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
static bool schema_valid(json_object *schema, json_object *value,
                         unsigned depth) {
  if (depth > 32)
    return false;
  const char *type = jstr(schema, "type", "");
  enum json_type actual = json_object_get_type(value);
  if ((!strcmp(type, "object") && actual != json_type_object) ||
      (!strcmp(type, "array") && actual != json_type_array) ||
      (!strcmp(type, "string") && actual != json_type_string) ||
      (!strcmp(type, "integer") && actual != json_type_int) ||
      (!strcmp(type, "boolean") && actual != json_type_boolean) ||
      (!strcmp(type, "number") && actual != json_type_int &&
       actual != json_type_double))
    return false;
  json_object *choices = jget(schema, "enum");
  if (choices) {
    bool found = false;
    for (size_t i = 0; i < jlen(choices); i++)
      if (json_object_equal(jat(choices, i), value))
        found = true;
    if (!found)
      return false;
  }
  if (actual == json_type_string) {
    const char *text = json_object_get_string(value);
    size_t bytes = strlen(text), length = 0;
    if (bytes != (size_t)json_object_get_string_len(value))
      return false;
    for (size_t i = 0; i < bytes; i++)
      if (((unsigned char)text[i] & 0xc0) != 0x80)
        length++;
    if ((jget(schema, "minLength") &&
         length < (size_t)jint(schema, "minLength", 0)) ||
        (jget(schema, "maxLength") &&
         length > (size_t)jint(schema, "maxLength", 0)))
      return false;
  }
  if (actual == json_type_int || actual == json_type_double) {
    double number = json_object_get_double(value);
    if (!isfinite(number) ||
        (jget(schema, "minimum") &&
         number < json_object_get_double(jget(schema, "minimum"))) ||
        (jget(schema, "maximum") &&
         number > json_object_get_double(jget(schema, "maximum"))))
      return false;
  }
  if (actual == json_type_array) {
    if ((jget(schema, "minItems") &&
         jlen(value) < (size_t)jint(schema, "minItems", 0)) ||
        (jget(schema, "maxItems") &&
         jlen(value) > (size_t)jint(schema, "maxItems", 0)))
      return false;
    json_object *items = jget(schema, "items");
    for (size_t i = 0; items && i < jlen(value); i++)
      if (!schema_valid(items, jat(value, i), depth + 1))
        return false;
  }
  if (actual == json_type_object) {
    json_object *required = jget(schema, "required"),
                *properties = jget(schema, "properties");
    for (size_t i = 0; i < jlen(required); i++) {
      json_object *member;
      if (!json_object_object_get_ex(
              value, json_object_get_string(jat(required, i)), &member))
        return false;
    }
    json_object_object_foreach(value, key, member) {
      json_object *property = jget(properties, key);
      if (property && !schema_valid(property, member, depth + 1))
        return false;
      if (!property && jget(schema, "additionalProperties") &&
          !jbool(schema, "additionalProperties", true))
        return false;
    }
  }
  return true;
}
bool tool_args_valid(json_object *schema, json_object *args) {
  return json_object_is_type(args, json_type_object) &&
         schema_valid(schema, args, 0);
}
static bool valid_args(const Tool *tool, json_object *args) {
  char *raw =
      format("{\"type\":\"object\",\"properties\":{%s},\"required\":[%s]}",
             tool->properties, tool->required);
  json_object *schema = json_tokener_parse(raw);
  free(raw);
  bool valid = tool_args_valid(schema, args);
  json_object_put(schema);
  return valid;
}
static const char *tool_plugin(const char *name) {
  return !strncmp(name, "kb_", 3)           ? "plugins.knowledge_base"
         : !strncmp(name, "memory_", 7)     ? "plugins.memory"
         : !strncmp(name, "web_", 4)        ? "plugins.web_search"
         : !strcmp(name, "subagent")        ? "plugins.subagent"
         : !strcmp(name, "ask_question")    ? "plugins.ask"
         : !strcmp(name, "get_system_info") ? "plugins.system"
                                            : NULL;
}
static bool tool_enabled(Session *s, const Tool *t) {
  const char *plugin = tool_plugin(t->name);
  return !s->chat_only && !(s->readonly && t->write) &&
         !(!s->allow_host && t->host) &&
         (!plugin || jbool(jpath(s->config->json, plugin), "enabled", true));
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
    if (!tool_enabled(s, t))
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
  const char *old_names[] = {"pc_bash",
                             "system_info",
                             "search_knowledge_base",
                             "read_knowledge_base",
                             "list_knowledge_base",
                             "upload_to_knowledge_base",
                             "remove_knowledge_base",
                             "remember_fact",
                             "recall_memories",
                             "search_memory",
                             "memory_recall",
                             "recall_past_events"};
  size_t native_count = jlen(out);
  for (size_t i = 0; i < sizeof old_names / sizeof *old_names; i++)
    for (size_t j = 0; j < native_count; j++) {
      json_object *fn = jget(jat(out, j), "function");
      if (strcmp(alias(old_names[i]), jstr(fn, "name", "")))
        continue;
      json_object *copy = json_copy(jat(out, j));
      json_object_object_add(jget(copy, "function"), "name",
                             json_object_new_string(old_names[i]));
      json_object_array_add(out, copy);
      break;
    }
  legacy_append_tools(s, out);
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
  if (s->chat_only) {
    *failed = true;
    return xstrdup("闲聊模式不调用工具");
  }
  if (!strncmp(name, "mcp_", 4))
    return mcp_call(s, name, a, failed);
  const Tool *t = find(name);
  if (!t)
    return legacy_tool(s, name, a, events, failed);
  if (!tool_enabled(s, t)) {
    *failed = true;
    return xstrdup("当前模式或身份无权调用该工具");
  }
  if (!valid_args(t, a)) {
    *failed = true;
    return xstrdup("工具参数缺失或类型错误，未执行操作");
  }
  name = t->name;
  if (!strncmp(name, "web_", 4))
    return web_tool(s, name, a, events, failed);
  if (!strncmp(name, "kb_", 3) || !strncmp(name, "memory_", 7)) {
    if (!strcmp(name, "memory_search") && jget(a, "max") &&
        !jget(a, "max_results")) {
      json_object *mapped = json_copy(a);
      json_object_object_add(mapped, "max_results", json_copy(jget(a, "max")));
      char *result = storage_tool(s, name, mapped, failed);
      json_object_put(mapped);
      return result;
    }
    return storage_tool(s, name, a, failed);
  }
  if (!strcmp(name, "bash"))
    return shell(s, a, failed, events);
  if (!strcmp(name, "get_system_info")) {
    if (legacy_available(s->config))
      return legacy_tool(s, name, a, events, failed);
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
    const char *question = jstr(a, "question", "");
    json_object *options = jget(a, "options");
    Buffer prompt = {0};
    buf_puts(&prompt, question);
    for (size_t i = 0; i < jlen(options); i++) {
      char *option =
          format("\n%zu. %s", i + 1, json_object_get_string(jat(options, i)));
      buf_puts(&prompt, option);
      free(option);
    }
    if (!s->interactive) {
      char *text = format("请回答：%s", prompt.data);
      buf_free(&prompt);
      return text;
    }
    buf_puts(&prompt, "\n› ");
    char *line = s->choose ? s->choose(s->ask_opaque, question, options)
                 : s->ask  ? s->ask(s->ask_opaque, prompt.data)
                           : terminal_line(prompt.data);
    buf_free(&prompt);
    if (!line || !*line) {
      free(line);
      return xstrdup("用户未作答");
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
