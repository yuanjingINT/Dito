#include "dito.h"
#include <assert.h>
#include <locale.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static json_object *fixture(void) {
  return json_tokener_parse(
      "[{\"role\":\"user\",\"content\":\"检查终端启动问题，并报告系统状态\"},"
      "{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\","
      "\"thinking\":\"先检查进程，再核对终端环境。展开思考测试内容😀\"},"
      "{\"type\":\"toolCall\",\"name\":\"bash\",\"id\":\"b1\","
      "\"arguments\":{\"command\":\"printf '终端检查完成\\n'; uname -s\"}}]},"
      "{\"role\":\"toolResult\",\"toolCallId\":\"b1\","
      "\"content\":[{\"type\":\"text\",\"text\":\"终端检查完成\\nLinux\"}]},"
      "{\"role\":\"assistant\",\"content\":[]},"
      "{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\","
      "\"thinking\":\"已收到命令结果，继续检查配置。\"},"
      "{\"type\":\"toolCall\",\"name\":\"read\",\"id\":\"r1\","
      "\"arguments\":{\"path\":\"/tmp/fixture.conf\"}}]},"
      "{\"role\":\"toolResult\",\"toolCallId\":\"r1\","
      "\"content\":[{\"type\":\"text\",\"text\":\"展开工具结果测试\"}]},"
      "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\","
      "\"text\":\"检查完成，终端运行正常。\\n\\n"
      "## 运行状态\\n模型请求使用流式输出，工具记录可以点击展开。\\n"
      "两个会话可以同时工作，切换标签不会中断任务。\"}],"
      "\"usage\":{\"input\":236700,\"output\":1140}}]");
}
static char *plain_frame(json_object *rows) {
  Buffer b = {0};
  for (size_t i = 0; i < jlen(rows); i++) {
    char *clean = safe_text(json_object_get_string(jat(rows, i)));
    buf_puts(&b, clean);
    buf_puts(&b, "\n");
    free(clean);
  }
  return b.data;
}
static int disclosure_row(Renderer *r, json_object *rows, const char *title) {
  for (size_t i = 0; i < jlen(rows); i++) {
    char *clean = safe_text(json_object_get_string(jat(rows, i)));
    bool found = strstr(clean, title) != NULL && r->body_hits[i] >= 0;
    free(clean);
    if (found)
      return (int)i;
  }
  return -1;
}
static void widths(json_object *rows, int expected_rows, int expected_width) {
  assert((int)jlen(rows) == expected_rows);
  for (size_t i = 0; i < jlen(rows); i++) {
    char *line = safe_text(json_object_get_string(jat(rows, i)));
    int width = 0;
    mbstate_t state = {0};
    for (const char *p = line; *p;) {
      wchar_t ch;
      size_t n = mbrtowc(&ch, p, strlen(p), &state);
      assert(n && n != (size_t)-1 && n != (size_t)-2);
      int cells = wcwidth(ch);
      assert(cells >= 0);
      width += cells;
      p += n;
    }
    if (width != expected_width)
      fprintf(stderr, "Frame %dx%d row %zu width %d: %s\n", expected_rows,
              expected_width, i, width, line);
    assert(width == expected_width);
    free(line);
  }
}
int main(int argc, char **argv) {
  assert(setlocale(LC_ALL, "C.UTF-8"));
  Config config = {
      .json = json_tokener_parse(
          "{\"model\":{\"provider\":\"test\",\"chat\":\"test\"},"
          "\"providers\":[{\"id\":\"test\",\"models\":[{\"id\":\"test\","
          "\"name\":\"DeepSeek V4.1 Flash\",\"contextWindow\":1000000}]}]}")};
  Session session = {.config = &config, .file = "/tmp/fixture-0.jsonl"};
  Renderer r = {.session = &session, .full = true, .hidden = true};
  r.tab_items = json_object_new_array();
  const char *titles[] = {"我的终端启动不了，看一下什么问题",
                          "查看 NAS 的服务状态",
                          "接入新的模型供应商",
                          "全面更新系统",
                          "检查 SSH 连接",
                          "安装开发环境",
                          "更新电脑",
                          "现在我好烦啊",
                          "查找历史文件"};
  for (size_t i = 0; i < 9; i++) {
    json_object *tab = json_object_new_object();
    char *path = format("/tmp/fixture-%zu.jsonl", i);
    json_object_object_add(tab, "path", json_object_new_string(path));
    json_object_object_add(tab, "preview", json_object_new_string(titles[i]));
    json_object_object_add(tab, "messageCount", json_object_new_int(18));
    json_object_array_add(r.tab_items, tab);
    free(path);
  }
  strcpy(r.peer_files[0], session.file);
  strcpy(r.peer_files[1], "/tmp/fixture-1.jsonl");
  r.peer_states[1] = 1;
  json_object *messages = fixture();
  assert(messages);
  workbench_history(&r, messages);
  json_object_put(messages);
  json_object *rows = workbench_snapshot(&r, 56, 220);
  if (argc > 1 && !strcmp(argv[1], "--preview")) {
    const char *commands[] = {
        "ps -eo pid,comm | head -n 5", "df -h /home", "free -h",
        "printenv XDG_SESSION_TYPE",   "uname -sr",   "printf '检查完成\\n'"};
    const char *outputs[] = {"  PID COMMAND\n    1 systemd\n  842 terminal",
                             "Filesystem      Size  Used Avail Use% Mounted "
                             "on\n/dev/nvme0n1p2  954G  712G  242G  75% /home",
                             "               total   used    free\nMem:        "
                             "    32Gi   15Gi    17Gi",
                             "wayland",
                             "Linux 6.18.0",
                             "检查完成"};
    for (size_t i = 0; i < sizeof commands / sizeof *commands; i++) {
      workbench_event(&r, "start", "", NULL);
      workbench_event(&r, "thinking", "核对命令结果与当前运行环境。", NULL);
      json_object *args = json_object_new_object();
      json_object_object_add(args, "command",
                             json_object_new_string(commands[i]));
      workbench_event(&r, "tool_start", "bash", args);
      json_object_put(args);
      workbench_event(&r, "tool_end", outputs[i], NULL);
    }
    workbench_event(&r, "end", "", NULL);
    json_object_put(rows);
    rows = workbench_snapshot(&r, 56, 220);
    puts(json_object_to_json_string_ext(rows, JSON_C_TO_STRING_PLAIN));
    json_object_put(rows);
    render_finish(&r);
    json_object_put(config.json);
    return 0;
  }
  widths(rows, 56, 220);
  char *plain = plain_frame(rows);
  assert(strstr(plain, "我的终端启动"));
  assert(strstr(plain, "2 ●"));
  assert(strstr(plain, "Bash"));
  assert(strstr(plain, "Linux"));
  assert(strstr(plain, "✓ 完成"));
  assert(strstr(plain, "上下文 237.8k/1.0M"));
  assert(!strstr(plain, "展开思考测试内容"));
  assert(!strstr(plain, "展开工具结果测试"));
  char *assistant = strstr(plain, " Dito");
  assert(assistant && !strstr(assistant + 5, " Dito"));
  int thinking_row = disclosure_row(&r, rows, "思考");
  assert(thinking_row >= 0 && workbench_toggle(&r, thinking_row));
  free(plain);
  json_object_put(rows);
  rows = workbench_snapshot(&r, 56, 220);
  plain = plain_frame(rows);
  assert(strstr(plain, "展开思考测试内容😀"));
  int tool_row = disclosure_row(&r, rows, "read");
  assert(tool_row >= 0 && workbench_toggle(&r, tool_row));
  free(plain);
  json_object_put(rows);
  rows = workbench_snapshot(&r, 56, 220);
  plain = plain_frame(rows);
  assert(strstr(plain, "展开工具结果测试"));
  assert(strstr(plain, "参数："));
  free(plain);
  json_object_put(rows);

  /* Independent narrow and expanded Bash layouts, plus resize boundaries. */
  rows = workbench_snapshot(&r, 24, 100);
  plain = plain_frame(rows);
  assert(!strstr(plain, "Bash  ○"));
  assert(!strstr(plain, "Linux"));
  free(plain);
  json_object_put(rows);
  r.bash_expanded = true;
  rows = workbench_snapshot(&r, 24, 100);
  plain = plain_frame(rows);
  assert(strstr(plain, "Bash  ○"));
  assert(strstr(plain, "Linux"));
  free(plain);
  json_object_put(rows);
  r.bash_expanded = false;
  r.history_open = true;
  r.history_selected = 8;
  rows = workbench_snapshot(&r, 24, 100);
  plain = plain_frame(rows);
  assert(strstr(plain, "历史会话"));
  assert(strstr(plain, "查找历史文件"));
  free(plain);
  json_object_put(rows);
  r.history_open = false;
  buf_puts(&r.input, "多行输入😀\n第二行\x1b[2J安全过滤");
  for (int cols = 12; cols <= 245; cols += 7)
    for (int height = 6; height <= 60; height += 9) {
      rows = workbench_snapshot(&r, height, cols);
      widths(rows, height, cols);
      json_object_put(rows);
    }
  r.question_text = xstrdup("多行问题\n第二行\n第三行\n第四行");
  r.question_options = json_tokener_parse("[\"选项一\",\"选项二\"]");
  r.question_skip = true;
  for (int cols = 12; cols <= 160; cols += 13)
    for (int height = 6; height <= 48; height += 7) {
      rows = workbench_snapshot(&r, height, cols);
      widths(rows, height, cols);
      assert(r.question_y + r.question_visible <= r.cursor_row);
      json_object_put(rows);
    }
  free(r.question_text);
  r.question_text = NULL;
  json_object_put(r.question_options);
  r.question_options = NULL;
  workbench_event(&r, "start", "", NULL);
  const char *stream = "流式中文😀";
  for (size_t i = 0; i < strlen(stream); i++) {
    char byte[] = {stream[i], 0};
    workbench_event(&r, "text", byte, NULL);
  }
  workbench_event(&r, "end", "", NULL);
  rows = workbench_snapshot(&r, 56, 220);
  plain = plain_frame(rows);
  assert(strstr(plain, stream));
  free(plain);
  json_object_put(rows);
  json_object *args = json_tokener_parse("{\"command\":\"printf live\"}");
  workbench_event(&r, "tool_start", "bash", args);
  json_object_put(args);
  workbench_event(&r, "tool_output", "实时输出测试", NULL);
  rows = workbench_snapshot(&r, 56, 220);
  plain = plain_frame(rows);
  assert(strstr(plain, "实时输出测试"));
  assert(strstr(plain, "Bash  ● 运行中"));
  free(plain);
  json_object_put(rows);
  render_finish(&r);
  json_object_put(config.json);
  puts("C workbench: history disclosures, Bash output, Unicode widths, resize, "
       "tabs and streaming OK");
  return 0;
}
