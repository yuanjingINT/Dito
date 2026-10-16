#include "dito.h"
#include <stdlib.h>
#include <string.h>

typedef struct {
  Session *session;
  Events *events;
  ModelResult *result;
  SSE sse;
  Buffer raw;
  Buffer arguments[128];
  size_t arguments_bytes;
  bool streamed, done;
  char *api;
} Transfer;
static void error_message(ModelResult *r, const char *s) {
  char *safe = safe_text(s);
  snprintf(r->error, sizeof r->error, "%s", safe);
  free(safe);
}
static void delta(Transfer *t, const char *kind, const char *text) {
  if (!text || !*text)
    return;
  if (!strcmp(kind, "text"))
    buf_puts(&t->result->text, text);
  else
    buf_puts(&t->result->reasoning, text);
  if (t->result->text.len + t->result->reasoning.len > DITO_MAX_BODY) {
    error_message(t->result, "模型输出超过 10 MiB 上限");
    return;
  }
  event(t->events, kind, text, NULL);
}
static json_object *call_at(Transfer *t, size_t index) {
  if (index >= 128) {
    error_message(t->result, "单轮工具调用超过 128 条");
    return NULL;
  }
  while (jlen(t->result->calls) <= index) {
    json_object *call = json_object_new_object();
    json_object_object_add(call, "id", json_object_new_string(""));
    json_object_object_add(call, "type", json_object_new_string("function"));
    json_object *fn = json_object_new_object();
    json_object_object_add(fn, "name", json_object_new_string(""));
    json_object_object_add(fn, "arguments", json_object_new_string(""));
    json_object_object_add(call, "function", fn);
    json_object_array_add(t->result->calls, call);
  }
  return jat(t->result->calls, index);
}
static void append_field(json_object *j, const char *key, const char *piece) {
  if (!piece || !*piece)
    return;
  char *value = format("%s%s", jstr(j, key, ""), piece);
  json_object_object_add(j, key, json_object_new_string(value));
  free(value);
}
static void append_arguments(Transfer *t, size_t index, const char *piece) {
  if (!call_at(t, index) || !piece || !*piece)
    return;
  size_t n = strlen(piece);
  if (n > DITO_MAX_BODY - t->arguments_bytes) {
    error_message(t->result, "工具参数超过 10 MiB 上限");
    return;
  }
  t->arguments_bytes += n;
  buf_add(&t->arguments[index], piece, n);
}
static void usage(Transfer *t, json_object *j) {
  json_object *u = jget(j, "usage");
  if (!u)
    return;
  t->result->input_tokens = jint(
      u, "prompt_tokens", jint(u, "input_tokens", t->result->input_tokens));
  t->result->output_tokens =
      jint(u, "completion_tokens",
           jint(u, "output_tokens", t->result->output_tokens));
}
static int handle_chunk(void *opaque, const char *name, const char *data) {
  Transfer *t = opaque;
  if (!strcmp(data, "[DONE]")) {
    t->done = true;
    return 0;
  }
  json_object *j = json_tokener_parse(data);
  if (!j) {
    error_message(t->result, "模型返回无效的 SSE JSON");
    return -1;
  }
  json_object *err = jget(j, "error");
  if (err) {
    error_message(t->result, json_object_is_type(err, json_type_string)
                                 ? json_object_get_string(err)
                                 : jstr(err, "message", "模型服务返回错误"));
    json_object_put(j);
    return -1;
  }
  const char *type = jstr(j, "type", name);
  usage(t, j);
  if (!strcmp(t->api, "anthropic-messages")) {
    if (!strcmp(type, "message_start"))
      usage(t, jget(j, "message"));
    if (!strcmp(type, "content_block_start")) {
      json_object *block = jget(j, "content_block");
      if (!strcmp(jstr(block, "type", ""), "tool_use")) {
        json_object *call = call_at(t, (size_t)jint(j, "index", 0));
        if (call) {
          json_object_object_add(call, "id",
                                 json_object_new_string(jstr(block, "id", "")));
          json_object_object_add(
              jget(call, "function"), "name",
              json_object_new_string(jstr(block, "name", "")));
          json_object *input = jget(block, "input");
          if (input && json_object_is_type(input, json_type_object) &&
              json_object_object_length(input)) {
            char *raw = json_text(input);
            append_arguments(t, (size_t)jint(j, "index", 0), raw);
            free(raw);
          }
        }
      }
    }
    if (!strcmp(type, "content_block_delta")) {
      json_object *d = jget(j, "delta");
      const char *dt = jstr(d, "type", "");
      if (!strcmp(dt, "text_delta"))
        delta(t, "text", jstr(d, "text", ""));
      else if (!strcmp(dt, "thinking_delta"))
        delta(t, "thinking", jstr(d, "thinking", ""));
      else if (!strcmp(dt, "input_json_delta")) {
        json_object *call = call_at(t, (size_t)jint(j, "index", 0));
        if (call)
          append_arguments(t, (size_t)jint(j, "index", 0),
                           jstr(d, "partial_json", ""));
      }
    }
    if (!strcmp(type, "message_stop"))
      t->done = true;
  } else if (!strcmp(t->api, "openai-responses")) {
    if (!strcmp(type, "response.output_text.delta"))
      delta(t, "text", jstr(j, "delta", ""));
    else if (!strcmp(type, "response.reasoning_summary_text.delta"))
      delta(t, "thinking", jstr(j, "delta", ""));
    else if (!strcmp(type, "response.output_item.added")) {
      json_object *item = jget(j, "item");
      if (!strcmp(jstr(item, "type", ""), "function_call")) {
        json_object *call = call_at(t, (size_t)jint(j, "output_index", 0));
        if (call) {
          json_object_object_add(call, "id",
                                 json_object_new_string(jstr(
                                     item, "call_id", jstr(item, "id", ""))));
          json_object_object_add(
              jget(call, "function"), "name",
              json_object_new_string(jstr(item, "name", "")));
          append_arguments(t, (size_t)jint(j, "output_index", 0),
                           jstr(item, "arguments", ""));
        }
      }
    } else if (!strcmp(type, "response.function_call_arguments.delta")) {
      json_object *call = call_at(t, (size_t)jint(j, "output_index", 0));
      if (call)
        append_arguments(t, (size_t)jint(j, "output_index", 0),
                         jstr(j, "delta", ""));
    } else if (!strcmp(type, "response.completed")) {
      usage(t, jget(j, "response"));
      t->done = true;
    } else if (!strcmp(type, "response.failed") ||
               !strcmp(type, "response.incomplete"))
      error_message(t->result, "Responses 请求未完成");
  } else {
    json_object *choices = jget(j, "choices"), *choice = jat(choices, 0);
    json_object *d = jget(choice, "delta");
    if (!d)
      d = jget(choice, "message");
    if (d) {
      delta(t, "thinking",
            jstr(d, "reasoning_content", jstr(d, "reasoning", "")));
      delta(t, "text", jstr(d, "content", ""));
      json_object *calls = jget(d, "tool_calls");
      for (size_t i = 0; i < jlen(calls); i++) {
        json_object *part = jat(calls, i),
                    *call = call_at(t, (size_t)jint(part, "index", (int)i));
        if (!call)
          break;
        append_field(call, "id", jstr(part, "id", ""));
        json_object *fn = jget(part, "function"),
                    *dest = jget(call, "function");
        append_field(dest, "name", jstr(fn, "name", ""));
        append_arguments(t, (size_t)jint(part, "index", (int)i),
                         jstr(fn, "arguments", ""));
      }
    }
    if (jget(choice, "finish_reason") &&
        !json_object_is_type(jget(choice, "finish_reason"), json_type_null))
      t->done = true;
  }
  json_object_put(j);
  return t->result->error[0] ? -1 : 0;
}
static size_t receive(char *data, size_t size, size_t count, void *opaque) {
  Transfer *t = opaque;
  size_t n = size * count;
  curl_easy_getinfo(t->session->client, CURLINFO_RESPONSE_CODE,
                    &t->result->status);
  char *ctype = NULL;
  curl_easy_getinfo(t->session->client, CURLINFO_CONTENT_TYPE, &ctype);
  bool streaming = ctype && strstr(ctype, "text/event-stream");
  if (!streaming) {
    if (n > DITO_MAX_BODY - t->raw.len)
      return 0;
    buf_add(&t->raw, data, n);
    return n;
  }
  t->streamed = true;
  return sse_feed(&t->sse, data, n, handle_chunk, t) ? 0 : n;
}
static json_object *anthropic_messages(json_object *messages) {
  json_object *out = json_object_new_array();
  for (size_t i = 0; i < jlen(messages); i++) {
    json_object *m = jat(messages, i);
    const char *role = jstr(m, "role", "");
    if (!strcmp(role, "system"))
      continue;
    json_object *dest = json_object_new_object(),
                *content = json_object_new_array();
    json_object_object_add(dest, "role",
                           json_object_new_string(!strcmp(role, "assistant")
                                                      ? "assistant"
                                                      : "user"));
    if (!strcmp(role, "tool")) {
      json_object *v = json_object_new_object();
      json_object_object_add(v, "type", json_object_new_string("tool_result"));
      json_object_object_add(
          v, "tool_use_id",
          json_object_new_string(jstr(m, "tool_call_id", "")));
      json_object_object_add(v, "content",
                             json_object_new_string(jstr(m, "content", "")));
      json_object_array_add(content, v);
    } else {
      const char *text = jstr(m, "content", "");
      if (*text) {
        json_object *v = json_object_new_object();
        json_object_object_add(v, "type", json_object_new_string("text"));
        json_object_object_add(v, "text", json_object_new_string(text));
        json_object_array_add(content, v);
      }
      json_object *parts = jget(m, "content");
      for (size_t k = 0; k < jlen(parts); k++) {
        json_object *part = jat(parts, k);
        const char *type = jstr(part, "type", "");
        if (!strcmp(type, "text"))
          json_object_array_add(content, json_copy(part));
        else if (!strcmp(type, "image_url")) {
          const char *url = jstr(jget(part, "image_url"), "url", "");
          const char *marker = strstr(url, ";base64,");
          if (!strncmp(url, "data:", 5) && marker) {
            json_object *image = json_object_new_object(),
                        *source = json_object_new_object();
            json_object_object_add(image, "type",
                                   json_object_new_string("image"));
            json_object_object_add(source, "type",
                                   json_object_new_string("base64"));
            json_object_object_add(
                source, "media_type",
                json_object_new_string_len(url + 5, (int)(marker - url - 5)));
            json_object_object_add(source, "data",
                                   json_object_new_string(marker + 8));
            json_object_object_add(image, "source", source);
            json_object_array_add(content, image);
          }
        }
      }
      json_object *calls = jget(m, "tool_calls");
      for (size_t k = 0; k < jlen(calls); k++) {
        json_object *call = jat(calls, k), *fn = jget(call, "function"),
                    *v = json_object_new_object();
        json_object_object_add(v, "type", json_object_new_string("tool_use"));
        json_object_object_add(v, "id",
                               json_object_new_string(jstr(call, "id", "")));
        json_object_object_add(v, "name",
                               json_object_new_string(jstr(fn, "name", "")));
        json_object *args = json_tokener_parse(jstr(fn, "arguments", "{}"));
        json_object_object_add(v, "input",
                               args ? args : json_object_new_object());
        json_object_array_add(content, v);
      }
    }
    json_object_object_add(dest, "content", content);
    json_object_array_add(out, dest);
  }
  return out;
}
static json_object *responses_input(json_object *messages) {
  json_object *out = json_object_new_array();
  for (size_t i = 0; i < jlen(messages); i++) {
    json_object *m = jat(messages, i);
    const char *role = jstr(m, "role", "");
    if (!strcmp(role, "tool")) {
      json_object *v = json_object_new_object();
      json_object_object_add(v, "type",
                             json_object_new_string("function_call_output"));
      json_object_object_add(
          v, "call_id", json_object_new_string(jstr(m, "tool_call_id", "")));
      json_object_object_add(v, "output",
                             json_object_new_string(jstr(m, "content", "")));
      json_object_array_add(out, v);
      continue;
    }
    json_object *v = json_object_new_object();
    json_object_object_add(v, "role", json_object_new_string(role));
    json_object_object_add(v, "content", json_copy(jget(m, "content")));
    json_object *parts = jget(v, "content");
    for (size_t k = 0; k < jlen(parts); k++) {
      json_object *part = jat(parts, k);
      const char *type = jstr(part, "type", "");
      if (!strcmp(type, "text"))
        json_object_object_add(part, "type",
                               json_object_new_string("input_text"));
      else if (!strcmp(type, "image_url")) {
        const char *url = jstr(jget(part, "image_url"), "url", "");
        char *saved = xstrdup(url);
        json_object_object_add(part, "type",
                               json_object_new_string("input_image"));
        json_object_object_add(part, "image_url",
                               json_object_new_string(saved));
        free(saved);
      }
    }
    json_object_array_add(out, v);
    json_object *calls = jget(m, "tool_calls");
    for (size_t k = 0; k < jlen(calls); k++) {
      json_object *call = jat(calls, k), *fn = jget(call, "function"),
                  *item = json_object_new_object();
      json_object_object_add(item, "type",
                             json_object_new_string("function_call"));
      json_object_object_add(item, "call_id",
                             json_object_new_string(jstr(call, "id", "")));
      json_object_object_add(item, "name",
                             json_object_new_string(jstr(fn, "name", "")));
      json_object_object_add(
          item, "arguments",
          json_object_new_string(jstr(fn, "arguments", "{}")));
      json_object_array_add(out, item);
    }
  }
  return out;
}
int model_request(Session *s, json_object *tools, Events *events,
                  ModelResult *r) {
  memset(r, 0, sizeof *r);
  r->calls = json_object_new_array();
  json_object *provider = config_provider(s->config);
  if (!provider) {
    error_message(r, "当前供应商不存在");
    return -1;
  }
  const char *model = jstr(jget(s->config->json, "model"), "chat", "");
  json_object *spec = config_model(s->config);
  const char *api =
      jstr(spec, "api", jstr(provider, "api", "openai-completions"));
  bool anthropic = !strcmp(api, "anthropic-messages"),
       responses = !strcmp(api, "openai-responses");
  if (!anthropic && !responses && strcmp(api, "openai-completions")) {
    error_message(r, "该供应商协议尚未迁入 C，拒绝以其它协议发送");
    return -1;
  }
  const char *base = jstr(spec, "baseUrl", jstr(provider, "baseUrl", ""));
  size_t blen = strlen(base);
  while (blen && base[blen - 1] == '/')
    blen--;
  char *url = format("%.*s/%s", (int)blen, base,
                     anthropic   ? "messages"
                     : responses ? "responses"
                                 : "chat/completions");
  char *key = config_key(provider);
  if (strpbrk(key, "\r\n")) {
    free(url);
    free(key);
    error_message(r, "鉴权字段包含非法换行");
    return -1;
  }
  json_object *body = json_object_new_object();
  json_object_object_add(body, "model", json_object_new_string(model));
  json_object_object_add(body, "stream", json_object_new_boolean(true));
  json_object_object_add(body, responses ? "max_output_tokens" : "max_tokens",
                         json_object_new_int(jint(spec, "maxTokens", 16384)));
  if (anthropic) {
    json_object_object_add(body, "messages", anthropic_messages(s->messages));
    json_object *first = jat(s->messages, 0);
    json_object_object_add(body, "system",
                           json_object_new_string(jstr(first, "content", "")));
  } else
    json_object_object_add(body, responses ? "input" : "messages",
                           responses ? responses_input(s->messages)
                                     : json_copy(s->messages));
  if (jlen(tools)) {
    json_object *defs = json_object_new_array();
    for (size_t i = 0; i < jlen(tools); i++) {
      json_object *original = jat(tools, i), *fn = jget(original, "function");
      if (anthropic || responses) {
        json_object *d = json_object_new_object();
        if (responses)
          json_object_object_add(d, "type", json_object_new_string("function"));
        json_object_object_add(d, "name", json_copy(jget(fn, "name")));
        json_object_object_add(d, "description",
                               json_copy(jget(fn, "description")));
        json_object_object_add(d, anthropic ? "input_schema" : "parameters",
                               json_copy(jget(fn, "parameters")));
        json_object_array_add(defs, d);
      } else
        json_object_array_add(defs, json_copy(original));
    }
    json_object_object_add(body, "tools", defs);
  }
  char *payload = json_text(body);
  json_object_put(body);
  if (!s->client)
    s->client = curl_easy_init();
  if (!s->multi)
    s->multi = curl_multi_init();
  if (!s->client || !s->multi) {
    free(url);
    free(payload);
    free(key);
    error_message(r, "HTTP 初始化失败");
    return -1;
  }
  curl_easy_reset(s->client);
  struct curl_slist *headers = NULL;
  headers = curl_slist_append(headers, "Content-Type: application/json");
  headers = curl_slist_append(headers, "Accept: text/event-stream");
  char *auth =
      *key ? format(anthropic ? "x-api-key: %s" : "Authorization: Bearer %s",
                    key)
           : NULL;
  if (auth)
    headers = curl_slist_append(headers, auth);
  CURLU *parsed = curl_url();
  char *host = NULL;
  if (parsed && !curl_url_set(parsed, CURLUPART_URL, url, 0))
    curl_url_get(parsed, CURLUPART_HOST, &host, 0);
  if (host) {
    size_t n = strlen(host);
    if (!strcmp(host, "opencode.ai") ||
        (n > 12 && !strcmp(host + n - 12, ".opencode.ai"))) {
      char *session_header =
          format("x-opencode-session: %s", s->id ? s->id : "dito");
      headers = curl_slist_append(headers, session_header);
      free(session_header);
    }
  }
  curl_free(host);
  if (parsed)
    curl_url_cleanup(parsed);
  if (anthropic)
    headers = curl_slist_append(headers, "anthropic-version: 2023-06-01");
  Transfer t = {
      .session = s, .events = events, .result = r, .api = (char *)api};
  sse_init(&t.sse);
  curl_easy_setopt(s->client, CURLOPT_URL, url);
  curl_easy_setopt(s->client, CURLOPT_PROTOCOLS_STR, "http,https");
  curl_easy_setopt(s->client, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(s->client, CURLOPT_POSTFIELDS, payload);
  curl_easy_setopt(s->client, CURLOPT_POSTFIELDSIZE, (long)strlen(payload));
  curl_easy_setopt(s->client, CURLOPT_WRITEFUNCTION, receive);
  curl_easy_setopt(s->client, CURLOPT_WRITEDATA, &t);
  curl_easy_setopt(s->client, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(s->client, CURLOPT_CONNECTTIMEOUT_MS, 15000L);
  curl_easy_setopt(s->client, CURLOPT_TIMEOUT_MS, 300000L);
  curl_easy_setopt(s->client, CURLOPT_LOW_SPEED_LIMIT, 1L);
  curl_easy_setopt(s->client, CURLOPT_LOW_SPEED_TIME, 90L);
  curl_easy_setopt(s->client, CURLOPT_USERAGENT,
                   "dito-agent/" DITO_VERSION " (C)");
  char curl_error[CURL_ERROR_SIZE] = {0};
  curl_easy_setopt(s->client, CURLOPT_ERRORBUFFER, curl_error);
  curl_multi_add_handle(s->multi, s->client);
  int running = 0;
  CURLMcode mc = curl_multi_perform(s->multi, &running);
  while (mc == CURLM_OK && running && !s->cancelled && !r->error[0]) {
    if (dito_exit_requested) {
      s->cancelled = 1;
      break;
    }
    event(events, "tick", "", NULL);
    curl_multi_poll(s->multi, NULL, 0, DITO_FRAME_MS, NULL);
    mc = curl_multi_perform(s->multi, &running);
  }
  CURLcode rc = CURLE_OK;
  int left;
  CURLMsg *msg;
  while ((msg = curl_multi_info_read(s->multi, &left)))
    if (msg->msg == CURLMSG_DONE)
      rc = msg->data.result;
  curl_easy_getinfo(s->client, CURLINFO_RESPONSE_CODE, &r->status);
  curl_multi_remove_handle(s->multi, s->client);
  if (s->cancelled)
    error_message(r, "请求已取消");
  else if (mc != CURLM_OK)
    error_message(r, "HTTP 事件循环失败");
  else if (rc != CURLE_OK && !r->error[0])
    error_message(r, *curl_error ? curl_error : curl_easy_strerror(rc));
  else if (t.streamed) {
    if (sse_finish(&t.sse, handle_chunk, &t) && !r->error[0])
      error_message(r, "流式数据不完整");
  } else if (t.raw.data) {
    if (anthropic) {
      json_object *j = json_tokener_parse(t.raw.data);
      json_object *content = jget(j, "content");
      for (size_t i = 0; i < jlen(content); i++) {
        json_object *v = jat(content, i);
        delta(&t, "text", jstr(v, "text", ""));
      }
      usage(&t, j);
      if (jget(j, "error"))
        error_message(r, jstr(jget(j, "error"), "message", "模型服务错误"));
      if (j)
        json_object_put(j);
    } else
      handle_chunk(&t, "message", t.raw.data);
  }
  if ((r->status < 200 || r->status >= 300) && !r->error[0]) {
    char *e = format("模型请求失败，HTTP %ld", r->status);
    error_message(r, e);
    free(e);
  }
  if (t.streamed && !t.done && !r->error[0])
    error_message(r, "模型流在完成标记之前中断");
  for (size_t i = jlen(r->calls); i > 0; i--) {
    json_object *call = jat(r->calls, i - 1);
    if (!*jstr(jget(call, "function"), "name", ""))
      json_object_array_del_idx(r->calls, i - 1, 1);
    else {
      if (!*jstr(call, "id", ""))
        error_message(r, "工具调用缺少 id");
      if (strlen(jstr(call, "id", "")) > 512 ||
          strlen(jstr(jget(call, "function"), "name", "")) > 128)
        error_message(r, "工具名称或 id 超出长度上限");
      json_object_object_add(
          jget(call, "function"), "arguments",
          json_object_new_string(
              t.arguments[i - 1].data ? t.arguments[i - 1].data : "{}"));
    }
  }
  if (!r->error[0] && !r->text.len && !r->reasoning.len && !jlen(r->calls))
    error_message(r, "模型服务未返回正文或工具调用");
  sse_free(&t.sse);
  buf_free(&t.raw);
  for (size_t i = 0; i < 128; i++)
    buf_free(&t.arguments[i]);
  curl_slist_free_all(headers);
  free(auth);
  free(key);
  free(url);
  free(payload);
  return r->error[0] ? -1 : 0;
}
void model_result_free(ModelResult *r) {
  buf_free(&r->text);
  buf_free(&r->reasoning);
  if (r->calls)
    json_object_put(r->calls);
  memset(r, 0, sizeof *r);
}
