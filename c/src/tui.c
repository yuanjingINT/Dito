#include "dito.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

/* One native worker process per running conversation. The UI owns all terminal
 * I/O; each worker owns its model client, tools and durable session writes. */
typedef struct {
  json_object *items, *drafts;
} History;
typedef struct {
  Config *config;
  History *history;
  Session session;
  Renderer renderer;
  bool initialized, unread, question;
  pid_t pid;
  int events, answers;
  Buffer wire, saved_input, queued;
  uint64_t cancelled_at;
} Pane;
typedef struct {
  int output, input;
  Session *session;
} Worker;
static Session *worker_session;
static void worker_cancel(int sig) {
  (void)sig;
  if (worker_session)
    worker_session->cancelled = 1;
  dito_exit_requested = 1;
}
static int write_all(int fd, const char *bytes, size_t size) {
  while (size) {
    ssize_t n = write(fd, bytes, size);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      return -1;
    bytes += n;
    size -= (size_t)n;
  }
  return 0;
}
static void worker_event(void *opaque, const char *kind, const char *text,
                         json_object *data) {
  Worker *w = opaque;
  if (!strcmp(kind, "tick"))
    return;
  json_object *j = json_object_new_object();
  json_object_object_add(j, "kind", json_object_new_string(kind));
  json_object_object_add(j, "text", json_object_new_string(text));
  if (data)
    json_object_object_add(j, "data", json_copy(data));
  char *raw = json_text(j);
  Buffer line = {0};
  buf_puts(&line, raw);
  buf_puts(&line, "\n");
  if (write_all(w->output, line.data, line.len))
    w->session->cancelled = 1;
  buf_free(&line);
  free(raw);
  json_object_put(j);
}
static char *worker_answer(Worker *w) {
  Buffer answer = {0};
  while (!w->session->cancelled) {
    struct pollfd fd = {w->input, POLLIN, 0};
    int ready = poll(&fd, 1, 40);
    if (ready < 0 && errno == EINTR)
      continue;
    if (ready < 0)
      break;
    if (!ready)
      continue;
    char byte;
    ssize_t n = read(w->input, &byte, 1);
    if (n <= 0)
      break;
    if (byte == '\n') {
      json_object *j = json_tokener_parse(answer.data ? answer.data : "");
      char *value = json_object_is_type(j, json_type_string)
                        ? xstrdup(json_object_get_string(j))
                        : NULL;
      if (j)
        json_object_put(j);
      buf_free(&answer);
      return value;
    }
    if (answer.len >= 65536)
      break;
    buf_add(&answer, &byte, 1);
  }
  buf_free(&answer);
  return NULL;
}
static char *worker_ask(void *opaque, const char *prompt) {
  Worker *w = opaque;
  worker_event(w, "question", prompt, NULL);
  return worker_answer(w);
}
static char *worker_choose(void *opaque, const char *prompt,
                           json_object *options) {
  Worker *w = opaque;
  json_object *data = json_object_new_object();
  json_object_object_add(
      data, "options", options ? json_copy(options) : json_object_new_array());
  json_object_object_add(data, "allowSkip", json_object_new_boolean(true));
  worker_event(w, "question", prompt, data);
  json_object_put(data);
  return worker_answer(w);
}
static void remove_char(Buffer *b) {
  if (!b->len)
    return;
  do
    b->len--;
  while (b->len && ((unsigned char)b->data[b->len] & 0xc0) == 0x80);
  b->data[b->len] = 0;
}
static int pane_open(Pane *p, Config *c, bool fresh, const char *file) {
  p->config = c;
  p->events = p->answers = -1;
  if (session_open(&p->session, c, fresh, file, NULL)) {
    session_close(&p->session);
    return -1;
  }
  p->initialized = true;
  render_init(&p->renderer, true);
  p->renderer.session = &p->session;
  json_object *messages = session_view(p->session.file);
  workbench_history(&p->renderer, messages);
  json_object_put(messages);
  json_object *draft =
      p->history ? jget(p->history->drafts, p->session.file) : NULL;
  if (draft) {
    buf_puts(&p->renderer.input, jstr(draft, "input", ""));
    p->session.readonly = jbool(draft, "readonly", false);
    p->session.chat_only = jbool(draft, "chat", false);
  }
  return 0;
}
static void pane_notice(Pane *p, const char *text) {
  render_event(&p->renderer, "notice", text, NULL);
}
static int start_turn(Pane panes[2], int index, const char *text) {
  Pane *p = &panes[index];
  int out[2], in[2];
  if (pipe2(out, O_CLOEXEC))
    return -1;
  if (pipe2(in, O_CLOEXEC)) {
    close(out[0]);
    close(out[1]);
    return -1;
  }
  fflush(NULL);
  pid_t pid = fork();
  if (pid < 0) {
    close(out[0]);
    close(out[1]);
    close(in[0]);
    close(in[1]);
    return -1;
  }
  if (!pid) {
    setpgid(0, 0);
    close(out[0]);
    close(in[1]);
    for (int i = 0; i < 2; i++) {
      if (panes[i].events >= 0)
        close(panes[i].events);
      if (panes[i].answers >= 0)
        close(panes[i].answers);
    }
    int null = open("/dev/null", O_RDWR);
    if (null >= 0) {
      dup2(null, STDIN_FILENO);
      dup2(null, STDOUT_FILENO);
      dup2(out[1], STDERR_FILENO);
      if (null > 2)
        close(null);
    }
    Worker worker = {out[1], in[0], &p->session};
    worker_session = &p->session;
    struct sigaction action = {0};
    action.sa_handler = worker_cancel;
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    p->session.interactive = true;
    p->session.ask = worker_ask;
    p->session.choose = worker_choose;
    p->session.ask_opaque = &worker;
    Events events = {worker_event, &worker};
    int rc;
    if (!strcmp(text, "/compact") || !strcmp(text, "/压缩上下文")) {
      event(&events, "start", "压缩上下文", NULL);
      rc = compact_context(&p->session, &events, true);
      event(&events, "notice",
            rc > 0   ? "上下文已压缩"
            : rc < 0 ? "上下文压缩失败"
                     : "当前无需压缩",
            NULL);
      event(&events, "settled", "", NULL);
      rc = rc < 0 ? 1 : 0;
    } else
      rc = agent_turn(&p->session, text, NULL, &events);
    session_close(&p->session);
    curl_global_cleanup();
    worker_session = NULL;
    close(in[0]);
    close(out[1]);
    exit(rc ? 1 : 0);
  }
  setpgid(pid, pid);
  close(out[1]);
  close(in[0]);
  fcntl(out[0], F_SETFL, O_NONBLOCK);
  p->pid = pid;
  p->events = out[0];
  p->answers = in[1];
  p->cancelled_at = 0;
  buf_reset(&p->wire);
  if (strcmp(text, "/compact") && strcmp(text, "/压缩上下文"))
    workbench_event(&p->renderer, "new_user", text, NULL);
  if (p->history)
    for (size_t i = 0; i < jlen(p->history->items); i++) {
      json_object *item = jat(p->history->items, i);
      if (!strcmp(jstr(item, "path", ""), p->session.file) &&
          !*jstr(item, "preview", ""))
        json_object_object_add(item, "preview", json_object_new_string(text));
    }
  p->renderer.scroll = 0;
  render_event(&p->renderer, "start", "", NULL);
  return 0;
}
static void clear_question(Pane *p) {
  if (!p->question)
    return;
  p->question = false;
  free(p->renderer.question_text);
  p->renderer.question_text = NULL;
  if (p->renderer.question_options)
    json_object_put(p->renderer.question_options);
  p->renderer.question_options = NULL;
  p->renderer.dirty = true;
  buf_free(&p->renderer.input);
  p->renderer.input = p->saved_input;
  memset(&p->saved_input, 0, sizeof p->saved_input);
}
static void answer_question(Pane *p, const char *text) {
  json_object *answer = text ? json_object_new_string(text) : NULL;
  char *raw = answer ? json_text(answer) : xstrdup("null");
  if (write_all(p->answers, raw, strlen(raw)) || write_all(p->answers, "\n", 1))
    pane_notice(p, "回答发送失败");
  free(raw);
  if (answer)
    json_object_put(answer);
  clear_question(p);
  render_event(&p->renderer, "phase", "继续工作", NULL);
}
static void question_move(Renderer *r, int delta) {
  int count = (int)jlen(r->question_options) + 1;
  r->question_selected = (r->question_selected + delta) % count;
  if (r->question_selected < 0)
    r->question_selected += count;
  /* Arrow selection takes precedence over an unfinished custom answer. */
  if (r->question_selected < count - 1)
    buf_reset(&r->input);
  r->dirty = true;
}
static void receive_events(Pane *p) {
  char bytes[8192];
  ssize_t n;
  unsigned reads = 0;
  while (reads++ < 32 && (n = read(p->events, bytes, sizeof bytes)) > 0) {
    if ((size_t)n > DITO_MAX_SESSION_LINE - p->wire.len) {
      kill(p->pid, SIGTERM);
      break;
    }
    buf_add(&p->wire, bytes, (size_t)n);
    size_t offset = 0;
    char *end;
    while ((end = memchr(p->wire.data + offset, '\n', p->wire.len - offset))) {
      *end = 0;
      const char *line = p->wire.data + offset;
      json_object *j = json_tokener_parse(line);
      offset = (size_t)(end - p->wire.data) + 1;
      if (!j) {
        render_event(&p->renderer, "error", line, NULL);
        continue;
      }
      const char *kind = jstr(j, "kind", ""), *text = jstr(j, "text", "");
      if (!strcmp(kind, "question")) {
        if (!p->question) {
          p->saved_input = p->renderer.input;
          memset(&p->renderer.input, 0, sizeof p->renderer.input);
        }
        p->question = true;
        Renderer *r = &p->renderer;
        free(r->question_text);
        r->question_text = safe_text(text);
        if (r->question_options)
          json_object_put(r->question_options);
        r->question_options = json_copy(jget(jget(j, "data"), "options"));
        r->question_selected = r->question_top = 0;
        r->question_skip = jbool(jget(j, "data"), "allowSkip", false);
        r->history_open = false;
        render_event(r, "phase", "需要回答 · ↑↓ 选项 · 输入或回车", NULL);
      } else
        render_event(&p->renderer, kind, text, jget(j, "data"));
      p->unread = p->renderer.hidden;
      json_object_put(j);
    }
    if (offset) {
      memmove(p->wire.data, p->wire.data + offset, p->wire.len - offset);
      p->wire.len -= offset;
      p->wire.data[p->wire.len] = 0;
    }
  }
}
static void reap(Pane *p) {
  if (!p->pid)
    return;
  int status = 0;
  pid_t ended = waitpid(p->pid, &status, WNOHANG);
  if (ended <= 0)
    return;
  receive_events(p);
  close(p->events);
  close(p->answers);
  p->events = p->answers = -1;
  p->pid = 0;
  clear_question(p);
  p->renderer.waiting = false;
  if (!WIFEXITED(status) || WEXITSTATUS(status))
    pane_notice(p, p->cancelled_at ? "当前会话任务已取消"
                                   : "当前会话任务结束，详情见上方");
  char *file = xstrdup(p->session.file);
  bool readonly = p->session.readonly, chat = p->session.chat_only;
  session_close(&p->session);
  if (session_open(&p->session, p->config, false, file, NULL))
    pane_notice(p, "重新读取会话失败");
  p->session.readonly = readonly;
  p->session.chat_only = chat;
  free(file);
  p->cancelled_at = 0;
}
static void cancel(Pane *p) {
  if (!p->pid || p->cancelled_at)
    return;
  p->cancelled_at = mono_ms();
  kill(p->pid, SIGTERM);
  buf_reset(&p->queued);
  pane_notice(p, "正在取消当前会话任务…");
}
static void refresh_tabs(Pane panes[2]) {
  History *history = panes[0].history;
  json_object *listed = session_list(panes[0].config, NULL),
              *items = json_object_new_array();
  for (int k = 0; k < 2; k++) {
    Pane *p = &panes[k];
    if (!p->initialized)
      continue;
    json_object *found = NULL;
    for (size_t i = 0; i < jlen(listed); i++)
      if (!strcmp(jstr(jat(listed, i), "path", ""), p->session.file)) {
        found = jat(listed, i);
        break;
      }
    if (found)
      json_object_array_add(items, json_copy(found));
    else {
      json_object *item = json_object_new_object();
      json_object_object_add(item, "path",
                             json_object_new_string(p->session.file));
      json_object_object_add(item, "preview", json_object_new_string(""));
      json_object_array_add(items, item);
    }
  }
  for (size_t i = 0; i < jlen(listed); i++) {
    json_object *item = jat(listed, i);
    bool loaded = false;
    for (int k = 0; k < 2; k++)
      if (panes[k].initialized &&
          !strcmp(jstr(item, "path", ""), panes[k].session.file))
        loaded = true;
    if (!loaded)
      json_object_array_add(items, json_copy(item));
  }
  json_object_put(listed);
  if (history->items)
    json_object_put(history->items);
  history->items = items;
}
static void labels(Pane panes[2], int active) {
  History *history = panes[0].history;
  for (int i = 0; i < 2; i++) {
    if (!panes[i].initialized)
      continue;
    Renderer *r = &panes[i].renderer;
    if (r->tab_items != history->items) {
      if (r->tab_items)
        json_object_put(r->tab_items);
      r->tab_items = json_object_get(history->items);
      r->dirty = true;
    }
    for (int k = 0; k < 2; k++) {
      int state = panes[k].question ? 2
                  : panes[k].pid    ? 1
                  : panes[k].unread ? 3
                                    : 0;
      const char *file = panes[k].initialized ? panes[k].session.file : "";
      if (strcmp(r->peer_files[k], file) || r->peer_states[k] != state)
        r->dirty = true;
      snprintf(r->peer_files[k], sizeof r->peer_files[k], "%s", file);
      r->peer_states[k] = state;
    }
    r->hidden = i != active;
  }
}
static void save_draft(Pane *p) {
  if (!p->initialized || !p->history)
    return;
  json_object *draft = json_object_new_object();
  json_object_object_add(draft, "input",
                         json_object_new_string(p->renderer.input.data
                                                    ? p->renderer.input.data
                                                    : ""));
  json_object_object_add(draft, "readonly",
                         json_object_new_boolean(p->session.readonly));
  json_object_object_add(draft, "chat",
                         json_object_new_boolean(p->session.chat_only));
  json_object_object_add(p->history->drafts, p->session.file, draft);
}
static int select_pane(Pane panes[2], Config *c, int index, int *active) {
  if (!panes[index].initialized) {
    if (pane_open(&panes[index], c, true, NULL))
      return -1;
    refresh_tabs(panes);
  }
  panes[*active].renderer.hidden = true;
  *active = index;
  panes[index].renderer.hidden = false;
  panes[index].unread = false;
  labels(panes, index);
  render_draw(&panes[index].renderer);
  return 0;
}
static int open_path(Pane panes[2], Config *c, const char *file, int *active) {
  for (int i = 0; i < 2; i++)
    if (panes[i].initialized && !strcmp(panes[i].session.file, file))
      return select_pane(panes, c, i, active);
  int index = !panes[*active].pid ? *active : 1 - *active;
  if (panes[index].pid) {
    pane_notice(&panes[*active],
                "两个会话都在运行，请先完成或取消一个任务再打开其它历史");
    return 0;
  }
  char *path = xstrdup(file);
  Pane *p = &panes[index];
  if (p->initialized) {
    save_draft(p);
    render_finish(&p->renderer);
    session_close(&p->session);
    p->initialized = false;
  }
  int rc = pane_open(p, c, false, path);
  free(path);
  if (rc)
    return rc;
  refresh_tabs(panes);
  return select_pane(panes, c, index, active);
}
static int new_tab(Pane panes[2], Config *c, int *active) {
  int index = !panes[*active].pid ? *active : 1 - *active;
  if (panes[index].pid) {
    pane_notice(&panes[*active],
                "两个会话都在运行，请先完成或取消一个任务再新建");
    return 0;
  }
  Pane *p = &panes[index];
  if (p->initialized) {
    save_draft(p);
    render_finish(&p->renderer);
    session_close(&p->session);
    p->initialized = false;
  }
  if (pane_open(p, c, true, NULL))
    return -1;
  refresh_tabs(panes);
  return select_pane(panes, c, index, active);
}
static void history_open(Pane *p) {
  p->renderer.history_open = true;
  p->renderer.history_selected = 0;
  p->renderer.history_top = 0;
  for (size_t i = 0; i < jlen(p->renderer.tab_items); i++)
    if (!strcmp(jstr(jat(p->renderer.tab_items, i), "path", ""),
                p->session.file))
      p->renderer.history_selected = (int)i;
}
static void history_move(Renderer *r, int delta) {
  r->history_selected += delta;
  if (r->history_selected < 0)
    r->history_selected = 0;
  if ((size_t)r->history_selected >= jlen(r->tab_items))
    r->history_selected = jlen(r->tab_items) ? (int)jlen(r->tab_items) - 1 : 0;
}
static int history_enter(Pane panes[2], Config *c, int *active) {
  Renderer *r = &panes[*active].renderer;
  const char *file =
      jstr(jat(r->tab_items, (size_t)r->history_selected), "path", "");
  char *copy = xstrdup(file);
  r->history_open = false;
  int rc = *copy ? open_path(panes, c, copy, active) : 0;
  free(copy);
  return rc;
}
static int history_switch(Pane panes[2], Config *c, int *active, int delta,
                          bool previous) {
  json_object *items = session_list(c, NULL);
  int index = -1, count = (int)jlen(items);
  for (int i = 0; i < count; i++)
    if (!strcmp(jstr(jat(items, (size_t)i), "path", ""),
                panes[*active].session.file))
      index = i;
  int target = previous ? index + 1
               : count  ? (index + delta + count) % count
                        : -1;
  int rc = 0;
  if (target >= 0 && target < count) {
    char *path = xstrdup(jstr(jat(items, (size_t)target), "path", ""));
    rc = open_path(panes, c, path, active);
    free(path);
  } else
    pane_notice(&panes[*active], "已经是最早的会话了");
  json_object_put(items);
  return rc;
}
static bool handoff(Pane panes[2], int active, const char *command,
                    bool clipboard) {
  Pane *p = &panes[active];
  if (panes[0].pid || panes[1].pid) {
    pane_notice(p,
                "请先完成或取消运行中的任务，再使用此旧版交互功能；命令已保留");
    if (command)
      buf_puts(&p->renderer.input, command);
    return false;
  }
  if (!legacy_available(p->config)) {
    pane_notice(p, "旧功能兼容层未安装或已禁用");
    if (command)
      buf_puts(&p->renderer.input, command);
    return false;
  }
  setenv("DITO_SESSION_FILE", p->session.file, 1);
  if (command)
    setenv("DITO_STARTUP_COMMAND", command, 1);
  if (clipboard) {
    setenv("DITO_STARTUP_CLIPBOARD", "1", 1);
    setenv("DITO_STARTUP_DRAFT",
           p->renderer.input.data ? p->renderer.input.data : "", 1);
  }
  return true;
}
static void copy_mode(Pane *p, bool enabled) {
  Renderer *r = &p->renderer;
  r->copy_mode = enabled;
  /* Draw the mode hint once, then freeze automatic redraw while the terminal
   * owns selection. Background workers continue accumulating their events. */
  workbench_draw(r);
  fputs(enabled ? "\x1b[?1000l\x1b[?1006l" : "\x1b[?1000h\x1b[?1006h", stdout);
  fflush(stdout);
  if (!enabled)
    render_draw(r);
}
static void copy_reply(Pane *p) {
  char *text = workbench_copy_text(&p->renderer);
  if (!*text)
    pane_notice(p, "当前会话还没有可复制的回复");
  else {
    int rc = clipboard_write(text);
    pane_notice(
        p, rc == 0   ? "最近回复已复制到剪贴板"
           : rc == 1 ? "已请求终端复制最近回复；若终端不支持，请按 F2 拖选复制"
                     : "复制失败或回复超过 1 MiB；请按 F2 拖选复制");
  }
  free(text);
}
static bool legacy_slash(const char *text) {
  const char *commands[] = {"/persona",      "/identity", "/model",    "/sudo",
                            "/memory-clear", "/system",   "/kb-stats", "/image",
                            "/images",       "/unimage"};
  for (size_t i = 0; i < sizeof commands / sizeof *commands; i++) {
    size_t n = strlen(commands[i]);
    if (!strncmp(text, commands[i], n) && (!text[n] || text[n] == ' '))
      return true;
  }
  return false;
}
static void complete_command(Pane *p) {
  const char *names[] = {
      "/chat",         "/standard",     "/plan",    "/mode",     "/sudo",
      "/sessions",     "/bash",         "/prev",    "/new",      "/compact",
      "/memory-stats", "/memory-clear", "/persona", "/identity", "/model",
      "/system",       "/kb-stats",     "/image",   "/images",   "/unimage",
      "/legacy",       "/cancel",       "/copy",    "/select",   "/help",
      "/exit"};
  Buffer matches = {0};
  const char *first = NULL;
  size_t prefix = 0;
  for (size_t i = 0; i < sizeof names / sizeof *names; i++) {
    if (strncmp(names[i], p->renderer.input.data, p->renderer.input.len))
      continue;
    if (!first) {
      first = names[i];
      prefix = strlen(first);
    } else {
      size_t j = 0;
      while (j < prefix && names[i][j] == first[j])
        j++;
      prefix = j;
    }
    if (matches.len)
      buf_puts(&matches, " · ");
    buf_puts(&matches, names[i]);
  }
  if (first && prefix > p->renderer.input.len) {
    buf_reset(&p->renderer.input);
    buf_add(&p->renderer.input, first, prefix);
  } else if (matches.len)
    pane_notice(p, matches.data);
  buf_free(&matches);
}
int terminal_parallel(Config *c, bool fresh) {
  History history = {.drafts = json_object_new_object()};
  Pane panes[2] = {{.events = -1, .answers = -1, .history = &history},
                   {.events = -1, .answers = -1, .history = &history}};
  if (pane_open(&panes[0], c, fresh, NULL)) {
    json_object_put(history.drafts);
    return 1;
  }
  struct termios original, raw;
  if (tcgetattr(STDIN_FILENO, &original)) {
    session_close(&panes[0].session);
    render_finish(&panes[0].renderer);
    json_object_put(history.drafts);
    return 1;
  }
  raw = original;
  raw.c_lflag &= (tcflag_t) ~(ICANON | ECHO | ISIG);
  raw.c_cc[VMIN] = raw.c_cc[VTIME] = 0;
  if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw)) {
    session_close(&panes[0].session);
    render_finish(&panes[0].renderer);
    json_object_put(history.drafts);
    return 1;
  }
  fputs("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h", stdout);
  refresh_tabs(panes);
  int active = 0, rc = 0;
  bool quit = false, legacy_handoff = false;
  labels(panes, active);
  render_draw(&panes[active].renderer);
  while (!quit && !dito_exit_requested) {
    struct pollfd fds[3] = {{STDIN_FILENO, POLLIN, 0},
                            {panes[0].events, POLLIN, 0},
                            {panes[1].events, POLLIN, 0}};
    poll(fds, 3, DITO_FRAME_MS);
    for (int i = 0; i < 2; i++) {
      Pane *p = &panes[i];
      if (p->pid && fds[i + 1].revents)
        receive_events(p);
      if (p->pid && p->cancelled_at && mono_ms() - p->cancelled_at > 3000)
        kill(-p->pid, SIGKILL);
      bool was_running = p->pid != 0;
      reap(p);
      if (was_running && !p->pid) {
        for (size_t j = 0; j < jlen(history.items); j++) {
          json_object *item = jat(history.items, j);
          if (strcmp(jstr(item, "path", ""), p->session.file))
            continue;
          int count = 0;
          for (size_t k = 0; k < jlen(p->session.messages); k++) {
            const char *role = jstr(jat(p->session.messages, k), "role", "");
            if (!strcmp(role, "user") || !strcmp(role, "assistant"))
              count++;
          }
          json_object_object_add(item, "messageCount",
                                 json_object_new_int(count));
        }
      }
      if (p->initialized && !p->pid && p->queued.len) {
        char *text = xstrdup(p->queued.data);
        buf_reset(&p->queued);
        if (start_turn(panes, i, text))
          pane_notice(p, "启动排队任务失败");
        free(text);
      }
    }
    labels(panes, active);
    render_tick(&panes[active].renderer);
    if (!(fds[0].revents & POLLIN)) {
      if (fds[0].revents & POLLHUP)
        quit = true;
      continue;
    }
    unsigned char key;
    if (read(STDIN_FILENO, &key, 1) != 1)
      continue;
    Pane *p = &panes[active];
    Renderer *r = &p->renderer;
    if (key == 3 || key == 4) {
      quit = true;
      continue;
    }
    if (r->copy_mode && key != 27)
      continue;
    if (r->history_open && key != 27) {
      if (key == 'j')
        history_move(r, 1);
      else if (key == 'k')
        history_move(r, -1);
      else if (key == '\r' || key == '\n') {
        if (history_enter(panes, c, &active)) {
          rc = 1;
          quit = true;
        }
      }
      render_draw(&panes[active].renderer);
      continue;
    }
    if (key == 2) {
      r->bash_expanded = !r->bash_expanded;
      render_draw(r);
      continue;
    }
    if (key == 23) {
      if (select_pane(panes, c, 1 - active, &active))
        rc = 1;
      continue;
    }
    if (key == 22) {
      if (handoff(panes, active, NULL, true)) {
        legacy_handoff = quit = true;
      }
      continue;
    }
    if (key == 9 && p->question && jlen(r->question_options)) {
      question_move(r, 1);
    } else if (key == 9 && !p->question && r->input.len &&
               r->input.data[0] == '/') {
      complete_command(p);
    } else if (key == 9) {
      if (p->session.readonly) {
        p->session.readonly = false;
        p->session.chat_only = false;
      } else if (p->session.chat_only) {
        p->session.chat_only = false;
        p->session.readonly = true;
      } else
        p->session.chat_only = true;
    } else if (key == 20) {
      if (new_tab(panes, c, &active)) {
        rc = 1;
        quit = true;
      }
    } else if (key == 127 || key == 8)
      remove_char(&r->input);
    else if (key == 27) {
      char seq[32] = {0};
      struct pollfd next = {STDIN_FILENO, POLLIN, 0};
      if (poll(&next, 1, 15) > 0) {
        size_t size = 0;
        if (read(STDIN_FILENO, seq, 1) == 1)
          size = 1;
        if (size && seq[0] == 'O' && poll(&next, 1, 15) > 0) {
          if (read(STDIN_FILENO, seq + size, 1) == 1)
            size++;
        }
        if (size && seq[0] == '[')
          while (size < sizeof seq - 1 && poll(&next, 1, 15) > 0) {
            if (read(STDIN_FILENO, seq + size, 1) != 1)
              break;
            unsigned char byte = (unsigned char)seq[size++];
            if (byte >= 0x40 && byte <= 0x7e)
              break;
          }
        if (size > 0) {
          if (!strcmp(seq, "[12~") || !strcmp(seq, "OQ") || !strcmp(seq, "c")) {
            copy_mode(p, !r->copy_mode);
            continue;
          }
          if (r->copy_mode) {
            if (!strcmp(seq, "[5~"))
              r->scroll += 10;
            else if (!strcmp(seq, "[6~"))
              r->scroll = r->scroll > 10 ? r->scroll - 10 : 0;
            else if (!strcmp(seq, "[H"))
              r->scroll = 1000000;
            else if (!strcmp(seq, "[F"))
              r->scroll = 0;
            else
              continue;
            workbench_draw(r);
            continue;
          }
          if (!strncmp(seq, "[<", 2)) {
            int button, column, row;
            char action;
            if (sscanf(seq, "[<%d;%d;%d%c", &button, &column, &row, &action) ==
                    4 &&
                action == 'M') {
              column--;
              row--;
              if (p->question && row > 0 && row < r->rows - 3) {
                if (button == 64 || button == 65)
                  question_move(r, button == 64 ? -1 : 1);
                else if (button == 0 && column >= r->cols * 7 / 100 &&
                         column < r->cols * 93 / 100 && row >= r->question_y &&
                         row < r->question_y + r->question_visible) {
                  int index = r->question_top + row - r->question_y;
                  r->question_selected = index;
                  if ((size_t)index < jlen(r->question_options))
                    answer_question(
                        p, json_object_get_string(
                               jat(r->question_options, (size_t)index)));
                }
              } else if (r->history_open) {
                if (button == 64)
                  history_move(r, -3);
                else if (button == 65)
                  history_move(r, 3);
                else if (button == 0) {
                  int width = r->cols * 86 / 100, height = r->rows * 80 / 100;
                  int left = (r->cols - width) / 2;
                  int top = (r->rows - height) / 2 + 2;
                  int index = r->history_top + row - top;
                  if (column >= left && column < left + width && row >= top &&
                      row < top + height - 3 && index >= 0 &&
                      (size_t)index < jlen(r->tab_items)) {
                    r->history_selected = index;
                    if (history_enter(panes, c, &active)) {
                      rc = 1;
                      quit = true;
                    }
                  }
                }
              } else if (button == 64 || button == 65) {
                int delta = button == 64 ? 3 : -3;
                int *scroll = r->bash_expanded || (r->body_width < r->cols &&
                                                   column >= r->cols - 40)
                                  ? &r->bash_scroll
                                  : &r->scroll;
                *scroll += delta;
                if (*scroll < 0)
                  *scroll = 0;
              } else if (button == 0 && row == 0 && column >= 0 &&
                         column < r->hit_cols) {
                int hit = r->tab_hits[column];
                if (hit >= 0) {
                  char *file =
                      xstrdup(jstr(jat(r->tab_items, (size_t)hit), "path", ""));
                  if (open_path(panes, c, file, &active)) {
                    rc = 1;
                    quit = true;
                  }
                  free(file);
                } else if (hit == -2)
                  history_open(p);
                else if (hit == -3) {
                  if (new_tab(panes, c, &active)) {
                    rc = 1;
                    quit = true;
                  }
                }
              } else if (button == 0 && !r->bash_expanded &&
                         column < r->body_width)
                workbench_toggle(r, row);
            }
          } else if (p->question &&
                     (!strcmp(seq, "[A") || !strcmp(seq, "[B"))) {
            question_move(r, !strcmp(seq, "[A") ? -1 : 1);
          } else if (seq[0] >= '1' && seq[0] <= '9' && !seq[1]) {
            const char *file = workbench_tab_path(r, seq[0] - '1');
            if (file) {
              char *copy = xstrdup(file);
              if (open_path(panes, c, copy, &active)) {
                rc = 1;
                quit = true;
              }
              free(copy);
            } else if (seq[0] <= '2' &&
                       select_pane(panes, c, seq[0] - '1', &active))
              rc = 1;
          } else if (!strcmp(seq, "w") || !strcmp(seq, "W"))
            history_open(p);
          else if (!strcmp(seq, "a") || !strcmp(seq, "A")) {
            if (history_switch(panes, c, &active, 1, true))
              rc = 1;
          } else if (!strcmp(seq, "d") || !strcmp(seq, "D")) {
            if (new_tab(panes, c, &active)) {
              rc = 1;
              quit = true;
            }
          } else if (!strcmp(seq, "b") || !strcmp(seq, "[66;6u") ||
                     !strcmp(seq, "[27;6;66~"))
            r->bash_expanded = !r->bash_expanded;
          else if (r->history_open &&
                   (!strcmp(seq, "[A") || !strcmp(seq, "[B")))
            history_move(r, !strcmp(seq, "[A") ? -1 : 1);
          else if (strstr(seq, "[9;5u") || strstr(seq, "[27;5;9~") ||
                   strstr(seq, "[9;6u") || strstr(seq, "[27;6;9~") ||
                   ((!strcmp(seq, "[1;3C") || !strcmp(seq, "[1;3D")) &&
                    !r->input.len)) {
            int delta = strstr(seq, ";6") || !strcmp(seq, "[1;3D") ? -1 : 1;
            if (history_switch(panes, c, &active, delta, false))
              rc = 1;
          } else if (strstr(seq, "[5~")) {
            if (r->history_open)
              history_move(r, -10);
            else if (r->bash_expanded)
              r->bash_scroll += 10;
            else
              r->scroll += 10;
          } else if (strstr(seq, "[6~")) {
            if (r->history_open)
              history_move(r, 10);
            else {
              int *scroll = r->bash_expanded ? &r->bash_scroll : &r->scroll;
              *scroll -= 10;
              if (*scroll < 0)
                *scroll = 0;
            }
          } else if (!strcmp(seq, "[H"))
            r->scroll = 1000000;
          else if (!strcmp(seq, "[F"))
            r->scroll = 0;
          else if (!strcmp(seq, "[200~")) {
            Buffer paste = {0};
            uint64_t paste_deadline = mono_ms() + 1000;
            while (paste.len < 65536 && mono_ms() < paste_deadline &&
                   poll(&next, 1, 50) > 0) {
              char byte;
              if (read(STDIN_FILENO, &byte, 1) != 1)
                break;
              buf_add(&paste, &byte, 1);
              if (paste.len >= 6 &&
                  !memcmp(paste.data + paste.len - 6, "\x1b[201~", 6)) {
                paste.len -= 6;
                paste.data[paste.len] = 0;
                break;
              }
            }
            char *clean = safe_text(paste.data ? paste.data : "");
            if (r->input.len + strlen(clean) <= 65536) {
              buf_puts(&r->input, clean);
              if (p->question)
                r->question_selected = (int)jlen(r->question_options);
            }
            free(clean);
            buf_free(&paste);
          }
        }
      } else if (r->copy_mode)
        copy_mode(p, false);
      else if (p->question && r->question_skip)
        answer_question(p, NULL);
      else if (r->history_open)
        r->history_open = false;
      else if (r->bash_expanded)
        r->bash_expanded = false;
      else
        cancel(p);
    } else if (key == '\r' || key == '\n') {
      if (p->question) {
        const char *answer = r->input.data ? r->input.data : "";
        if (!*answer &&
            (size_t)r->question_selected < jlen(r->question_options))
          answer = json_object_get_string(
              jat(r->question_options, (size_t)r->question_selected));
        answer_question(p, answer);
      } else if (r->input.len) {
        char *text = xstrdup(r->input.data);
        buf_reset(&r->input);
        if (!strcmp(text, "/exit") || !strcmp(text, "/quit"))
          quit = true;
        else if (!strcmp(text, "/copy"))
          copy_reply(p);
        else if (!strcmp(text, "/select"))
          copy_mode(p, true);
        else if (!strcmp(text, "/legacy")) {
          if (handoff(panes, active, NULL, false))
            legacy_handoff = quit = true;
        } else if (legacy_slash(text)) {
          if (handoff(panes, active, text, false))
            legacy_handoff = quit = true;
        } else if (!strcmp(text, "/new") || !strcmp(text, "/新会话")) {
          if (new_tab(panes, c, &active)) {
            rc = 1;
            quit = true;
          }
        } else if (!strcmp(text, "/prev") || !strcmp(text, "/上一会话") ||
                   !strcmp(text, "/上一个")) {
          if (history_switch(panes, c, &active, 1, true))
            rc = 1;
        } else if (!strcmp(text, "/chat") || !strcmp(text, "/standard") ||
                   !strcmp(text, "/plan") || !strncmp(text, "/mode ", 6) ||
                   !strcmp(text, "/mode")) {
          const char *mode = text + (!strncmp(text, "/mode ", 6) ? 6 : 1);
          if (!strcmp(mode, "chat") || !strcmp(mode, "standard") ||
              !strcmp(mode, "plan")) {
            p->session.chat_only = !strcmp(mode, "chat");
            p->session.readonly = !strcmp(mode, "plan");
          } else
            pane_notice(p, "用法：/mode chat | standard | plan");
        } else if (!strcmp(text, "/memory-stats")) {
          json_object *args = json_object_new_object();
          bool failed = false;
          char *stats =
              tool_execute(&p->session, "memory_stats", args, NULL, &failed);
          pane_notice(p, stats);
          free(stats);
          json_object_put(args);
        } else if (!strcmp(text, "/help"))
          pane_notice(
              p,
              "F2/Alt+C 拖选复制 · /copy 复制最近回复 · Alt+W 历史选择 · Alt+A "
              "上一会话 · Alt+D/Ctrl+T 新建 · Ctrl+Tab "
              "/ Alt+←→ 切换 · /compact 压缩 · /mode 模式 · /memory-stats 记忆 "
              "· /model /persona /identity /sudo /image 使用旧交互兼容层");
        else if (!strcmp(text, "/sessions") || !strcmp(text, "/history") ||
                 !strcmp(text, "/会话列表"))
          history_open(p);
        else if (!strcmp(text, "/bash"))
          r->bash_expanded = !r->bash_expanded;
        else if (!strcmp(text, "/1") || !strcmp(text, "/2")) {
          if (select_pane(panes, c, text[1] - '1', &active))
            rc = 1;
        } else if (!strcmp(text, "/cancel"))
          cancel(p);
        else if (text[0] == '/' && strcmp(text, "/compact") &&
                 strcmp(text, "/压缩上下文"))
          pane_notice(p,
                      "未知命令，输入 /help 查看；完整旧版命令可使用 /legacy");
        else if (p->pid) {
          if (p->queued.len) {
            buf_puts(&r->input, text);
            pane_notice(p, "已有一条后续消息排队，输入已保留");
          } else {
            buf_puts(&p->queued, text);
            pane_notice(p, "已排队，本会话任务结束后发送");
          }
        } else if (start_turn(panes, active, text))
          pane_notice(p, "启动会话任务失败");
        free(text);
      }
    } else if (key >= 32 && r->input.len < 65536) {
      buf_add(&r->input, &key, 1);
      if (p->question)
        r->question_selected = (int)jlen(r->question_options);
    }
    labels(panes, active);
    render_draw(&panes[active].renderer);
  }
  for (int i = 0; i < 2; i++) {
    buf_reset(&panes[i].queued);
    if (panes[i].pid)
      cancel(&panes[i]);
  }
  uint64_t until = mono_ms() + 3500;
  while ((panes[0].pid || panes[1].pid) && mono_ms() < until) {
    for (int i = 0; i < 2; i++) {
      if (panes[i].pid)
        receive_events(&panes[i]);
      reap(&panes[i]);
    }
    usleep(10000);
  }
  for (int i = 0; i < 2; i++) {
    Pane *p = &panes[i];
    if (p->pid) {
      kill(-p->pid, SIGKILL);
      while (waitpid(p->pid, NULL, 0) < 0 && errno == EINTR) {
      }
    }
    if (p->events >= 0)
      close(p->events);
    if (p->answers >= 0)
      close(p->answers);
    if (p->initialized) {
      render_finish(&p->renderer);
      session_close(&p->session);
    }
    buf_free(&p->wire);
    buf_free(&p->saved_input);
    buf_free(&p->queued);
  }
  if (history.items)
    json_object_put(history.items);
  json_object_put(history.drafts);
  fputs("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l", stdout);
  fflush(stdout);
  tcsetattr(STDIN_FILENO, TCSAFLUSH, &original);
  if (legacy_handoff)
    return legacy_run(c, NULL, 0, NULL);
  return rc;
}
