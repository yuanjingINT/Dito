#include "dito.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

bool legacy_available(Config *config) {
  const char *disabled = getenv("DITO_DISABLE_LEGACY");
  if (disabled && !strcmp(disabled, "1"))
    return false;
  char *entry = format("%s/legacy/entry.mjs", config->resource);
  bool available = access(entry, R_OK) == 0;
  free(entry);
  return available;
}
bool legacy_bridge_command(const char *command, int nargs) {
  if (!command)
    return false;
  if (!strcmp(command, "config") && !nargs)
    return true; /* Dedicated model metadata/authentication and setup panels. */
  const char *commands[] = {"qq",     "qqadmin", "matrix", "mobile",
                            "bridge", "relay",   "voice",  "plugins"};
  for (size_t i = 0; i < sizeof commands / sizeof *commands; i++)
    if (!strcmp(command, commands[i]))
      return true;
  return false;
}
bool legacy_chat_required(Config *config, const char *command) {
  const char *management[] = {
      "doctor", "animation", "capabilities", "sessions", "plugins", "config",
      "mcp",    "web",       "qqadmin",      "qq",       "matrix",  "mobile",
      "bridge", "relay",     "voice",        "legacy"};
  for (size_t i = 0; command && i < sizeof management / sizeof *management; i++)
    if (!strcmp(command, management[i]))
      return false;
  json_object *provider = config_provider(config),
              *model = config_model(config);
  const char *api =
      jstr(model, "api", jstr(provider, "api", "openai-completions"));
  if (strcmp(api, "openai-completions") && strcmp(api, "openai-responses") &&
      strcmp(api, "anthropic-messages"))
    return true;
  const char *bundle = getenv("DITO_PROMPT_BUNDLE");
  char *default_bundle =
      format("%s/desktop/prompts/dito-prompts.bin", config->resource);
  bool encrypted =
      access(bundle && *bundle ? bundle : default_bundle, R_OK) == 0;
  free(default_bundle);
  if (encrypted)
    return true;
  char *key = config_key(provider);
  bool configured_key = key && *key;
  free(key);
  if (configured_key)
    return false;
  char *parent = xstrdup(config->data_dir), *slash = strrchr(parent, '/');
  if (slash)
    *slash = 0;
  char *auth_file = format("%s/auth.json", parent);
  free(parent);
  json_object *auth = json_read(auth_file);
  free(auth_file);
  json_object *credential = jget(auth, jstr(provider, "id", ""));
  const char *type = jstr(credential, "type", "");
  bool stored_auth = !strcmp(type, "oauth") || !strcmp(type, "api_key");
  if (auth)
    json_object_put(auth);
  return stored_auth;
}
int legacy_run(Config *config, const char *command, int nargs, char **args) {
  if (!legacy_available(config)) {
    fputs("旧功能兼容层未安装或已禁用。请运行 packaging/install-native.sh；"
          "C 原生功能仍可直接使用。\n",
          stderr);
    return 1;
  }
  char *entry = format("%s/legacy/entry.mjs", config->resource);
  char *loader = format("%s/legacy/register-loader.mjs", config->resource);
  char **argv = xmalloc(((size_t)nargs + 6) * sizeof *argv);
  size_t at = 0;
  argv[at++] = "node";
  argv[at++] = "--import";
  argv[at++] = loader;
  argv[at++] = entry;
  if (command)
    argv[at++] = (char *)command;
  for (int i = 0; i < nargs; i++)
    argv[at++] = args[i];
  argv[at] = NULL;
  /* Share only the existing local paths, never copy private data into
   * resources. argv passes arguments literally, without a shell or quoting
   * expansion. */
  setenv("DITO_RESOURCE_DIR", config->resource, 1);
  setenv("DITO_CONFIG_FILE", config->config_file, 1);
  char *parent = xstrdup(config->data_dir), *slash = strrchr(parent, '/');
  if (slash)
    *slash = 0;
  setenv("PI_CODING_AGENT_DIR", parent, 1);
  setenv("DITO_USER_DIR", config->user_dir, 1);
  free(parent);
  curl_global_cleanup();
  execvp(argv[0], argv);
  fprintf(stderr, "无法启动旧功能兼容层：%s；请安装 Node ≥ 22.5。\n",
          strerror(errno));
  free(argv);
  free(loader);
  free(entry);
  /* main owns the final global cleanup on exec failure. */
  curl_global_init(CURL_GLOBAL_DEFAULT);
  return 1;
}
char *legacy_subagent(Session *session, json_object *args, Events *events,
                      bool *failed) {
  if (!legacy_available(session->config) || session->readonly ||
      !session->allow_host) {
    *failed = true;
    return xstrdup("复杂子代理需要启用旧功能兼容层，且只能在标准主人模式使用");
  }
  const char *temp = getenv("TMPDIR");
  char *path =
      format("%s/dito-compat-subagent-XXXXXX", temp && *temp ? temp : "/tmp");
  int fd = mkstemp(path);
  if (fd < 0) {
    free(path);
    *failed = true;
    return xstrdup("无法创建私有子代理请求");
  }
  json_object *payload = json_object_new_object();
  json_object_object_add(payload, "args", json_copy(args));
  json_object_object_add(payload, "resource",
                         json_object_new_string(session->config->resource));
  json_object_object_add(payload, "config",
                         json_object_new_string(session->config->config_file));
  json_object_object_add(payload, "dataDir",
                         json_object_new_string(session->config->data_dir));
  json_object_object_add(payload, "userDir",
                         json_object_new_string(session->config->user_dir));
  json_object_object_add(
      payload, "scope",
      json_object_new_string(session->scope ? session->scope : ""));
  char *raw = json_text(payload);
  json_object_put(payload);
  FILE *file = fdopen(fd, "w");
  if (!file) {
    close(fd);
    unlink(path);
    free(path);
    free(raw);
    *failed = true;
    return xstrdup("无法写入私有子代理请求");
  }
  bool written = fputs(raw, file) >= 0;
  if (fclose(file))
    written = false;
  free(raw);
  if (!written) {
    unlink(path);
    free(path);
    *failed = true;
    return xstrdup("子代理请求写入失败");
  }
  char *entry = format("%s/legacy/entry.mjs", session->config->resource);
  char *loader =
      format("%s/legacy/register-loader.mjs", session->config->resource);
  char *argv[] = {"node", "--import", loader, entry, "--subagent", path, NULL};
  Buffer output = {0};
  event(events, "tool_progress", "兼容子代理调度中", NULL);
  *failed = process_run_with_events(argv, NULL, 300000, &session->cancelled,
                                    &output, events) != 0;
  unlink(path);
  free(path);
  free(entry);
  free(loader);
  return output.data ? output.data : xstrdup("兼容子代理无输出");
}
