#include "dito.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

static int got(void *opaque, const char *event_name, const char *data) {
  Buffer *b = opaque;
  buf_puts(b, event_name);
  buf_puts(b, ":");
  buf_puts(b, data);
  buf_puts(b, "|");
  return 0;
}
int main(void) {
  const char *stream = ":keepalive\r\nevent: delta\r\ndata: "
                       "{\"text\":\"你好😀\"}\r\n\r\ndata: one\ndata: two\n\n";
  for (size_t split = 0; split <= strlen(stream); split++) {
    SSE s;
    Buffer b = {0};
    sse_init(&s);
    assert(sse_feed(&s, stream, split, got, &b) == 0);
    assert(sse_feed(&s, stream + split, strlen(stream) - split, got, &b) == 0);
    assert(sse_finish(&s, got, &b) == 0);
    assert(!strcmp(b.data, "delta:{\"text\":\"你好😀\"}|message:one\ntwo|"));
    sse_free(&s);
    buf_free(&b);
  }
  const char *raw = "你好😀\r\nA\x1b[2JB\x1b]0;hidden\x07"
                    "C\x1bPprivate\x1b\\D";
  for (size_t split = 0; split <= strlen(raw); split++) {
    TextFilter f = {0};
    Buffer b = {0};
    text_filter(&f, raw, split, &b);
    text_filter(&f, raw + split, strlen(raw) - split, &b);
    assert(!strcmp(b.data, "你好😀\nABCD"));
    buf_free(&b);
  }
  const char *controls = "中\xc2\x9b"
                         "31m文\xc2\x9d"
                         "0;hidden\xc2\x9c"
                         "😀";
  for (size_t split = 0; split <= strlen(controls); split++) {
    TextFilter f = {0};
    Buffer value = {0};
    text_filter(&f, controls, split, &value);
    text_filter(&f, controls + split, strlen(controls) - split, &value);
    assert(!strcmp(value.data, "中文😀"));
    buf_free(&value);
  }
  for (unsigned i = 0; i < 104; i++) {
    Buffer b = {0}, next = {0};
    scanner_frame(i, false, &b);
    scanner_frame(i + 52, false, &next);
    assert(!strcmp(b.data, next.data));
    assert(!strchr(b.data, 27));
    size_t glyphs = 0;
    for (size_t k = 0; k < b.len; k++)
      if (((unsigned char)b.data[k] & 0xc0) != 0x80)
        glyphs++;
    assert(glyphs == 7);
    buf_free(&b);
    buf_free(&next);
  }
  Buffer b = {0};
  for (size_t i = 0; i < 10000; i++)
    buf_puts(&b, "test");
  assert(b.len == 40000);
  buf_free(&b);
  puts("C core: SSE split boundaries, terminal filter, scanner clock, buffers "
       "OK");
  return 0;
}
