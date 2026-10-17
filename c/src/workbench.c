#include "dito.h"
#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wchar.h>

enum { TEXT, DIM, MUTED, ACCENT, GREEN, YELLOW, RED };
enum { BOLD = 256, NAV = 4096, PANEL = 8192 };
enum { USER, ASSISTANT, THINKING, TOOL, NOTICE, ERROR };
typedef struct {
  char *text;
  unsigned style;
  bool hit;
} Line;
typedef struct {
  int kind, state;
  bool expanded;
  char *name, *id;
  Buffer body, args, output;
  uint64_t revision, cached_revision;
  int cached_width;
  Line *lines;
  size_t count, line_cap;
} Block;
typedef struct {
  Block *blocks;
  size_t count, cap;
  int text, thinking, tool;
  Block bash_lines;
  uint64_t bash_revision, bash_cached_revision;
  int bash_width;
} Workbench;
typedef struct {
  char text[5];
  unsigned style;
  bool continuation;
} Cell;
typedef struct {
  int rows, cols;
  Cell *cells;
} Grid;
static const int colors[][3] = {
    {219, 224, 232}, {140, 146, 156}, {83, 91, 105},  {118, 210, 233},
    {136, 204, 151}, {228, 194, 125}, {234, 142, 142}};

static Workbench *view(Renderer *r) {
  if (!r->workbench) {
    Workbench *w = xmalloc(sizeof *w);
    memset(w, 0, sizeof *w);
    w->text = w->thinking = w->tool = -1;
    r->workbench = w;
  }
  return r->workbench;
}
static size_t glyph(const char *p, const char *end, int *width) {
  mbstate_t state = {0};
  wchar_t wc;
  size_t n = mbrtowc(&wc, p, (size_t)(end - p), &state);
  if (n == (size_t)-1 || n == (size_t)-2 || !n) {
    *width = 1;
    return 1;
  }
  *width = wcwidth(wc);
  if (*width < 0)
    *width = 0;
  return n;
}
static int length(const char *text) {
  int width = 0;
  const char *end = text + strlen(text);
  for (const char *p = text; p < end;) {
    int n;
    size_t step = glyph(p, end, &n);
    width += n;
    p += step;
  }
  return width;
}
static char *one_line(const char *text) {
  char *clean = safe_text(text);
  for (char *p = clean; *p; p++)
    if (*p == '\n' || *p == '\t')
      *p = ' ';
  return clean;
}
static char *truncate_text(const char *text, int width) {
  if (width < 1)
    return xstrdup("");
  if (length(text) <= width)
    return xstrdup(text);
  Buffer b = {0};
  const char *end = text + strlen(text);
  int used = 0;
  for (const char *p = text; p < end;) {
    int n;
    size_t step = glyph(p, end, &n);
    if (used + n > width - 1)
      break;
    buf_add(&b, p, step);
    used += n;
    p += step;
  }
  buf_puts(&b, "…");
  return b.data;
}
static void clear_lines(Block *b) {
  for (size_t i = 0; i < b->count; i++)
    free(b->lines[i].text);
  free(b->lines);
  b->lines = NULL;
  b->count = b->line_cap = 0;
}
static void line_add(Block *b, const char *text, unsigned style, bool hit) {
  if (b->count == b->line_cap) {
    size_t cap = b->line_cap ? b->line_cap * 2 : 16;
    Line *next = realloc(b->lines, cap * sizeof *next);
    if (!next)
      exit(70);
    b->lines = next;
    b->line_cap = cap;
  }
  b->lines[b->count++] = (Line){xstrdup(text), style, hit};
}
static void wrap_lines(Block *b, const char *text, int width, unsigned style,
                       bool markdown) {
  if (width < 1)
    width = 1;
  Buffer line = {0};
  int used = 0;
  bool code = false;
  const char *end = text + strlen(text);
  for (const char *p = text; p < end;) {
    if (markdown && !used && end - p >= 3 && !memcmp(p, "```", 3)) {
      code = !code;
      const char *next = strchr(p, '\n');
      p = next ? next + 1 : end;
      line_add(b, code ? "┌─ 代码" : "└─", MUTED, false);
      continue;
    }
    if (markdown && !code && !used && *p == '#') {
      const char *start = p;
      while (p < end && *p == '#')
        p++;
      if (p < end && *p == ' ') {
        p++;
        style |= BOLD;
      } else
        p = start;
    }
    if (markdown && !code && end - p >= 2 &&
        ((!memcmp(p, "**", 2)) || !memcmp(p, "__", 2))) {
      p += 2;
      continue;
    }
    if (markdown && !code && *p == '`') {
      p++;
      continue;
    }
    if (*p == '\n') {
      line_add(b, line.data ? line.data : "", style, false);
      buf_reset(&line);
      used = 0;
      style &= (unsigned)~BOLD;
      p++;
      continue;
    }
    int n;
    size_t step = glyph(p, end, &n);
    if (*p == '\t') {
      n = 4 - used % 4;
      step = 1;
    }
    if (used + n > width && used) {
      line_add(b, line.data ? line.data : "", style, false);
      buf_reset(&line);
      used = 0;
    }
    if (n <= width) {
      if (*p == '\t')
        for (int i = 0; i < n; i++)
          buf_puts(&line, " ");
      else
        buf_add(&line, p, step);
      used += n;
    }
    p += step;
  }
  if (line.len || !b->count)
    line_add(b, line.data ? line.data : "", style, false);
  buf_free(&line);
}
static Block *add(Renderer *r, int kind, const char *text) {
  Workbench *w = view(r);
  if (w->count == w->cap) {
    size_t cap = w->cap ? w->cap * 2 : 32;
    Block *next = realloc(w->blocks, cap * sizeof *next);
    if (!next)
      exit(70);
    w->blocks = next;
    w->cap = cap;
  }
  Block *b = &w->blocks[w->count++];
  memset(b, 0, sizeof *b);
  b->kind = kind;
  b->revision = 1;
  if (text) {
    char *clean = safe_text(text);
    buf_puts(&b->body, clean);
    free(clean);
  }
  return b;
}
static void bounded(Buffer *b, const char *text, size_t limit) {
  char *clean = safe_text(text);
  size_t n = strlen(clean);
  if (n > limit) {
    n = limit;
    while (n && ((unsigned char)clean[n] & 0xc0) == 0x80)
      n--;
  }
  buf_reset(b);
  buf_add(b, clean, n);
  if (strlen(clean) > n)
    buf_puts(b, "\n[后续工具输出已省略]");
  free(clean);
}
static bool bash_tool(Block *b) {
  return b->kind == TOOL && b->name &&
         (!strcmp(b->name, "bash") || !strcmp(b->name, "pc_bash") ||
          !strcmp(b->name, "shell"));
}
static void tool_add(Renderer *r, const char *name, const char *id,
                     json_object *args, int state) {
  Block *b = add(r, TOOL, NULL);
  b->name = safe_text(name);
  b->id = xstrdup(id ? id : "");
  b->state = state;
  char *raw = json_text(args);
  bounded(&b->args, raw, 16384);
  free(raw);
  if (bash_tool(b))
    bounded(&b->body,
            jstr(args, "command", jstr(args, "cmd", jstr(args, "script", ""))),
            16384);
  view(r)->tool = (int)view(r)->count - 1;
  if (bash_tool(b))
    view(r)->bash_revision++;
}
static void tool_result(Renderer *r, const char *id, const char *text,
                        int state) {
  Workbench *w = view(r);
  int index = -1;
  if (id && *id)
    for (size_t i = w->count; i; i--)
      if (w->blocks[i - 1].kind == TOOL && w->blocks[i - 1].id &&
          !strcmp(w->blocks[i - 1].id, id)) {
        index = (int)i - 1;
        break;
      }
  if (index < 0)
    index = w->tool;
  if (index < 0 || (size_t)index >= w->count)
    return;
  Block *b = &w->blocks[index];
  b->state = state;
  b->revision++;
  bounded(&b->output, text, bash_tool(b) ? 96 * 1024 : 48 * 1024);
  if (bash_tool(b))
    w->bash_revision++;
  if (id && *id && (!b->id || !*b->id)) {
    free(b->id);
    b->id = xstrdup(id);
  }
}
static char *content_text(json_object *content) {
  if (json_object_is_type(content, json_type_string))
    return xstrdup(json_object_get_string(content));
  Buffer b = {0};
  for (size_t i = 0; i < jlen(content); i++) {
    json_object *v = jat(content, i);
    const char *type = jstr(v, "type", "");
    const char *text = !strcmp(type, "image") || !strcmp(type, "image_url")
                           ? "[图片]"
                           : jstr(v, "text", "");
    if (*text) {
      if (b.len)
        buf_puts(&b, "\n");
      buf_puts(&b, text);
    }
  }
  return b.data ? b.data : xstrdup("");
}
void workbench_history(Renderer *r, json_object *messages) {
  r->dirty = true;
  workbench_free(r);
  Workbench *w = view(r);
  for (size_t i = 0; i < jlen(messages); i++) {
    json_object *m = jat(messages, i);
    const char *role = jstr(m, "role", "");
    json_object *content = jget(m, "content");
    if (!strcmp(role, "user")) {
      char *text = content_text(content);
      if (*text)
        add(r, USER, text);
      free(text);
    } else if (!strcmp(role, "assistant")) {
      if (json_object_is_type(content, json_type_string)) {
        const char *text = json_object_get_string(content);
        if (*text)
          add(r, ASSISTANT, text);
      } else
        for (size_t k = 0; k < jlen(content); k++) {
          json_object *part = jat(content, k);
          const char *type = jstr(part, "type", "");
          if (!strcmp(type, "thinking")) {
            const char *text = jstr(part, "thinking", "");
            if (*text)
              add(r, THINKING, text);
          } else if (!strcmp(type, "text")) {
            const char *text = jstr(part, "text", "");
            if (*text)
              add(r, ASSISTANT, text);
          } else if (!strcmp(type, "toolCall"))
            tool_add(r, jstr(part, "name", "tool"), jstr(part, "id", ""),
                     jget(part, "arguments"), 1);
        }
      json_object *usage = jget(m, "usage");
      if (usage)
        r->context_tokens = jint(usage, "input", 0) + jint(usage, "output", 0) +
                            jint(usage, "cacheRead", 0) +
                            jint(usage, "cacheWrite", 0);
    } else if (!strcmp(role, "toolResult") || !strcmp(role, "tool")) {
      char *text = content_text(content);
      tool_result(r, jstr(m, "toolCallId", jstr(m, "tool_call_id", "")), text,
                  jbool(m, "isError", false) ? 2 : 1);
      free(text);
    }
  }
  w->text = w->thinking = w->tool = -1;
}
void workbench_event(Renderer *r, const char *kind, const char *text,
                     json_object *data) {
  r->dirty = true;
  Workbench *w = view(r);
  if (!strcmp(kind, "start")) {
    memset(&r->filter, 0, sizeof r->filter);
    r->waiting = true;
    r->started = mono_ms();
    w->text = w->thinking = w->tool = -1;
    snprintf(r->phase, sizeof r->phase, "等待回复");
  } else if (!strcmp(kind, "new_user")) {
    if (*text)
      add(r, USER, text);
  } else if (!strcmp(kind, "text") || !strcmp(kind, "thinking")) {
    bool thinking = !strcmp(kind, "thinking");
    int *index = thinking ? &w->thinking : &w->text;
    Buffer clean = {0};
    text_filter(&r->filter, text, strlen(text), &clean);
    if (clean.len) {
      if (*index < 0) {
        add(r, thinking ? THINKING : ASSISTANT, NULL);
        *index = (int)w->count - 1;
      }
      Block *b = &w->blocks[*index];
      buf_add(&b->body, clean.data, clean.len);
      b->revision++;
    }
    buf_free(&clean);
    r->waiting = thinking;
    snprintf(r->phase, sizeof r->phase, "%s", thinking ? "思考中" : "正在回复");
  } else if (!strcmp(kind, "tool_start")) {
    tool_add(r, text, "", data, 0);
    w->text = w->thinking = -1;
    r->waiting = true;
    snprintf(r->phase, sizeof r->phase, "执行工具 · %s", text);
  } else if (!strcmp(kind, "tool_end") || !strcmp(kind, "tool_error")) {
    tool_result(r, jstr(data, "id", ""), text,
                !strcmp(kind, "tool_error") ? 2 : 1);
    r->waiting = true;
    snprintf(r->phase, sizeof r->phase, "等待回复");
  } else if (!strcmp(kind, "tool_progress") || !strcmp(kind, "tool_output")) {
    if (w->tool >= 0)
      tool_result(r, "", text, 0);
  } else if (!strcmp(kind, "phase")) {
    r->waiting = true;
    snprintf(r->phase, sizeof r->phase, "%s", text);
  } else if (!strcmp(kind, "notice") || !strcmp(kind, "error")) {
    add(r, !strcmp(kind, "error") ? ERROR : NOTICE, text);
    if (!strcmp(kind, "error"))
      r->waiting = false;
  } else if (!strcmp(kind, "message_end")) {
    w->text = w->thinking = -1;
  } else if (!strcmp(kind, "end") || !strcmp(kind, "settled"))
    r->waiting = false;
  else if (!strcmp(kind, "usage"))
    r->context_tokens = jint(data, "input", 0) + jint(data, "output", 0) +
                        jint(data, "cacheRead", 0) +
                        jint(data, "cacheWrite", 0);
}
static void block_lines(Block *b, int width) {
  if (b->cached_width == width && b->cached_revision == b->revision)
    return;
  clear_lines(b);
  b->cached_width = width;
  b->cached_revision = b->revision;
  if (b->kind == TOOL) {
    const char *state = b->state == 0   ? "● 运行中"
                        : b->state == 2 ? "× 失败"
                                        : "✓ 完成";
    char *preview = one_line(bash_tool(b) ? (b->body.data ? b->body.data : "")
                                          : (b->args.data ? b->args.data : ""));
    char *title = bash_tool(b)
                      ? format("  ◇ %s  %s", b->name, preview)
                      : format("  ◇ %s %s（点击%s） %s", b->name, state,
                               b->expanded ? "收起" : "展开", preview);
    char *short_title = truncate_text(title, width);
    line_add(b, short_title, DIM, !bash_tool(b));
    free(short_title);
    free(title);
    free(preview);
    if (b->expanded) {
      if (b->args.len) {
        char *args = format("参数：%s", b->args.data);
        wrap_lines(b, args, width - 4, DIM, false);
        free(args);
      }
      wrap_lines(b,
                 b->output.len   ? b->output.data
                 : b->state == 0 ? "等待输出…"
                                 : "（无文本输出）",
                 width - 4, TEXT, false);
    }
    return;
  }
  line_add(b, "", TEXT, false);
  unsigned style = b->kind == THINKING || b->kind == NOTICE ? DIM
                   : b->kind == ERROR                       ? RED
                                                            : TEXT;
  if (b->kind == THINKING) {
    line_add(b, b->expanded ? " ◇ 思考（点击收起）" : " ◇ 思考（点击展开）",
             DIM, true);
    if (!b->expanded) {
      line_add(b, "", TEXT, false);
      return;
    }
  } else if (b->kind == USER)
    line_add(b, " 你", ACCENT | BOLD | PANEL, false);
  else if (b->kind == ASSISTANT)
    line_add(b, " Dito", TEXT | BOLD, false);
  if (b->kind == USER)
    style |= PANEL;
  size_t before = b->count;
  wrap_lines(b, b->body.data ? b->body.data : "", width - 2, style, true);
  for (size_t i = before; i < b->count; i++) {
    char *p = format(" %s", b->lines[i].text);
    free(b->lines[i].text);
    b->lines[i].text = p;
  }
  line_add(b, "", TEXT, false);
}
static Grid grid_new(int rows, int cols) {
  Grid g = {rows, cols, xmalloc((size_t)rows * (size_t)cols * sizeof(Cell))};
  for (int i = 0; i < rows * cols; i++) {
    memset(&g.cells[i], 0, sizeof(Cell));
    strcpy(g.cells[i].text, " ");
  }
  return g;
}
static void fill(Grid *g, int y, int x, int width, unsigned style) {
  if (y < 0 || y >= g->rows)
    return;
  int left = x < 0 ? 0 : x, right = x + width;
  if (right > g->cols)
    right = g->cols;
  if (left >= right)
    return;
  /* Overlays may cut through a two-cell glyph. Erase the entire old glyph,
   * including the cell just outside the panel, rather than leaving an orphan.
   */
  while (left > 0 && g->cells[y * g->cols + left].continuation)
    left--;
  while (right < g->cols && g->cells[y * g->cols + right].continuation)
    right++;
  for (int i = left; i < right; i++) {
    Cell *c = &g->cells[y * g->cols + i];
    memset(c, 0, sizeof *c);
    strcpy(c->text, " ");
    c->style = style;
  }
}
static int put(Grid *g, int y, int x, const char *text, int max,
               unsigned style) {
  if (y < 0 || y >= g->rows || max < 1)
    return x;
  char *clean = safe_text(text);
  const char *end = clean + strlen(clean);
  int used = 0;
  for (const char *p = clean; p < end;) {
    int width;
    size_t n = glyph(p, end, &width);
    if (*p == '\n' || *p == '\r')
      break;
    if (!width) {
      p += n;
      continue;
    }
    if (used + width > max || x + width > g->cols)
      break;
    if (x >= 0 && n < 5) {
      fill(g, y, x, width, style);
      Cell *cell = &g->cells[y * g->cols + x];
      memset(cell, 0, sizeof *cell);
      memcpy(cell->text, p, n);
      cell->style = style;
      for (int k = 1; k < width; k++) {
        Cell *next = cell + k;
        memset(next, 0, sizeof *next);
        next->continuation = true;
        next->style = style;
      }
    }
    x += width;
    used += width;
    p += n;
  }
  free(clean);
  return x;
}
static const char *tab_path(Renderer *r, int index) {
  return jstr(jat(r->tab_items, (size_t)index), "path", "");
}
const char *workbench_tab_path(Renderer *r, int digit) {
  return digit >= 0 && digit < r->tab_count
             ? tab_path(r, r->visible_tabs[digit])
             : NULL;
}
static char *title_for(Renderer *r, const char *file) {
  for (size_t i = 0; i < jlen(r->tab_items); i++)
    if (!strcmp(tab_path(r, (int)i), file)) {
      char *title = one_line(jstr(jat(r->tab_items, i), "preview", ""));
      if (*title)
        return title;
      free(title);
    }
  Workbench *w = view(r);
  for (size_t i = 0; i < w->count; i++)
    if (w->blocks[i].kind == USER && w->blocks[i].body.len)
      return one_line(w->blocks[i].body.data);
  return xstrdup("新会话");
}
static void draw_tabs(Renderer *r, Grid *g) {
  fill(g, 0, 0, g->cols, MUTED | NAV);
  if (r->hit_cols != g->cols) {
    free(r->tab_hits);
    r->tab_hits = xmalloc((size_t)g->cols * sizeof(int));
    r->hit_cols = g->cols;
  }
  for (int i = 0; i < g->cols; i++)
    r->tab_hits[i] = -1;
  int brand = g->cols >= 60 ? 6 : 1;
  put(g, 0, 0, g->cols >= 60 ? " DITO " : " ", brand, TEXT | BOLD | NAV);
  int controls = g->cols >= 90 ? 17 : 7, room = g->cols - brand - controls;
  int count = room / (g->cols < 70 ? 20 : 22);
  if (count < 1)
    count = 1;
  if (count > 9)
    count = 9;
  if ((size_t)count > jlen(r->tab_items))
    count = (int)jlen(r->tab_items);
  int active = 0;
  const char *file = r->session && r->session->file ? r->session->file : "";
  for (size_t i = 0; i < jlen(r->tab_items); i++)
    if (!strcmp(file, tab_path(r, (int)i)))
      active = (int)i;
  int start = active - count / 2;
  if (start > (int)jlen(r->tab_items) - count)
    start = (int)jlen(r->tab_items) - count;
  if (start < 0)
    start = 0;
  r->tab_count = count;
  int cell = count ? room / count : room, x = brand;
  for (int i = 0; i < count; i++) {
    int index = start + i;
    r->visible_tabs[i] = index;
    json_object *item = jat(r->tab_items, (size_t)index);
    const char *path = tab_path(r, index);
    bool selected = !strcmp(file, path);
    unsigned style = selected ? ACCENT | BOLD | PANEL : MUTED | NAV;
    const char *marker = "";
    for (int k = 0; k < 2; k++)
      if (!strcmp(path, r->peer_files[k]))
        marker = r->peer_states[k] == 2   ? " ?"
                 : r->peer_states[k] == 1 ? " ●"
                 : r->peer_states[k] == 3 ? " !"
                                          : "";
    char *title = one_line(jstr(item, "preview", ""));
    char *label = format("%d%s %s", i + 1, marker, *title ? title : "新会话");
    char *clipped = truncate_text(label, cell - 2);
    fill(g, 0, x, cell, style);
    put(g, 0, x + 1, clipped, cell - 2, style);
    for (int j = x; j < x + cell && j < g->cols; j++)
      r->tab_hits[j] = index;
    free(title);
    free(label);
    free(clipped);
    x += cell;
  }
  int control_x = g->cols - controls;
  const char *history = g->cols >= 90 ? " ≡ 历史 " : " ≡ ";
  int next = put(g, 0, control_x, history, controls, DIM | NAV);
  for (int i = control_x; i < next; i++)
    r->tab_hits[i] = -2;
  put(g, 0, next, g->cols >= 90 ? " + 新建 " : " + ", g->cols - next,
      ACCENT | NAV);
  for (int i = next; i < g->cols; i++)
    r->tab_hits[i] = -3;
}
static void compact_number(int n, char out[32]) {
  if (n >= 1000000)
    snprintf(out, 32, "%.1fM", n / 1000000.);
  else if (n >= 1000)
    snprintf(out, 32, "%.1fk", n / 1000.);
  else
    snprintf(out, 32, "%d", n);
}
static void draw_footer(Renderer *r, Grid *g, int input_height) {
  unsigned mode_color = r->session && r->session->readonly    ? ACCENT
                        : r->session && r->session->chat_only ? GREEN
                                                              : YELLOW;
  int top = g->rows - input_height - 3;
  Buffer border = {0};
  for (int i = 0; i < g->cols; i++)
    buf_puts(&border, "─");
  put(g, top, 0, border.data, g->cols, mode_color);
  put(g, g->rows - 2, 0, border.data, g->cols, mode_color);
  buf_free(&border);
  Block input = {0};
  wrap_lines(&input, r->input.data ? r->input.data : "", g->cols - 2, TEXT,
             false);
  size_t start = input.count > (size_t)input_height
                     ? input.count - (size_t)input_height
                     : 0;
  for (int i = 0; i < input_height; i++) {
    put(g, top + 1 + i, 0, i ? " " : "›", 1, ACCENT);
    if (start + (size_t)i < input.count)
      put(g, top + 1 + i, 2, input.lines[start + (size_t)i].text, g->cols - 2,
          TEXT);
  }
  size_t last = input.count ? input.count - 1 : 0;
  r->cursor_row = top + 1 + (int)(last - start);
  r->cursor_col = 2 + (input.count ? length(input.lines[last].text) : 0);
  if (r->cursor_col >= g->cols)
    r->cursor_col = g->cols - 1;
  clear_lines(&input);
  int y = g->rows - 1;
  fill(g, y, 0, g->cols, DIM | NAV);
  const char *mode = r->session && r->session->readonly    ? "计划"
                     : r->session && r->session->chat_only ? "闲聊"
                                                           : "标准";
  int x = put(g, y, 1, mode, g->cols - 1, mode_color | BOLD | NAV);
  x = put(g, y, x, " ALPHA ", g->cols - x, YELLOW | BOLD | NAV);
  char *right = NULL;
  if (r->session) {
    Config *c = r->session->config;
    int window = jint(config_model(c), "contextWindow", 0);
    char used[32], total[32];
    compact_number(r->context_tokens, used);
    compact_number(window, total);
    char *context = window ? format("上下文 %s/%s (%.1f%%)", used, total,
                                    (double)r->context_tokens * 100 / window)
                           : format("上下文 %s/?", used);
    right = format(
        "%s %s %s ", context,
        jstr(config_model(c), "name", jstr(jget(c->json, "model"), "chat", "")),
        r->session->sudo_mode ? "sudo" : "权限门");
    free(context);
  }
  int right_width = right ? length(right) : 0;
  if (right_width > g->cols / 2)
    right_width = g->cols / 2;
  const char *help = "Tab 模式 · Ctrl+Tab 会话 · Alt+W 历史";
  if (r->waiting) {
    Buffer scanner = {0};
    scanner_frame(r->frame, false, &scanner);
    char *running = format("%s %s · %.1fs · Esc 中断", scanner.data, r->phase,
                           (mono_ms() - r->started) / 1000.);
    put(g, y, x, running, g->cols - x - right_width - 1, GREEN | NAV);
    free(running);
    buf_free(&scanner);
  } else
    put(g, y, x, help, g->cols - x - right_width - 1, MUTED | NAV);
  if (right && g->cols >= 85) {
    char *short_right = truncate_text(right, right_width);
    put(g, y, g->cols - right_width, short_right, right_width, DIM | NAV);
    free(short_right);
  }
  free(right);
}
static void draw_conversation(Renderer *r, Grid *g, int top, int height,
                              int width) {
  Workbench *w = view(r);
  if (r->hit_rows != g->rows) {
    free(r->body_hits);
    r->body_hits = xmalloc((size_t)g->rows * sizeof(int));
    r->hit_rows = g->rows;
  }
  for (int i = 0; i < g->rows; i++)
    r->body_hits[i] = -1;
  r->body_top = top;
  r->body_height = height;
  r->body_width = width;
  if (!w->count) {
    put(g, top + height / 3, (width - 9) / 2, "D I T O", width, ACCENT | BOLD);
    put(g, top + height / 3 + 2, (width - 12) / 2, "你的电脑搭档", width, DIM);
    if (width >= 55)
      put(g, top + height / 3 + 4, (width - 44) / 2,
          "输入消息开始 · / 命令 · Alt+W 历史", width, MUTED);
    return;
  }
  size_t total = 0;
  for (size_t i = 0; i < w->count; i++) {
    block_lines(&w->blocks[i], width);
    total += w->blocks[i].count;
  }
  size_t start = total > (size_t)height ? total - (size_t)height : 0;
  if ((size_t)r->scroll > start)
    r->scroll = (int)start;
  if (r->scroll > 0)
    start = start > (size_t)r->scroll ? start - (size_t)r->scroll : 0;
  size_t cursor = 0;
  int row = 0;
  for (size_t i = 0; i < w->count && row < height; i++) {
    Block *b = &w->blocks[i];
    for (size_t k = 0; k < b->count && row < height; k++, cursor++) {
      if (cursor < start)
        continue;
      Line *line = &b->lines[k];
      if (line->style & PANEL)
        fill(g, top + row, 0, width, line->style);
      put(g, top + row, 0, line->text, width, line->style);
      if (b->kind == TOOL && line->hit) {
        const char *status = b->state == 0   ? "● 运行中"
                             : b->state == 2 ? "× 失败"
                                             : "✓ 完成";
        int x = 5 + length(b->name);
        put(g, top + row, x, status, width - x,
            b->state == 0   ? YELLOW
            : b->state == 2 ? RED
                            : GREEN);
      }
      if (line->hit)
        r->body_hits[top + row] = (int)i;
      row++;
    }
  }
}
static void draw_bash(Renderer *r, Grid *g, int top, int height, int x,
                      int width) {
  Workbench *w = view(r);
  bool running = false;
  for (size_t i = 0; i < w->count; i++)
    if (bash_tool(&w->blocks[i]) && w->blocks[i].state == 0)
      running = true;
  fill(g, top, x, width, DIM | NAV);
  put(g, top, x + 1, running ? "Bash  ● 运行中" : "Bash  ○ 空闲", width - 1,
      ACCENT | NAV);
  Block *lines = &w->bash_lines;
  if (w->bash_width != width || w->bash_cached_revision != w->bash_revision) {
    clear_lines(lines);
    w->bash_width = width;
    w->bash_cached_revision = w->bash_revision;
    size_t begin = w->count, remaining = 30;
    while (begin) {
      begin--;
      if (bash_tool(&w->blocks[begin]) && !--remaining)
        break;
    }
    for (size_t i = begin; i < w->count; i++) {
      Block *b = &w->blocks[i];
      if (!bash_tool(b))
        continue;
      line_add(lines, "", TEXT, false);
      line_add(lines,
               b->state == 0   ? "● 运行中"
               : b->state == 2 ? "× 失败"
                               : "✓ 完成",
               b->state == 0   ? YELLOW
               : b->state == 2 ? RED
                               : GREEN,
               false);
      char *cmd = format("$ %s", b->body.data ? b->body.data : "");
      wrap_lines(lines, cmd, width - 2, TEXT, false);
      free(cmd);
      if (b->output.len)
        wrap_lines(lines, b->output.data, width - 2, DIM, false);
    }
    if (!lines->count)
      line_add(lines, "尚无 Bash 命令", MUTED, false);
  }
  int content_height = height - 2;
  if (content_height < 1)
    content_height = 1;
  size_t start = lines->count > (size_t)content_height
                     ? lines->count - (size_t)content_height
                     : 0;
  if ((size_t)r->bash_scroll > start)
    r->bash_scroll = (int)start;
  if (r->bash_scroll > 0)
    start = start > (size_t)r->bash_scroll ? start - (size_t)r->bash_scroll : 0;
  for (int i = 0; i < content_height && start + (size_t)i < lines->count; i++)
    put(g, top + 1 + i, x + 1, lines->lines[start + (size_t)i].text, width - 1,
        lines->lines[start + (size_t)i].style);
  fill(g, top + height - 1, x, width, MUTED | NAV);
  put(g, top + height - 1, x + 1, "滚轮查看 · Ctrl+Shift+B 展开", width - 1,
      MUTED | NAV);
}
static void draw_history(Renderer *r, Grid *g) {
  if (!r->history_open)
    return;
  int width = g->cols * 86 / 100, height = g->rows * 80 / 100;
  if (width < 12)
    width = g->cols;
  int x = (g->cols - width) / 2, y = (g->rows - height) / 2;
  for (int i = 0; i < height; i++)
    fill(g, y + i, x, width, DIM | PANEL);
  put(g, y, x + 1, "历史会话 · ↑↓/j k 选择 · Enter 打开 · Esc 返回", width - 2,
      ACCENT | BOLD | PANEL);
  int visible = height - 3;
  if (visible < 1)
    visible = 1;
  if (r->history_selected < r->history_top)
    r->history_top = r->history_selected;
  if (r->history_selected >= r->history_top + visible)
    r->history_top = r->history_selected - visible + 1;
  for (int i = 0;
       i < visible && (size_t)(r->history_top + i) < jlen(r->tab_items); i++) {
    int index = r->history_top + i;
    json_object *item = jat(r->tab_items, (size_t)index);
    char *title = one_line(jstr(item, "preview", "新会话"));
    char *line =
        format("%s %s · %d 条消息", index == r->history_selected ? "▸" : " ",
               *title ? title : "新会话", jint(item, "messageCount", 0));
    char *short_line = truncate_text(line, width - 2);
    put(g, y + 2 + i, x + 1, short_line, width - 2,
        index == r->history_selected ? ACCENT | BOLD | NAV : DIM | PANEL);
    free(title);
    free(line);
    free(short_line);
  }
}
static void draw_question(Renderer *r, Grid *g, int input_height) {
  if (!r->question_text)
    return;
  int width = g->cols * 86 / 100;
  if (width < 12)
    width = g->cols;
  int x = (g->cols - width) / 2;
  int bottom = g->rows - input_height - 4, max_height = bottom - 1;
  if (max_height < 4) {
    char *title = one_line(r->question_text);
    fill(g, 1, x, width, TEXT | PANEL);
    put(g, 1, x + 1, title, width - 2, ACCENT | BOLD | PANEL);
    free(title);
    r->question_top = r->question_selected;
    r->question_y = 2;
    r->question_visible = bottom >= 2 ? 1 : 0;
    if (bottom >= 2) {
      const char *label =
          (size_t)r->question_selected < jlen(r->question_options)
              ? json_object_get_string(
                    jat(r->question_options, (size_t)r->question_selected))
              : "自定义回答：在下方输入";
      char *clean = one_line(label);
      fill(g, 2, x, width, TEXT | PANEL);
      put(g, 2, x + 1, clean, width - 2, ACCENT | PANEL);
      free(clean);
    }
    return;
  }
  Block question = {0};
  wrap_lines(&question, r->question_text, width - 4, TEXT, false);
  int prompt_lines = (int)question.count;
  if (prompt_lines > 4)
    prompt_lines = 4;
  if (prompt_lines > max_height - 4)
    prompt_lines = max_height - 4;
  int count = (int)jlen(r->question_options),
      available = max_height - prompt_lines - 3;
  int visible = count + 1;
  if (visible > available)
    visible = available;
  if (visible < 1)
    visible = 1;
  int height = prompt_lines + visible + 3;
  int y = bottom - height;
  if (y < 1)
    y = 1;
  for (int i = 0; i < height; i++)
    fill(g, y + i, x, width, TEXT | PANEL);
  put(g, y, x + 1, r->question_skip ? "向用户提问 · ask_question" : "操作确认",
      width - 2, ACCENT | BOLD | PANEL);
  for (int i = 0; i < prompt_lines; i++)
    put(g, y + 1 + i, x + 2, question.lines[i].text, width - 4, TEXT | PANEL);
  clear_lines(&question);
  if (r->question_selected < r->question_top)
    r->question_top = r->question_selected;
  if (r->question_selected >= r->question_top + visible)
    r->question_top = r->question_selected - visible + 1;
  r->question_y = y + 1 + prompt_lines;
  r->question_visible = visible;
  for (int i = 0; i < visible && r->question_top + i <= count; i++) {
    int index = r->question_top + i;
    const char *label =
        index == count
            ? "自定义回答：在下方输入"
            : json_object_get_string(jat(r->question_options, (size_t)index));
    char *clean = one_line(label),
         *short_label = truncate_text(clean, width - 7);
    char *line =
        format("%s %s", index == r->question_selected ? "▸" : " ", short_label);
    put(g, r->question_y + i, x + 2, line, width - 4,
        index == r->question_selected ? ACCENT | BOLD | NAV : DIM | PANEL);
    free(clean);
    free(short_label);
    free(line);
  }
  put(g, y + height - 1, x + 1,
      r->question_skip ? "↑↓/Tab 选择 · Enter 确认 · Esc 跳过 · 可切换会话"
                       : "输入后 Enter 确认 · Esc 中断任务",
      width - 2, MUTED | PANEL);
}
static Grid build_frame(Renderer *r, int rows, int cols) {
  Grid g = grid_new(rows, cols);
  draw_tabs(r, &g);
  int top = rows >= 18 && cols >= 80 ? 2 : 1;
  if (top == 2) {
    fill(&g, 1, 0, cols, DIM | NAV);
    char cwd[4096];
    const char *base = getcwd(cwd, sizeof cwd) ? strrchr(cwd, '/') : NULL;
    char *title =
        title_for(r, r->session && r->session->file ? r->session->file : "");
    char *context = format(" %s / %s", base ? base + 1 : "dito", title);
    put(&g, 1, 0, context, cols - 24, DIM | NAV);
    put(&g, 1, cols - 23, "Alt+1…9 选择标签", 23, MUTED | NAV);
    free(title);
    free(context);
  }
  int input_height = 1;
  const char *input = r->input.data ? r->input.data : "";
  int current = 0;
  for (const char *p = input, *end = input + strlen(input); p < end;) {
    int n;
    size_t size = glyph(p, end, &n);
    if (*p == '\n' || current + n > cols - 2) {
      input_height++;
      current = *p == '\n' ? 0 : n;
    } else
      current += n;
    p += size;
  }
  if (input_height > 6)
    input_height = 6;
  if (input_height > rows / 4)
    input_height = rows / 4;
  if (input_height < 1)
    input_height = 1;
  int height = rows - top - input_height - 3;
  if (height < 1)
    height = 1;
  bool sidebar = cols >= 112 && rows >= 16 && !r->bash_expanded;
  int body_width = sidebar ? cols - 42 : cols;
  draw_conversation(r, &g, top, height, body_width);
  if (r->bash_expanded)
    draw_bash(r, &g, top, height, 0, cols);
  else if (sidebar)
    draw_bash(r, &g, top, height, cols - 40, 40);
  draw_footer(r, &g, input_height);
  draw_history(r, &g);
  draw_question(r, &g, input_height);
  return g;
}
static char *grid_row(Grid *g, int y, bool styled) {
  Buffer line = {0};
  unsigned current = (unsigned)-1;
  for (int x = 0; x < g->cols; x++) {
    Cell *cell = &g->cells[y * g->cols + x];
    if (cell->continuation)
      continue;
    if (styled && cell->style != current) {
      unsigned c = cell->style & 255;
      if (c > RED)
        c = TEXT;
      char *code = format("\x1b[0m\x1b[38;2;%d;%d;%dm", colors[c][0],
                          colors[c][1], colors[c][2]);
      buf_puts(&line, code);
      free(code);
      if (cell->style & PANEL)
        buf_puts(&line, "\x1b[48;2;33;38;47m");
      else if (cell->style & NAV)
        buf_puts(&line, "\x1b[48;2;22;25;31m");
      if (cell->style & BOLD)
        buf_puts(&line, "\x1b[1m");
      current = cell->style;
    }
    buf_puts(&line, cell->text);
  }
  if (styled)
    buf_puts(&line, "\x1b[0m");
  return line.data ? line.data : xstrdup("");
}
json_object *workbench_snapshot(Renderer *r, int rows, int cols) {
  json_object *result = json_object_new_array();
  if (rows < 6 || cols < 12 || rows > 500 || cols > 1000)
    return result;
  Grid g = build_frame(r, rows, cols);
  for (int y = 0; y < rows; y++) {
    char *row = grid_row(&g, y, true);
    json_object_array_add(result, json_object_new_string(row));
    free(row);
  }
  free(g.cells);
  return result;
}
void workbench_draw(Renderer *r) {
  json_object *rows = workbench_snapshot(r, r->rows, r->cols);
  int count = (int)jlen(rows);
  if (!count) {
    json_object_put(rows);
    return;
  }
  char **frame = xmalloc((size_t)count * sizeof *frame);
  fputs("\x1b[?2026h\x1b[?25l\x1b[?7l", stdout);
  for (int y = 0; y < count; y++) {
    frame[y] = xstrdup(json_object_get_string(jat(rows, (size_t)y)));
    if (r->invalidated || count != r->last_count || !r->last_rows ||
        strcmp(frame[y], r->last_rows[y]))
      printf("\x1b[%d;1H%s", y + 1, frame[y]);
  }
  fputs("\x1b[?7h", stdout);
  if (!r->history_open)
    printf("\x1b[%d;%dH\x1b[?25h", r->cursor_row + 1, r->cursor_col + 1);
  fputs("\x1b[?2026l", stdout);
  fflush(stdout);
  for (int i = 0; i < r->last_count; i++)
    free(r->last_rows[i]);
  free(r->last_rows);
  r->last_rows = frame;
  r->last_count = count;
  r->invalidated = false;
  r->dirty = false;
  json_object_put(rows);
}
bool workbench_toggle(Renderer *r, int row) {
  if (row < 0 || row >= r->hit_rows || !r->body_hits)
    return false;
  int index = r->body_hits[row];
  Workbench *w = view(r);
  if (index < 0 || (size_t)index >= w->count)
    return false;
  Block *b = &w->blocks[index];
  b->expanded = !b->expanded;
  b->revision++;
  return true;
}
void workbench_free(Renderer *r) {
  Workbench *w = r->workbench;
  if (!w)
    return;
  for (size_t i = 0; i < w->count; i++) {
    Block *b = &w->blocks[i];
    clear_lines(b);
    free(b->name);
    free(b->id);
    buf_free(&b->body);
    buf_free(&b->args);
    buf_free(&b->output);
  }
  clear_lines(&w->bash_lines);
  free(w->blocks);
  free(w);
  r->workbench = NULL;
}
