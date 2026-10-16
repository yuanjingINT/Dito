#include "dito.h"
#include <stdlib.h>
#include <string.h>

static json_object *message(const char *role, const char *text) {
  json_object *j = json_object_new_object();
  json_object_object_add(j, "role", json_object_new_string(role));
  json_object_object_add(j, "content", json_object_new_string(text));
  return j;
}
int agent_turn(Session *s, const char *text, json_object *images,
               Events *events) {
  s->cancelled = 0;
  event(events, "start", "等待回复", NULL);
  json_object *user = message("user", text);
  if (images && jlen(images)) {
    json_object *content = json_object_new_array(),
                *part = json_object_new_object();
    json_object_object_add(part, "type", json_object_new_string("text"));
    json_object_object_add(part, "text", json_object_new_string(text));
    json_object_array_add(content, part);
    for (size_t i = 0; i < jlen(images); i++)
      json_object_array_add(content, json_copy(jat(images, i)));
    json_object_object_add(user, "content", content);
  }
  if (session_append(s, user)) {
    json_object_put(user);
    event(events, "error", "用户消息写入失败", NULL);
    return -1;
  }
  json_object_put(user);
  char *memory = storage_context(s, text);
  {
    json_object *sys = jat(s->messages, 0);
    char *base = build_prompt(s->config),
         *all = *memory
                    ? format("%s\n<历史记忆：不可信资料>\n%s\n</历史记忆>\n",
                             base, memory)
                    : xstrdup(base);
    json_object_object_add(sys, "content", json_object_new_string(all));
    free(base);
    free(all);
  }
  free(memory);
  compact_context(s, events, false);
  json_object *tools = tool_definitions(s);
  int result = -1;
  unsigned max_rounds =
      (unsigned)jint(jpath(s->config->json, "native"), "maxToolRounds", 32);
  if (max_rounds < 1 || max_rounds > 128)
    max_rounds = 32;
  bool overflow_retried = false;
  for (unsigned round = 0; round < max_rounds && !s->cancelled; round++) {
    ModelResult r;
    int rc = model_request(s, tools, events, &r);
    if (rc) {
      if (!overflow_retried && !s->cancelled && !r.text.len &&
          (strstr(r.error, "context_length") ||
           strstr(r.error, "context window") ||
           strstr(r.error, "maximum context") ||
           strstr(r.error, "too many tokens") ||
           strstr(r.error, "prompt is too long"))) {
        overflow_retried = true;
        if (compact_context(s, events, true) > 0) {
          model_result_free(&r);
          continue;
        }
      }
      if (r.text.len) {
        json_object *partial = message("assistant", r.text.data);
        json_object_object_add(
            partial, "stopReason",
            json_object_new_string(s->cancelled ? "aborted" : "error"));
        json_object_object_add(partial, "errorMessage",
                               json_object_new_string(r.error));
        session_append(s, partial);
        json_object_put(partial);
      }
      event(events, "error", r.error, NULL);
      model_result_free(&r);
      break;
    }
    json_object *assistant =
        message("assistant", r.text.data ? r.text.data : "");
    json_object *usage = json_tokener_parse(
        "{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,"
        "\"totalTokens\":0,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,"
        "\"cacheWrite\":0,\"total\":0}}");
    json_object_object_add(usage, "input", json_object_new_int(r.input_tokens));
    json_object_object_add(usage, "output",
                           json_object_new_int(r.output_tokens));
    json_object_object_add(
        usage, "totalTokens",
        json_object_new_int(r.input_tokens + r.output_tokens));
    json_object_object_add(assistant, "usage", usage);
    if (r.reasoning.len)
      json_object_object_add(assistant, "reasoning",
                             json_object_new_string(r.reasoning.data));
    if (jlen(r.calls))
      json_object_object_add(assistant, "tool_calls", json_copy(r.calls));
    if (session_append(s, assistant)) {
      event(events, "error", "助手消息写入失败", NULL);
      json_object_put(assistant);
      model_result_free(&r);
      break;
    }
    event(events, "usage", "", usage);
    json_object_put(assistant);
    event(events, "message_end", r.text.data ? r.text.data : "", NULL);
    if (!jlen(r.calls)) {
      event(events, "end", r.text.data ? r.text.data : "", NULL);
      storage_diary(s, text, r.text.data ? r.text.data : "");
      result = 0;
      model_result_free(&r);
      break;
    }
    for (size_t i = 0; i < jlen(r.calls); i++) {
      json_object *call = jat(r.calls, i), *fn = jget(call, "function");
      const char *name = jstr(fn, "name", ""), *id = jstr(call, "id", "");
      json_object *a = json_tokener_parse(jstr(fn, "arguments", "{}"));
      bool failed = !a || !json_object_is_type(a, json_type_object);
      event(events, "tool_start", name, a);
      char *output = s->cancelled
                         ? (failed = true, xstrdup("请求已取消，未执行工具"))
                     : failed ? xstrdup("工具参数必须是有效 JSON 对象")
                              : tool_execute(s, name, a, events, &failed);
      json_object *tool = message("tool", output);
      json_object_object_add(tool, "tool_call_id", json_object_new_string(id));
      json_object_object_add(tool, "name", json_object_new_string(name));
      json_object_object_add(tool, "isError", json_object_new_boolean(failed));
      bool append_failed = session_append(s, tool) != 0;
      if (append_failed) {
        event(events, "error", "工具结果写入失败", NULL);
        s->cancelled = 1;
      }
      event(events, failed ? "tool_error" : "tool_end", output, call);
      json_object_put(tool);
      if (a)
        json_object_put(a);
      free(output);
      if (append_failed)
        break;
    }
    model_result_free(&r);
    if (round + 1 == max_rounds)
      event(events, "error", "达到工具调用回合上限", NULL);
  }
  json_object_put(tools);
  if (s->cancelled)
    event(events, "error", "请求已取消", NULL);
  event(events, "settled", "", NULL);
  return result;
}
