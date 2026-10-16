#ifndef DITO_H
#define DITO_H
#include <curl/curl.h>
#include <json-c/json.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define DITO_MAX_BODY (10u * 1024u * 1024u)
#define DITO_MAX_SESSION_LINE (256u * 1024u * 1024u)
#define DITO_MAX_TOOL (128u * 1024u)
#define DITO_FRAME_MS 40
extern volatile sig_atomic_t dito_exit_requested;
typedef struct {
  char *data;
  size_t len, cap;
} Buffer;
typedef struct {
  json_object *json;
  char *resource, *data_dir, *config_file, *user_dir;
} Config;
typedef struct {
  Config *config;
  json_object *messages, *message_ids;
  char *file, *id, *parent, *scope;
  bool readonly, allow_host, sudo_mode, interactive;
  bool chat_only;
  volatile sig_atomic_t cancelled;
  CURL *client;
  CURLM *multi;
  void *mcp;
  char *(*ask)(void *, const char *);
  void *ask_opaque;
} Session;
typedef void (*EventFn)(void *, const char *, const char *, json_object *);
typedef struct {
  EventFn emit;
  void *opaque;
} Events;
typedef struct {
  Buffer line, data;
  char *event;
  bool cr;
  int failed;
} SSE;
typedef int (*SSEFn)(void *, const char *, const char *);
typedef struct {
  unsigned state;
  bool cr;
  unsigned char utf8[4];
  unsigned utf8_len, utf8_need;
} TextFilter;
typedef struct {
  Buffer text, reasoning;
  json_object *calls;
  long status;
  int input_tokens, output_tokens;
  char error[512];
} ModelResult;
typedef struct {
  bool tty, full, thinking, waiting, hidden, invalidated, dirty;
  unsigned frame;
  uint64_t last_frame, started;
  int rows, cols, scroll;
  Buffer text, input;
  char phase[160];
  char tabs[256];
  char **last_rows;
  int last_count;
  Session *session;
  TextFilter filter;
  void *workbench;
  json_object *tab_items;
  char peer_files[2][4096];
  int peer_states[2];
  int visible_tabs[9], tab_count;
  int *tab_hits, *body_hits;
  int hit_cols, hit_rows, body_width, body_top, body_height;
  bool history_open, bash_expanded;
  int history_selected, history_top, bash_scroll;
  int context_tokens;
  int cursor_row, cursor_col;
} Renderer;

void *xmalloc(size_t);
char *xstrdup(const char *);
char *format(const char *, ...) __attribute__((format(printf, 1, 2)));
void buf_add(Buffer *, const void *, size_t);
void buf_puts(Buffer *, const char *);
void buf_reset(Buffer *);
void buf_free(Buffer *);
uint64_t mono_ms(void);
void iso_now(char out[32]);
char *random_hex(size_t);
int mkdir_private(const char *);
char *read_file(const char *, size_t, size_t *);
int write_atomic(const char *, const char *, size_t);
json_object *json_read(const char *);
json_object *json_copy(json_object *);
json_object *jget(json_object *, const char *);
size_t jlen(json_object *);
json_object *jat(json_object *, size_t);
const char *jstr(json_object *, const char *, const char *);
int jint(json_object *, const char *, int);
bool jbool(json_object *, const char *, bool);
json_object *jpath(json_object *, const char *);
char *json_text(json_object *);
bool secret_key(const char *);
json_object *json_redacted(json_object *);
void event(Events *, const char *, const char *, json_object *);
int process_run(char *const[], const char *, unsigned, volatile sig_atomic_t *,
                Buffer *);
int process_run_with_events(char *const[], const char *, unsigned,
                            volatile sig_atomic_t *, Buffer *, Events *);
int http_json(const char *, const char *, const char *, json_object *, Buffer *,
              long *, unsigned);
int http_json_public(const char *, const char *, json_object *, Buffer *,
                     long *, unsigned);
int http_json_header(const char *, const char *, const char *, json_object *,
                     Buffer *, long *, unsigned);
int http_session(Session *, Events *, const char *, const char *, const char *,
                 const char *, json_object *, Buffer *, long *, unsigned, bool);
char *web_tool(Session *, const char *, json_object *, Events *, bool *);
int config_load(Config *, const char *, const char *);
void config_free(Config *);
int config_save(Config *);
int config_set(Config *, const char *, json_object *);
json_object *config_provider(Config *);
json_object *config_model(Config *);
char *config_key(json_object *);
char *resolve_secret(const char *);
int config_ui(Config *);
void sse_init(SSE *);
int sse_feed(SSE *, const char *, size_t, SSEFn, void *);
int sse_finish(SSE *, SSEFn, void *);
void sse_free(SSE *);
void text_filter(TextFilter *, const char *, size_t, Buffer *);
char *safe_text(const char *);
void model_result_free(ModelResult *);
int model_request(Session *, json_object *, Events *, ModelResult *);
int session_open(Session *, Config *, bool, const char *, const char *);
int session_open_channel(Session *, Config *, const char *, const char *);
void session_close(Session *);
int session_append(Session *, json_object *);
int session_compact(Session *, const char *, size_t, size_t);
int compact_context(Session *, Events *, bool);
json_object *session_list(Config *, const char *);
json_object *session_history(const char *);
json_object *session_view(const char *);
char *build_prompt(Config *);
int agent_turn(Session *, const char *, json_object *, Events *);
json_object *tool_definitions(Session *);
char *tool_execute(Session *, const char *, json_object *, Events *, bool *);
void mcp_append_tools(Session *, json_object *);
char *mcp_call(Session *, const char *, json_object *, bool *);
void mcp_close(Session *);
char *storage_tool(Session *, const char *, json_object *, bool *);
char *storage_context(Session *, const char *);
int storage_diary(Session *, const char *, const char *);
void render_init(Renderer *, bool);
void render_event(void *, const char *, const char *, json_object *);
void render_tick(Renderer *);
void render_draw(Renderer *);
void render_finish(Renderer *);
void workbench_event(Renderer *, const char *, const char *, json_object *);
void workbench_history(Renderer *, json_object *);
void workbench_draw(Renderer *);
void workbench_free(Renderer *);
bool workbench_toggle(Renderer *, int);
const char *workbench_tab_path(Renderer *, int);
json_object *workbench_snapshot(Renderer *, int, int);
void scanner_frame(unsigned, bool, Buffer *);
int terminal_chat(Config *, bool);
int terminal_parallel(Config *, bool);
bool legacy_available(Config *);
bool legacy_bridge_command(const char *, int);
bool legacy_chat_required(Config *, const char *);
int legacy_run(Config *, const char *, int, char **);
char *legacy_subagent(Session *, json_object *, Events *, bool *);
int terminal_animation_demo(unsigned);
int serve_http(Config *, const char *, int);
int channel_run(Config *, const char *);
int voice_run(Config *);
#endif
