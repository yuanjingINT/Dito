#include "dito.h"
#include <locale.h>
#include <openssl/evp.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <unistd.h>

static Session *active_session;
static void interrupt(int sig) {
  (void)sig;
  if (active_session)
    active_session->cancelled = 1;
  else
    dito_exit_requested = 1;
}
static void help(void) {
  puts("Dito " DITO_VERSION
       " · C 原生入口\n用法：dito [--config 路径] [--native] "
       "[命令]\n  send [--fresh] [--scope 名称] [--image 路径] 消息\n  "
       "sessions                 列出已有会话\n  config [get 路径|set 路径 "
       "JSON]\n  doctor [--ci]            离线检查本地运行时\n  mcp [--port "
       "3878]        MCP HTTP 服务（仅本机）\n  web|qqadmin [--port 3880] "
       "本地管理 HTTP 服务\n  qq|matrix                频道（默认兼容层）\n  "
       "voice       "
       "             语音输入\n  animation [毫秒]         Miyu 扫描动画演示\n  "
       "capabilities             显示真实迁移状态\n  无参数                   "
       "进入 C 终端对话（支持两个会话同时工作）\n"
       "  legacy [旧版命令]       旧功能兼容入口（需要 Node）\n"
       "  qq/matrix/mobile/bridge/relay/voice/qqadmin/plugins 通过兼容层运行\n"
       "  Ctrl+T/Alt+D 新建 · Alt+A 上一会话 · Alt+1…9 标签 · Ctrl+W 会话 · "
       "Alt+W 历史 · Esc "
       "取消当前任务\n");
}
static json_object *image(const char *file) {
  size_t n = 0;
  char *bytes = read_file(file, 20u * 1024u * 1024u, &n);
  if (!bytes)
    return NULL;
  const unsigned char *p = (unsigned char *)bytes;
  const char *mime =
      n >= 8 && !memcmp(p, "\x89PNG\r\n\x1a\n", 8)          ? "image/png"
      : n >= 3 && p[0] == 255 && p[1] == 216 && p[2] == 255 ? "image/jpeg"
      : n >= 12 && !memcmp(p, "RIFF", 4) && !memcmp(p + 8, "WEBP", 4)
          ? "image/webp"
          : NULL;
  if (!mime) {
    free(bytes);
    return NULL;
  }
  unsigned char *encoded = xmalloc(4 * ((n + 2) / 3) + 1);
  int len = EVP_EncodeBlock(encoded, (unsigned char *)bytes, (int)n);
  free(bytes);
  if (len < 0) {
    free(encoded);
    return NULL;
  }
  char *url = format("data:%s;base64,%s", mime, encoded);
  free(encoded);
  json_object *item = json_object_new_object(),
              *value = json_object_new_object();
  json_object_object_add(item, "type", json_object_new_string("image_url"));
  json_object_object_add(value, "url", json_object_new_string(url));
  json_object_object_add(item, "image_url", value);
  free(url);
  return item;
}
static bool supports_images(Config *c) {
  json_object *provider = config_provider(c);
  const char *selected = jstr(jget(c->json, "model"), "chat", "");
  json_object *models = jget(provider, "models");
  for (size_t i = 0; i < jlen(models); i++) {
    json_object *model = jat(models, i);
    if (strcmp(jstr(model, "id", ""), selected))
      continue;
    json_object *input = jget(model, "input");
    if (!input)
      return true;
    for (size_t k = 0; k < jlen(input); k++) {
      json_object *value = jat(input, k);
      if (json_object_is_type(value, json_type_string) &&
          !strcmp(json_object_get_string(value), "image"))
        return true;
    }
    return false;
  }
  return true;
}
static int doctor(Config *c) {
  struct utsname u;
  uname(&u);
  json_object *provider = config_provider(c);
  printf("Dito C · 原生程序\n系统：%s "
         "%s\n资源：%s\n配置：%s\nlibcurl：%s\nSQLite：%s\n",
         u.sysname, u.machine, c->resource, c->config_file, curl_version(),
         sqlite3_libversion());
  if (!provider) {
    puts("体检结果：失败，当前供应商不存在");
    return 1;
  }
  puts("体检结果：本地运行时通过（未进行模型网络请求）");
  return 0;
}
int main(int argc, char **argv) {
  setlocale(LC_ALL, "");
  umask(0077);
  curl_global_init(CURL_GLOBAL_DEFAULT);
  signal(SIGPIPE, SIG_IGN);
  struct sigaction action = {0};
  action.sa_handler = interrupt;
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGTERM, &action, NULL);
  const char *file = NULL;
  bool native_only = false;
  int at = 1;
  while (at < argc) {
    if (at + 1 < argc && !strcmp(argv[at], "--config")) {
      file = argv[at + 1];
      at += 2;
    } else if (!strcmp(argv[at], "--native")) {
      native_only = true;
      at++;
    } else
      break;
  }
  if (at < argc && (!strcmp(argv[at], "--help") || !strcmp(argv[at], "-h"))) {
    help();
    curl_global_cleanup();
    return 0;
  }
  if (at < argc && !strcmp(argv[at], "--version")) {
    puts("Dito " DITO_VERSION " · C native entry + optional legacy bridge");
    curl_global_cleanup();
    return 0;
  }
  Config c;
  if (config_load(&c, argv[0], file)) {
    config_free(&c);
    curl_global_cleanup();
    return 1;
  }
  int rc = 0;
  const char *cmd = at < argc ? argv[at++] : NULL;
  if (cmd && !strcmp(cmd, "legacy"))
    rc = legacy_run(&c, NULL, argc - at, argv + at);
  else if (!native_only && legacy_available(&c) &&
           legacy_bridge_command(cmd, argc - at))
    rc = legacy_run(&c, cmd, argc - at, argv + at);
  else if (!native_only && legacy_available(&c) &&
           legacy_chat_required(&c, cmd))
    rc = legacy_run(&c, cmd, argc - at, argv + at);
  else if (!cmd)
    rc = terminal_chat(&c, false);
  else if (!strcmp(cmd, "doctor"))
    rc = doctor(&c);
  else if (!strcmp(cmd, "animation"))
    rc = terminal_animation_demo(
        at < argc ? (unsigned)strtoul(argv[at], NULL, 10) : 3000);
  else if (!strcmp(cmd, "capabilities")) {
    json_object *capabilities = json_tokener_parse(
        "{\"runtime\":\"C17\",\"nodeRequired\":false,\"migrationComplete\":"
        "false,\"implemented\":[\"config-json\",\"configuration-tui\","
        "\"sessions-jsonl\",\"openai-sse\",\"anthropic-sse\",\"responses-sse\","
        "\"tools\",\"ask-question-options\",\"legacy-tool-catalog\",\"sqlite-"
        "kb-long-memory\",\"context-compaction\",\"web-"
        "search-fetch\",\"scanner-animation\",\"terminal-"
        "chat\",\"parallel-terminal-sessions\",\"history-tabs\",\"thinking-"
        "tool-"
        "disclosures\",\"bash-sidebar\",\"mcp-http-server\",\"mcp-http-"
        "stdio-clients\",\"qq-onebot-"
        "text\"],\"pending\":[\"matrix-e2ee\",\"mobile-pairing-relay\",\"qq-"
        "feature-parity\",\"web-admin-feature-parity\",\"bridge\",\"voice-stt-"
        "tts-wake-word\",\"parallel-subagent-budgets\",\"model-metadata\","
        "\"provider-oauth\",\"prompt-crypto\",\"tui-"
        "feature-parity\",\"all-platform-packaging\"]}");
    json_object_object_add(capabilities, "legacyBridgeAvailable",
                           json_object_new_boolean(legacy_available(&c)));
    json_object_object_add(capabilities, "nodeRequiredForLegacy",
                           json_object_new_boolean(true));
    json_object_object_add(
        capabilities, "bridgedCommands",
        json_tokener_parse(
            "[\"qq\",\"qqadmin\",\"matrix\",\"mobile\",\"bridge\",\"relay\","
            "\"voice\",\"plugins\",\"config\"]"));
    puts(json_object_to_json_string_ext(capabilities, JSON_C_TO_STRING_PLAIN));
    json_object_put(capabilities);
  } else if (!strcmp(cmd, "sessions")) {
    json_object *list = session_list(&c, NULL);
    puts(json_object_to_json_string_ext(list, JSON_C_TO_STRING_PRETTY));
    json_object_put(list);
  } else if (!strcmp(cmd, "plugins")) {
    rc = config_ui(&c);
  } else if (!strcmp(cmd, "config")) {
    if (at == argc)
      rc = config_ui(&c);
    else if (!strcmp(argv[at], "get") && at + 1 < argc) {
      json_object *v = jpath(c.json, argv[at + 1]);
      if (v) {
        json_object *copy = json_redacted(v);
        puts(secret_key(argv[at + 1]) ? "[hidden]"
                                      : json_object_to_json_string_ext(
                                            copy, JSON_C_TO_STRING_PRETTY));
        json_object_put(copy);
      } else
        rc = 1;
    } else if (!strcmp(argv[at], "set") && at + 2 < argc) {
      json_object *v = json_tokener_parse(argv[at + 2]);
      if (!v && strcmp(argv[at + 2], "null"))
        rc = 1;
      else if (config_set(&c, argv[at + 1], v) || config_save(&c))
        rc = 1;
      if (v)
        json_object_put(v);
      if (!rc)
        puts("配置已保存");
    } else {
      help();
      rc = 2;
    }
  } else if (!strcmp(cmd, "mcp") || !strcmp(cmd, "web") ||
             !strcmp(cmd, "qqadmin")) {
    int port = !strcmp(cmd, "mcp") ? 3878 : 3880;
    if (at + 1 < argc && !strcmp(argv[at], "--port"))
      port = atoi(argv[at + 1]);
    if (port < 1 || port > 65535)
      rc = 2;
    else
      rc = serve_http(&c, cmd, port);
  } else if (!strcmp(cmd, "qq") || !strcmp(cmd, "matrix") ||
             !strcmp(cmd, "mobile") || !strcmp(cmd, "bridge") ||
             !strcmp(cmd, "relay"))
    rc = channel_run(&c, cmd);
  else if (!strcmp(cmd, "voice"))
    rc = voice_run(&c);
  else {
    bool explicit_send = !strcmp(cmd, "send") || !strcmp(cmd, "msg") ||
                         !strcmp(cmd, "message") || !strcmp(cmd, "-m");
    bool fresh = false;
    const char *scope = NULL;
    json_object *images = json_object_new_array();
    Buffer text = {0};
    if (!explicit_send)
      buf_puts(&text, cmd);
    bool literal = false;
    for (int i = at; i < argc; i++) {
      if (!literal && !strcmp(argv[i], "--")) {
        literal = true;
        continue;
      }
      if (!literal && (!strcmp(argv[i], "--fresh") || !strcmp(argv[i], "-f"))) {
        fresh = true;
        continue;
      }
      if (!literal && !strcmp(argv[i], "--scope") && i + 1 < argc) {
        scope = argv[++i];
        continue;
      }
      if (!literal && (!strcmp(argv[i], "--image") || !strcmp(argv[i], "-i")) &&
          i + 1 < argc) {
        json_object *v = image(argv[++i]);
        if (!v || jlen(images) >= 8) {
          if (v)
            json_object_put(v);
          fputs("图片无效、格式不支持或超过数量上限\n", stderr);
          rc = 2;
          break;
        }
        json_object_array_add(images, v);
        continue;
      }
      if (text.len)
        buf_puts(&text, " ");
      buf_puts(&text, argv[i]);
    }
    if (!rc && !text.len && explicit_send && !isatty(STDIN_FILENO)) {
      char chunk[4096];
      size_t n;
      while ((n = fread(chunk, 1, sizeof chunk, stdin))) {
        if (text.len + n > DITO_MAX_BODY) {
          rc = 2;
          break;
        }
        buf_add(&text, chunk, n);
      }
    }
    if (!rc && !text.len && !jlen(images)) {
      help();
      rc = 2;
    }
    if (!rc && jlen(images) && !supports_images(&c)) {
      fputs("当前模型未声明图片输入能力，请先切换支持图片的模型\n", stderr);
      rc = 2;
    }
    if (!rc && text.len && memchr(text.data, 0, text.len)) {
      fputs("消息包含 NUL 字节；请传入文本\n", stderr);
      rc = 2;
    }
    if (!rc) {
      Session s;
      if (session_open(&s, &c, fresh, NULL, scope)) {
        session_close(&s);
        rc = 1;
      } else {
        active_session = &s;
        Renderer renderer;
        render_init(&renderer, false);
        renderer.session = &s;
        Events events = {render_event, &renderer};
        rc =
            agent_turn(&s, text.data ? text.data : "", images, &events) ? 1 : 0;
        render_finish(&renderer);
        active_session = NULL;
        session_close(&s);
      }
    }
    buf_free(&text);
    json_object_put(images);
  }
  config_free(&c);
  curl_global_cleanup();
  return rc;
}
