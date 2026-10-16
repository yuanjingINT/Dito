#include "dito.h"
#include <stdlib.h>
#include <string.h>

void sse_init(SSE *s) { memset(s, 0, sizeof *s); }
static int dispatch(SSE *s, SSEFn fn, void *ctx) {
  if (!s->data.len) {
    free(s->event);
    s->event = NULL;
    return 0;
  }
  if (s->data.data[s->data.len - 1] == '\n')
    s->data.data[--s->data.len] = 0;
  int rc = fn(ctx, s->event ? s->event : "message", s->data.data);
  buf_reset(&s->data);
  free(s->event);
  s->event = NULL;
  return rc;
}
static int line_end(SSE *s, SSEFn fn, void *ctx) {
  char *line = s->line.data ? s->line.data : "";
  if (!s->line.len)
    return dispatch(s, fn, ctx);
  if (line[0] != ':') {
    char *colon = strchr(line, ':');
    char *val = colon ? colon + 1 : line + s->line.len;
    if (colon)
      *colon = 0;
    if (*val == ' ')
      val++;
    if (!strcmp(line, "data")) {
      if (s->data.len + strlen(val) > DITO_MAX_BODY)
        return -1;
      buf_puts(&s->data, val);
      buf_puts(&s->data, "\n");
    } else if (!strcmp(line, "event")) {
      free(s->event);
      s->event = xstrdup(val);
    }
  }
  buf_reset(&s->line);
  return 0;
}
int sse_feed(SSE *s, const char *data, size_t n, SSEFn fn, void *ctx) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)data[i];
    if (c == '\n' && s->cr) {
      s->cr = false;
      continue;
    }
    s->cr = c == '\r';
    if (c == '\r' || c == '\n') {
      int rc = line_end(s, fn, ctx);
      if (rc)
        return rc;
    } else {
      if (s->line.len >= DITO_MAX_BODY)
        return -1;
      buf_add(&s->line, &c, 1);
    }
  }
  return 0;
}
int sse_finish(SSE *s, SSEFn fn, void *ctx) {
  if (s->line.len) {
    int rc = line_end(s, fn, ctx);
    if (rc)
      return rc;
  }
  return dispatch(s, fn, ctx);
}
void sse_free(SSE *s) {
  buf_free(&s->line);
  buf_free(&s->data);
  free(s->event);
  memset(s, 0, sizeof *s);
}
void text_filter(TextFilter *s, const char *data, size_t n, Buffer *out) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)data[i];
    if (s->utf8_need) {
      if ((c & 0xc0) == 0x80) {
        s->utf8[s->utf8_len++] = c;
        if (s->utf8_len < s->utf8_need)
          continue;
        uint32_t cp = s->utf8[0] & (s->utf8_need == 2   ? 0x1f
                                    : s->utf8_need == 3 ? 0x0f
                                                        : 0x07);
        for (unsigned k = 1; k < s->utf8_need; k++)
          cp = (cp << 6) | (s->utf8[k] & 0x3f);
        bool valid = cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) &&
                     !(s->utf8_need == 2 && cp < 0x80) &&
                     !(s->utf8_need == 3 && cp < 0x800) &&
                     !(s->utf8_need == 4 && cp < 0x10000);
        if (!valid)
          buf_puts(out, "�");
        else if (cp >= 0x80 && cp <= 0x9f) {
          if (cp == 0x9b)
            s->state = 2;
          else if (cp == 0x9d || cp == 0x90 || cp == 0x98 || cp == 0x9e ||
                   cp == 0x9f)
            s->state = 3;
          else if (cp == 0x9c)
            s->state = 0;
        } else if (!s->state)
          buf_add(out, s->utf8, s->utf8_len);
        s->utf8_len = s->utf8_need = 0;
        continue;
      }
      buf_puts(out, "�");
      s->utf8_len = s->utf8_need = 0;
    }
    if (c >= 0xc2 && c <= 0xf4) {
      s->utf8[0] = c;
      s->utf8_len = 1;
      s->utf8_need = c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
      s->cr = false;
      continue;
    }
    if (c == 0x9b) {
      s->state = 2;
      continue;
    }
    if (c == 0x9d || c == 0x90 || c == 0x98 || c == 0x9e || c == 0x9f) {
      s->state = 3;
      continue;
    }
    if (c == 0x9c) {
      s->state = 0;
      continue;
    }
    if (c >= 0x80) {
      if (!s->state && c > 0x9f)
        buf_puts(out, "�");
      continue;
    }
    if (s->state == 4) {
      s->state = c == '\\' || c == 7 ? 0 : c == 27 ? 4 : 3;
      continue;
    }
    if (s->state == 3) {
      if (c == 27)
        s->state = 4;
      else if (c == 7)
        s->state = 0;
      continue;
    }
    if (s->state == 2) {
      if (c >= 0x40 && c <= 0x7e)
        s->state = 0;
      else if (c == 27)
        s->state = 1;
      continue;
    }
    if (s->state == 1) {
      if (c == '[')
        s->state = 2;
      else if (strchr("]PX^_", c) && c)
        s->state = 3;
      else if (c >= 0x30 && c <= 0x7e)
        s->state = 0;
      continue;
    }
    if (c == 27) {
      s->state = 1;
      continue;
    }
    if (c == '\r') {
      buf_puts(out, "\n");
      s->cr = true;
      continue;
    }
    if (c == '\n' && s->cr) {
      s->cr = false;
      continue;
    }
    s->cr = false;
    if (c == '\n' || c == '\t' || (c >= 0x20 && c != 0x7f))
      buf_add(out, &c, 1);
  }
}
char *safe_text(const char *s) {
  Buffer out = {0};
  TextFilter f = {0};
  text_filter(&f, s, strlen(s), &out);
  if (f.utf8_need)
    buf_puts(&out, "�");
  if (!out.data)
    buf_puts(&out, "");
  return out.data;
}
