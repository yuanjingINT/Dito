#include "dito.h"
#include <ctype.h>
#include <curses.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void merge(json_object *dst, json_object *src) {
  if (!json_object_is_type(dst, json_type_object) ||
      !json_object_is_type(src, json_type_object))
    return;
  json_object_object_foreach(src, k, v) {
    json_object *old = jget(dst, k);
    if (old && json_object_is_type(old, json_type_object) &&
        json_object_is_type(v, json_type_object))
      merge(old, v);
    else
      json_object_object_add(dst, k, json_copy(v));
  }
}
static void restore_presets(json_object *config, json_object *presets) {
  json_object *providers = jget(config, "providers");
  if (!json_object_is_type(providers, json_type_array))
    return;
  for (size_t i = 0; i < jlen(presets); i++) {
    json_object *preset = jat(presets, i), *existing = NULL;
    const char *id = jstr(preset, "id", "");
    for (size_t j = 0; j < jlen(providers); j++)
      if (!strcmp(id, jstr(jat(providers, j), "id", ""))) {
        existing = jat(providers, j);
        break;
      }
    if (!existing)
      json_object_array_add(providers, json_copy(preset));
    else if (!jlen(jget(existing, "models")) && jlen(jget(preset, "models")))
      json_object_object_add(existing, "models",
                             json_copy(jget(preset, "models")));
  }
}
static char *resources(const char *argv0) {
  const char *env = getenv("DITO_RESOURCE_DIR");
  if (env && *env)
    return xstrdup(env);
  char exe[PATH_MAX];
  ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
  if (n < 0) {
    if (!realpath(argv0, exe))
      return NULL;
  } else
    exe[n] = 0;
  char *slash = strrchr(exe, '/');
  if (slash)
    *slash = 0;
  for (int i = 0; i < 5; i++) {
    char *p = format("%s/config/dito.json", exe);
    bool found = access(p, R_OK) == 0;
    free(p);
    if (found)
      return xstrdup(exe);
    slash = strrchr(exe, '/');
    if (!slash)
      break;
    *slash = 0;
  }
  return NULL;
}
int config_load(Config *c, const char *argv0, const char *override) {
  memset(c, 0, sizeof *c);
  c->resource = resources(argv0);
  if (!c->resource) {
    fputs("找不到 config/dito.json，请设置 DITO_RESOURCE_DIR\n", stderr);
    return -1;
  }
  const char *home = getenv("HOME");
  if (!home)
    home = ".";
  const char *agent = getenv("PI_CODING_AGENT_DIR");
  c->data_dir =
      agent ? format("%s/dito", agent) : format("%s/.pi/agent/dito", home);
  c->config_file =
      override ? xstrdup(override) : format("%s/config.json", c->data_dir);
  const char *user = getenv("DITO_USER_DIR");
  c->user_dir = user ? xstrdup(user) : format("%s/user", c->data_dir);
  char *defaults = format("%s/config/dito.json", c->resource);
  c->json = json_read(defaults);
  free(defaults);
  if (!c->json || !json_object_is_type(c->json, json_type_object))
    return -1;
  if (access(c->config_file, F_OK) == 0) {
    json_object *custom = json_read(c->config_file);
    if (!custom || !json_object_is_type(custom, json_type_object)) {
      fputs("配置不是有效 JSON 对象，拒绝覆盖\n", stderr);
      if (custom)
        json_object_put(custom);
      return -1;
    }
    json_object *presets = json_copy(jget(c->json, "providers"));
    merge(c->json, custom);
    restore_presets(c->json, presets);
    json_object_put(presets);
    json_object_put(custom);
  }
  if (!json_object_is_type(jget(c->json, "model"), json_type_object) ||
      !json_object_is_type(jget(c->json, "providers"), json_type_array) ||
      !json_object_is_type(jget(c->json, "channels"), json_type_object)) {
    fputs("model、providers 或 channels 配置类型错误，拒绝启动\n", stderr);
    return -1;
  }
  for (size_t i = 0; i < 2; i++) {
    const char *channel = i ? "matrix" : "qq";
    char *p = format("%s/%s/config.json", c->user_dir, channel);
    json_object *private = json_read(p);
    bool exists = access(p, F_OK) == 0;
    free(p);
    if (exists && !json_object_is_type(private, json_type_object)) {
      fprintf(stderr, "%s 私有配置不是有效 JSON 对象，拒绝切换账号\n", channel);
      if (private)
        json_object_put(private);
      return -1;
    }
    if (private) {
      json_object *dest = jget(jget(c->json, "channels"), channel);
      if (!json_object_is_type(dest, json_type_object)) {
        dest = json_object_new_object();
        json_object_object_add(jget(c->json, "channels"), channel, dest);
      }
      merge(dest, private);
      json_object_put(private);
    }
  }
  return 0;
}
void config_free(Config *c) {
  if (c->json)
    json_object_put(c->json);
  free(c->resource);
  free(c->data_dir);
  free(c->config_file);
  free(c->user_dir);
  memset(c, 0, sizeof *c);
}
int config_save(Config *c) {
  char *dir = xstrdup(c->config_file);
  char *p = strrchr(dir, '/');
  if (p)
    *p = 0;
  if (mkdir_private(dir)) {
    free(dir);
    return -1;
  }
  free(dir);
  json_object *out = json_copy(c->json);
  json_object *channels = jget(out, "channels");
  if (channels) {
    const char *names[] = {"qq", "matrix"};
    for (size_t i = 0; i < 2; i++) {
      json_object *channel = jget(channels, names[i]);
      if (!channel)
        continue;
      char *private_dir = format("%s/%s", c->user_dir, names[i]);
      if (mkdir_private(private_dir)) {
        free(private_dir);
        json_object_put(out);
        return -1;
      }
      char *private_path = format("%s/config.json", private_dir);
      free(private_dir);
      const char *private_text =
          json_object_to_json_string_ext(channel, JSON_C_TO_STRING_PRETTY);
      int result =
          write_atomic(private_path, private_text, strlen(private_text));
      free(private_path);
      if (result) {
        json_object_put(out);
        return -1;
      }
    }
    json_object_object_del(channels, "qq");
    json_object_object_del(channels, "matrix");
  }
  const char *s = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PRETTY);
  int rc = write_atomic(c->config_file, s, strlen(s));
  json_object_put(out);
  return rc;
}
int config_set(Config *c, const char *path, json_object *value) {
  if (!path || !*path || strstr(path, ".."))
    return -1;
  char *s = xstrdup(path), *last = strrchr(s, '.');
  json_object *parent = c->json;
  char *key = s;
  if (last) {
    *last = 0;
    parent = jpath(c->json, s);
    key = last + 1;
  }
  if (!parent || !*key) {
    free(s);
    return -1;
  }
  int rc = 0;
  if (json_object_is_type(parent, json_type_object))
    json_object_object_add(parent, key, json_copy(value));
  else if (json_object_is_type(parent, json_type_array)) {
    char *end;
    unsigned long i = strtoul(key, &end, 10);
    if (*end || i > jlen(parent))
      rc = -1;
    else
      json_object_array_put_idx(parent, i, json_copy(value));
  } else
    rc = -1;
  free(s);
  return rc;
}
json_object *config_provider(Config *c) {
  json_object *arr = jget(c->json, "providers");
  const char *id = jstr(jget(c->json, "model"), "provider", "");
  for (size_t i = 0; i < jlen(arr); i++) {
    json_object *p = jat(arr, i);
    if (!strcmp(jstr(p, "id", ""), id))
      return p;
  }
  return NULL;
}
char *resolve_secret(const char *source) {
  while (isspace((unsigned char)*source))
    source++;
  size_t n = strlen(source);
  while (n && isspace((unsigned char)source[n - 1]))
    n--;
  char *key = xmalloc(n + 1);
  memcpy(key, source, n);
  key[n] = 0;
  if (key[0] == '$') {
    char *name = key + 1;
    if (n > 3 && key[1] == '{' && key[n - 1] == '}') {
      key[n - 1] = 0;
      name++;
    }
    const char *env = getenv(name);
    char *resolved = xstrdup(env ? env : "");
    free(key);
    key = resolved;
  }
  return key;
}
char *config_key(json_object *p) {
  return resolve_secret(jstr(p, "apiKey", ""));
}
json_object *config_model(Config *c) {
  json_object *models = jget(config_provider(c), "models");
  const char *selected = jstr(jget(c->json, "model"), "chat", "");
  for (size_t i = 0; i < jlen(models); i++)
    if (!strcmp(jstr(jat(models, i), "id", ""), selected))
      return jat(models, i);
  return NULL;
}
static int config_line_ui(Config *c) {
  puts(
      "Dito C 配置编辑器 · 输入路径读取，路径=JSON 修改，save 保存，exit 退出");
  puts("例如 model.chat / model.chat=\"big-pickle\" / providers.0.models");
  char *line = NULL;
  size_t cap = 0;
  bool dirty = false;
  while (fputs("配置 › ", stdout), fflush(stdout),
         getline(&line, &cap, stdin) > 0) {
    line[strcspn(line, "\r\n")] = 0;
    if (!strcmp(line, "exit"))
      break;
    if (!strcmp(line, "save")) {
      if (config_save(c))
        perror("保存");
      else {
        puts("已保存");
        dirty = false;
      }
      continue;
    }
    char *eq = strchr(line, '=');
    if (eq) {
      *eq = 0;
      json_object *v = json_tokener_parse(eq + 1);
      if (!v && strcmp(eq + 1, "null")) {
        puts("请输入有效 JSON 值");
        continue;
      }
      if (config_set(c, line, v))
        puts("配置路径不存在");
      else {
        puts("已修改，输入 save 保存");
        dirty = true;
      }
      if (v)
        json_object_put(v);
    } else {
      json_object *v = jpath(c->json, line);
      if (secret_key(line))
        puts(v ? "[已隐藏敏感字段]" : "路径不存在");
      else {
        json_object *copy = json_redacted(v);
        puts(copy
                 ? json_object_to_json_string_ext(copy, JSON_C_TO_STRING_PRETTY)
                 : "路径不存在");
        if (copy)
          json_object_put(copy);
      }
    }
  }
  free(line);
  if (dirty)
    puts("未保存的修改已丢弃");
  return 0;
}

