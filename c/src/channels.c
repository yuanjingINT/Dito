#include "dito.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  char *text;
} Reply;
static void capture(void *opaque, const char *kind, const char *text,
                    json_object *data) {
  (void)data;
  Reply *r = opaque;
  if (!strcmp(kind, "end")) {
    free(r->text);
    r->text = xstrdup(text);
  }
}
static bool contains_id(json_object *ids, const char *id) {
  for (size_t i = 0; i < jlen(ids); i++)
    if (jat(ids, i) && !strcmp(json_object_get_string(jat(ids, i)), id))
      return true;
  return false;
}
static int ws_send(CURL *curl, json_object *j) {
  char *raw = json_text(j);
  size_t sent = 0;
  CURLcode code = curl_ws_send(curl, raw, strlen(raw), &sent, 0, CURLWS_TEXT);
  bool complete = code == CURLE_OK && sent == strlen(raw);
  free(raw);
  return complete ? 0 : -1;
}
static int qq(Config *c) {
  json_object *cfg = jpath(c->json, "channels.qq");
  const char *url = jstr(cfg, "url", "");
  if (!*url) {
    fputs("QQ WebSocket URL 未配置\n", stderr);
    return 1;
  }
  CURL *curl = curl_easy_init();
  if (!curl)
    return 1;
  struct curl_slist *headers = NULL;
  const char *token = jstr(cfg, "accessToken", "");
  char *auth = NULL;
  if (strpbrk(token, "\r\n")) {
    curl_easy_cleanup(curl);
    return 1;
  }
  if (*token) {
    auth = format("Authorization: Bearer %s", token);
    headers = curl_slist_append(headers, auth);
  }
  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_CONNECT_ONLY, 2L);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
  CURLcode rc = curl_easy_perform(curl);
  if (rc != CURLE_OK) {
    fprintf(stderr, "QQ 连接失败：%s\n", curl_easy_strerror(rc));
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    free(auth);
    return 1;
  }
  puts("Dito C QQ 频道已连接（文本消息；完整功能仍在迁移）");
  Buffer frame = {0};
  while (!dito_exit_requested) {
    char chunk[8192];
    size_t n = 0;
    const struct curl_ws_frame *meta = NULL;
    rc = curl_ws_recv(curl, chunk, sizeof chunk, &n, &meta);
    if (rc == CURLE_AGAIN) {
      usleep(20000);
      continue;
    }
    if (rc != CURLE_OK || !meta || meta->flags & CURLWS_CLOSE)
      break;
    if (meta->flags & CURLWS_PING) {
      size_t sent;
      curl_ws_send(curl, chunk, n, &sent, 0, CURLWS_PONG);
      continue;
    }
    if (n > DITO_MAX_BODY - frame.len)
      break;
    buf_add(&frame, chunk, n);
    if (meta->bytesleft || meta->flags & CURLWS_CONT)
      continue;
    json_object *msg = json_tokener_parse(frame.data);
    buf_reset(&frame);
    if (!msg)
      continue;
    if (strcmp(jstr(msg, "post_type", ""), "message")) {
      json_object_put(msg);
      continue;
    }
    const char *text = jstr(msg, "raw_message", "");
    json_object *user_id = jget(msg, "user_id"),
                *group_id = jget(msg, "group_id");
    if (!user_id || (!json_object_is_type(user_id, json_type_string) &&
                     !json_object_is_type(user_id, json_type_int))) {
      json_object_put(msg);
      continue;
    }
    char *user = xstrdup(json_object_get_string(user_id)),
         *group = xstrdup(group_id ? json_object_get_string(group_id) : "");
    bool is_group = !strcmp(jstr(msg, "message_type", ""), "group"),
         owner = contains_id(jget(cfg, "owners"), user);
    bool wake = !is_group;
    if (is_group) {
      json_object *keywords = jget(cfg, "wakeKeywords");
      for (size_t i = 0; i < jlen(keywords); i++)
        if (json_object_is_type(jat(keywords, i), json_type_string) &&
            *json_object_get_string(jat(keywords, i)) &&
            strstr(text, json_object_get_string(jat(keywords, i))))
          wake = true;
    }
    if (*text && wake) {
      char *scope = format("qq-%s-%s", is_group ? "group" : "private",
                           is_group ? group : user);
      Session s;
      if (!session_open_channel(&s, c, "qq", scope)) {
        s.allow_host = owner;
        s.interactive = false;
        Reply reply = {0};
        Events events = {capture, &reply};
        agent_turn(&s, text, NULL, &events);
        if (reply.text) {
          json_object *action = json_object_new_object(),
                      *params = json_object_new_object();
          json_object_object_add(
              action, "action",
              json_object_new_string(is_group ? "send_group_msg"
                                              : "send_private_msg"));
          json_object_object_add(
              params, is_group ? "group_id" : "user_id",
              json_copy(jget(msg, is_group ? "group_id" : "user_id")));
          json_object_object_add(params, "message",
                                 json_object_new_string(reply.text));
          json_object_object_add(action, "params", params);
          ws_send(curl, action);
          json_object_put(action);
          free(reply.text);
        }
      }
      session_close(&s);
      free(scope);
    }
    free(user);
    free(group);
    json_object_put(msg);
  }
  buf_free(&frame);
  curl_slist_free_all(headers);
  free(auth);
  curl_easy_cleanup(curl);
  return dito_exit_requested ? 0 : 1;
}
int channel_run(Config *c, const char *kind) {
  if (!strcmp(kind, "qq"))
    return qq(c);
  if (!strcmp(kind, "matrix")) {
    fputs("Matrix 端到端加密尚未迁入 "
          "C；原生版拒绝降级为明文。请继续使用当前已安装的 dito matrix。\n",
          stderr);
    return 2;
  }
  fprintf(stderr, "%s 的完整协议仍在迁移，原生版尚不能代替现有命令。\n", kind);
  return 2;
}
int voice_run(Config *c) {
  json_object *cfg = jpath(c->json, "plugins.voice");
  if (!jbool(cfg, "enabled", false)) {
    fputs("请先在配置中启用语音\n", stderr);
    return 1;
  }
  fputs("自动唤醒和语音识别尚未迁入 C，原生版不会自动开启麦克风。\n", stderr);
  return 2;
}
