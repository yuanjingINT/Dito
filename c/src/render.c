#include "dito.h"
#include <errno.h>
#include <locale.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>
#include <wchar.h>

/* MiyuAgent wait_spinner scanner timing, reimplemented in C; see NOTICE. */
void scanner_frame(unsigned frame, bool color, Buffer *out) {
  unsigned f = frame % 52, head, hold = 0;
  bool forward = true;
  if (f < 7)
    head = f;
  else if (f < 16) {
    head = 6;
    hold = f - 7;
  } else if (f < 22) {
    head = 21 - f;
    forward = false;
  } else {
    head = 0;
    forward = false;
    hold = f - 22;
  }
  const char *dots[] = {"▪", "▪", "▫", "▫", "·", "·"};
  for (unsigned i = 0; i < 7; i++) {
    int distance = forward ? (int)head - (int)i : (int)i - (int)head;
    int rank = distance < 0 ? 99 : distance + (int)hold;
    if (color)
      buf_puts(out, rank < 2 ? "\x1b[38;5;10m" : "\x1b[2m\x1b[38;5;10m");
    buf_puts(out, rank >= 0 && rank < 6 ? dots[rank] : "·");
    if (color)
      buf_puts(out, "\x1b[0m");
  }
}
static void dimensions(Renderer *r) {
  struct winsize w;
  if (!ioctl(STDOUT_FILENO, TIOCGWINSZ, &w) && w.ws_col && w.ws_row) {
    r->rows = w.ws_row;
    r->cols = w.ws_col;
  } else {
    r->rows = 24;
    r->cols = 80;
  }
}
void render_init(Renderer *r, bool full) {
  memset(r, 0, sizeof *r);
  const char *term = getenv("TERM");
  r->tty = isatty(STDOUT_FILENO) && (!term || strcmp(term, "dumb"));
  r->full = full && r->tty;
  dimensions(r);
}
static void clear_wait(Renderer *r) {
  if (r->tty && !r->full && r->waiting)
    fputs("\r\x1b[2K", stdout);
  r->waiting = false;
}
void render_tick(Renderer *r) {
  if (r->copy_mode)
    return;
  uint64_t now = mono_ms();
  if (now - r->last_frame < DITO_FRAME_MS)
    return;
  r->last_frame = now;
  r->frame++;
  if (r->hidden)
    return;
  if (r->full) {
    int old_rows = r->rows, old_cols = r->cols;
    dimensions(r);
    if (old_rows != r->rows || old_cols != r->cols)
      r->invalidated = true;
    if (!r->invalidated && !r->dirty && !r->waiting)
      return;
    workbench_draw(r);
    return;
  }
  if (r->tty && r->waiting) {
    Buffer frame = {0};
    scanner_frame(r->frame, true, &frame);
    printf("\r\x1b[2K%s %s · %.1fs", frame.data, r->phase,
           (double)(now - r->started) / 1000);
    buf_free(&frame);
    fflush(stdout);
  }
}
void render_draw(Renderer *r) {
  r->invalidated = true;
  r->last_frame = 0;
  render_tick(r);
}
void render_event(void *opaque, const char *kind, const char *text,
                  json_object *data) {
  Renderer *r = opaque;
  if (r->full) {
    workbench_event(r, kind, text, data);
    render_tick(r);
    return;
  }
  (void)data;
  if (!strcmp(kind, "tick")) {
    if (r->session && r->full) {
      struct pollfd f = {STDIN_FILENO, POLLIN, 0};
      if (poll(&f, 1, 0) > 0) {
        unsigned char key;
        ssize_t n = read(STDIN_FILENO, &key, 1);
        if (n == 1 && (key == 27 || key == 3))
          r->session->cancelled = 1;
        else if (n == 1 && key >= 32)
          buf_add(&r->input, &key, 1);
      }
    }
    render_tick(r);
    return;
  }
  char *clean = NULL;
  if (!strcmp(kind, "text") || !strcmp(kind, "thinking")) {
    Buffer filtered = {0};
    text_filter(&r->filter, text, strlen(text), &filtered);
    clean = filtered.data ? filtered.data : xstrdup("");
  } else
    clean = safe_text(text);
  if (!strcmp(kind, "start")) {
    memset(&r->filter, 0, sizeof r->filter);
    r->waiting = true;
    r->started = mono_ms();
    snprintf(r->phase, sizeof r->phase, "等待回复");
  } else if (!strcmp(kind, "phase")) {
    r->waiting = true;
    snprintf(r->phase, sizeof r->phase, "%s", clean);
  } else if (!strcmp(kind, "notice")) {
    clear_wait(r);
    char *line = format("\n◇ %s\n", clean);
    if (r->full)
      buf_puts(&r->text, line);
    else
      fputs(line, stdout);
    free(line);
  } else if (!strcmp(kind, "thinking")) {
    if (r->full) {
      snprintf(r->phase, sizeof r->phase, "思考中");
      r->waiting = true;
    } else {
      clear_wait(r);
      if (!r->thinking) {
        printf(r->tty ? "\n\x1b[2m◇ 思考\x1b[0m\n" : "\n◇ 思考\n");
        r->thinking = true;
      }
      if (r->tty)
        fputs("\x1b[2m", stdout);
      fputs(clean, stdout);
      if (r->tty)
        fputs("\x1b[0m", stdout);
    }
  } else if (!strcmp(kind, "text")) {
    clear_wait(r);
    if (r->thinking && !r->full)
      putchar('\n');
    r->thinking = false;
    if (r->full)
      buf_puts(&r->text, clean);
    else
      fputs(clean, stdout);
  } else if (!strcmp(kind, "tool_start")) {
    clear_wait(r);
    char *line = format("\n◇ %s\n", clean);
    if (r->full)
      buf_puts(&r->text, line);
    else
      fputs(line, stdout);
    free(line);
    r->waiting = true;
    r->started = mono_ms();
    snprintf(r->phase, sizeof r->phase, "执行工具");
  } else if (!strcmp(kind, "tool_end") || !strcmp(kind, "tool_error")) {
    clear_wait(r);
    if (r->full) {
      for (int i = 0; i < r->last_count; i++)
        free(r->last_rows[i]);
      free(r->last_rows);
      r->last_rows = NULL;
      r->last_count = 0;
    }
    if (!strcmp(kind, "tool_error")) {
      if (r->full)
        buf_puts(&r->text, clean);
      else
        printf("× %s\n", clean);
    }
  } else if (!strcmp(kind, "error")) {
    clear_wait(r);
    if (r->full) {
      buf_puts(&r->text, "\n出错：");
      buf_puts(&r->text, clean);
      buf_puts(&r->text, "\n");
    } else
      fprintf(stderr, "\n[Dito C] %s\n", clean);
  } else if (!strcmp(kind, "end") || !strcmp(kind, "settled") ||
             !strcmp(kind, "message_end")) {
    clear_wait(r);
    if (r->full)
      buf_puts(&r->text, "\n");
    else
      putchar('\n');
  }
  free(clean);
  if (r->full)
    render_tick(r);
  fflush(stdout);
}
void render_finish(Renderer *r) {
  clear_wait(r);
  workbench_free(r);
  free(r->question_text);
  if (r->question_options)
    json_object_put(r->question_options);
  if (r->tab_items)
    json_object_put(r->tab_items);
  free(r->tab_hits);
  free(r->body_hits);
  for (int i = 0; i < r->last_count; i++)
    free(r->last_rows[i]);
  free(r->last_rows);
  buf_free(&r->text);
  buf_free(&r->input);
  r->last_rows = NULL;
  r->last_count = 0;
}
int terminal_chat(Config *c, bool fresh) {
  const char *term = getenv("TERM");
  if (isatty(STDIN_FILENO) && isatty(STDOUT_FILENO) &&
      (!term || strcmp(term, "dumb")))
    return terminal_parallel(c, fresh);
  Session s;
  if (session_open(&s, c, fresh, NULL, NULL)) {
    session_close(&s);
    return 1;
  }
  Renderer r;
  render_init(&r, false);
  r.session = &s;
  Events events = {render_event, &r};
  char *line = NULL;
  size_t cap = 0;
  while (!dito_exit_requested && (fputs("你 › ", stdout), fflush(stdout),
                                  getline(&line, &cap, stdin) > 0)) {
    line[strcspn(line, "\r\n")] = 0;
    if (!strcmp(line, "/exit"))
      break;
    if (*line)
      agent_turn(&s, line, NULL, &events);
  }
  free(line);
  render_finish(&r);
  session_close(&s);
  return 0;
}
int terminal_animation_demo(unsigned ms) {
  Renderer r;
  render_init(&r, false);
  if (!r.tty) {
    Buffer frame = {0};
    scanner_frame(0, false, &frame);
    printf("%s Dito C · 动画需真实终端\n", frame.data);
    buf_free(&frame);
    return 0;
  }
  r.waiting = true;
  r.started = mono_ms();
  snprintf(r.phase, sizeof r.phase, "Miyu 扫描动画");
  while (mono_ms() - r.started < ms) {
    render_tick(&r);
    struct timespec ts = {0, 10000000};
    nanosleep(&ts, NULL);
  }
  render_finish(&r);
  putchar('\n');
  return 0;
}
