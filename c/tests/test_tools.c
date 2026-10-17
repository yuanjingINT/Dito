#include "dito.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

static bool has(json_object *tools, const char *name) {
  for (size_t i = 0; i < jlen(tools); i++)
    if (!strcmp(jstr(jget(jat(tools, i), "function"), "name", ""), name))
      return true;
  return false;
}
static char *choose(void *opaque, const char *question, json_object *options) {
  int *called = opaque;
  (*called)++;
  assert(!strcmp(question, "选择"));
  return xstrdup(json_object_get_string(jat(options, 1)));
}
int main(void) {
  unsetenv("DITO_DISABLE_LEGACY");
  Config c = {
      .resource = DITO_TEST_RESOURCE,
      .json = json_tokener_parse("{\"channels\":{\"qq\":{\"enabled\":true}}}")};
  int called = 0;
  Session s = {.config = &c,
               .allow_host = true,
               .interactive = true,
               .choose = choose,
               .ask_opaque = &called};
  json_object *tools = tool_definitions(&s);
  assert(has(tools, "ask_question") && has(tools, "grep") &&
         has(tools, "find"));
  assert(has(tools, "qq_react") && has(tools, "remember_fact"));
  json_object_put(tools);
  bool failed;
  json_object *args =
      json_tokener_parse("{\"question\":\"选择\",\"options\":[\"一\",\"二\"]}");
  char *answer = tool_execute(&s, "ask_question", args, NULL, &failed);
  assert(!failed && called == 1 && !strcmp(answer, "二"));
  free(answer);
  json_object_put(args);
  args = json_tokener_parse("{\"question\":\"选择\",\"options\":[1]}");
  answer = tool_execute(&s, "ask_question", args, NULL, &failed);
  assert(failed && called == 1);
  free(answer);
  json_object_put(args);
  s.readonly = true;
  tools = tool_definitions(&s);
  assert(has(tools, "ask_question") && has(tools, "grep") &&
         has(tools, "qq_meme_list"));
  assert(!has(tools, "qq_react") && !has(tools, "subagent") &&
         !has(tools, "remember_fact"));
  json_object_put(tools);
  args = json_tokener_parse("{\"message_id\":1,\"emoji_id\":\"13\"}");
  answer = tool_execute(&s, "qq_react", args, NULL, &failed);
  assert(failed && strstr(answer, "无权"));
  free(answer);
  json_object_put(args);
  s.allow_host = false;
  tools = tool_definitions(&s);
  assert(!has(tools, "ask_question") && !has(tools, "ls") &&
         !has(tools, "qq_meme_list"));
  json_object_put(tools);
  s.chat_only = true;
  tools = tool_definitions(&s);
  assert(jlen(tools) == 0);
  json_object_put(tools);
  args = json_object_new_object();
  answer = tool_execute(&s, "ls", args, NULL, &failed);
  assert(failed);
  free(answer);
  json_object_put(args);
  s.chat_only = s.readonly = false;
  s.allow_host = true;
  json_object_object_add(
      c.json, "plugins",
      json_tokener_parse(
          "{\"ask\":{\"enabled\":false},\"snowluma\":{\"enabled\":false}}"));
  tools = tool_definitions(&s);
  assert(!has(tools, "ask_question") && !has(tools, "qq_react"));
  json_object_put(tools);
  json_object_put(c.json);
  puts("Tool contracts: native choice, schema validation, legacy names, "
       "read-only/host/plugin gates OK");
  return 0;
}