static bool sensitive(const char *key) { return secret_key(key); }
int config_ui(Config *c) {
  if (!isatty(STDIN_FILENO) || !isatty(STDOUT_FILENO) ||
      (getenv("TERM") && !strcmp(getenv("TERM"), "dumb")))
    return config_line_ui(c);
  initscr();
  cbreak();
  noecho();
  keypad(stdscr, TRUE);
  curs_set(0);
  char path[4096] = "", notice[256] = "";
  size_t selected = 0, top = 0;
  bool dirty = false, quit = false;
  while (!quit && !dito_exit_requested) {
    json_object *node = *path ? jpath(c->json, path) : c->json;
    char **keys = NULL;
    size_t count = 0;
    if (json_object_is_type(node, json_type_object)) {
      count = json_object_object_length(node);
      keys = xmalloc((count ? count : 1) * sizeof *keys);
      size_t i = 0;
      json_object_object_foreach(node, key, value) {
        (void)value;
        if (i >= count)
          break;
        keys[i++] = xstrdup(key);
      }
      count = i;
    } else if (json_object_is_type(node, json_type_array)) {
      count = jlen(node);
      keys = xmalloc((count ? count : 1) * sizeof *keys);
      for (size_t i = 0; i < count; i++)
        keys[i] = format("%zu", i);
    }
    if (selected >= count)
      selected = count ? count - 1 : 0;
    int height = LINES - 6;
    if (height < 1)
      height = 1;
    if (selected < top)
      top = selected;
    if (selected >= top + (size_t)height)
      top = selected - (size_t)height + 1;
    erase();
    attron(A_BOLD);
    mvaddnstr(0, 1,
              "Dito C 配置 · ↑↓选择 / Enter进入或编辑 / ←返回 / s保存 / a新增 "
              "/ d删除 / q退出",
              COLS - 2);
    attroff(A_BOLD);
    mvprintw(2, 1, "%s%s", *path ? path : "根配置", dirty ? "  [未保存]" : "");
    for (size_t i = top; i < count && i < top + (size_t)height; i++) {
      json_object *value = json_object_is_type(node, json_type_array)
                               ? jat(node, i)
                               : jget(node, keys[i]);
      char *summary = NULL;
      if (json_object_is_type(value, json_type_object))
        summary = format("{对象 · %d 项}", json_object_object_length(value));
      else if (json_object_is_type(value, json_type_array))
        summary = format("[数组 · %zu 项]", jlen(value));
      else if (sensitive(keys[i]) || sensitive(path))
        summary = xstrdup("[敏感值已隐藏]");
      else
        summary = json_text(value);
      char *row = format("%s  %s", keys[i], summary);
      char *clean = safe_text(row);
      free(row);
      free(summary);
      if (i == selected)
        attron(A_REVERSE);
      mvaddnstr(4 + (int)(i - top), 2, clean, COLS - 4);
      if (i == selected)
        attroff(A_REVERSE);
      free(clean);
    }
    mvaddnstr(LINES - 1, 1, notice, COLS - 2);
    refresh();
    int key = getch();
    if (key == KEY_UP || key == 'k') {
      if (selected)
        selected--;
    } else if (key == KEY_DOWN || key == 'j') {
      if (selected + 1 < count)
        selected++;
    } else if (key == KEY_LEFT || key == KEY_BACKSPACE || key == 127) {
      char *dot = strrchr(path, '.');
      if (dot)
        *dot = 0;
      else
        path[0] = 0;
      selected = top = 0;
    } else if (key == 's') {
      if (config_save(c))
        snprintf(notice, sizeof notice, "保存失败，请检查目录权限");
      else {
        dirty = false;
        snprintf(notice, sizeof notice,
                 "已保存；QQ/Matrix 凭据保存在私有频道配置");
      }
    } else if (key == 'q' || key == 27) {
      if (!dirty)
        quit = true;
      else {
        snprintf(notice, sizeof notice, "还有未保存修改：s 保存，Q 丢弃并退出");
      }
    } else if (key == 'Q')
      quit = true;
    else if ((key == '\n' || key == KEY_ENTER) && count) {
      json_object *value = json_object_is_type(node, json_type_array)
                               ? jat(node, selected)
                               : jget(node, keys[selected]);
      if (json_object_is_type(value, json_type_object) ||
          json_object_is_type(value, json_type_array)) {
        size_t n = strlen(path);
        snprintf(path + n, sizeof path - n, "%s%s", n ? "." : "",
                 keys[selected]);
        selected = top = 0;
      } else {
        char edited[16384] = "";
        move(LINES - 2, 1);
        clrtoeol();
        addstr(json_object_is_type(value, json_type_string)
                   ? "输入新文字（留空保留）："
                   : "输入 JSON 值（留空保留）：");
        if (sensitive(keys[selected]) || sensitive(path))
          noecho();
        else
          echo();
        curs_set(1);
        getnstr(edited, sizeof edited - 1);
        noecho();
        curs_set(0);
        if (*edited) {
          json_object *new_value = json_object_is_type(value, json_type_string)
                                       ? json_object_new_string(edited)
                                       : json_tokener_parse(edited);
          if (new_value || !strcmp(edited, "null")) {
            if (json_object_is_type(node, json_type_array))
              json_object_array_put_idx(node, selected, new_value);
            else
              json_object_object_add(node, keys[selected], new_value);
            dirty = true;
            notice[0] = 0;
          } else
            snprintf(notice, sizeof notice, "无效 JSON，原值已保留");
        }
      }
    } else if (key == 'a') {
      char name[256] = "", raw[16384] = "";
      if (json_object_is_type(node, json_type_object)) {
        move(LINES - 2, 1);
        clrtoeol();
        addstr("新字段名：");
        echo();
        curs_set(1);
        getnstr(name, sizeof name - 1);
        noecho();
        curs_set(0);
      }
      move(LINES - 2, 1);
      clrtoeol();
      addstr("新增 JSON 值：");
      echo();
      curs_set(1);
      getnstr(raw, sizeof raw - 1);
      noecho();
      curs_set(0);
      json_object *value = json_tokener_parse(raw);
      if (value || !strcmp(raw, "null")) {
        if (json_object_is_type(node, json_type_array))
          json_object_array_add(node, value);
        else if (*name)
          json_object_object_add(node, name, value);
        else if (value)
          json_object_put(value);
        dirty = true;
      } else
        snprintf(notice, sizeof notice, "无效 JSON");
    } else if (key == 'd' && count) {
      snprintf(notice, sizeof notice, "按 D 确认删除 %s", keys[selected]);
      move(LINES - 1, 1);
      clrtoeol();
      addstr(notice);
      refresh();
      if (getch() == 'D') {
        if (json_object_is_type(node, json_type_array))
          json_object_array_del_idx(node, selected, 1);
        else
          json_object_object_del(node, keys[selected]);
        dirty = true;
      }
      notice[0] = 0;
    }
    for (size_t i = 0; i < count; i++)
      free(keys[i]);
    free(keys);
  }
  endwin();
  return 0;
}
