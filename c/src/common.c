#include "dito.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <strings.h>
volatile sig_atomic_t dito_exit_requested;
#include <poll.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

void *xmalloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) {
    fputs("Dito: out of memory\n", stderr);
    exit(70);
  }
  return p;
}
char *xstrdup(const char *s) {
  size_t n = strlen(s ? s : "") + 1;
  char *p = xmalloc(n);
  memcpy(p, s ? s : "", n);
  return p;
}
char *format(const char *fmt, ...) {
  va_list a, b;
  va_start(a, fmt);
  va_copy(b, a);
  int n = vsnprintf(NULL, 0, fmt, a);
  va_end(a);
  if (n < 0) {
    va_end(b);
    return xstrdup("");
  }
  char *p = xmalloc((size_t)n + 1);
  vsnprintf(p, (size_t)n + 1, fmt, b);
  va_end(b);
  return p;
}
void buf_add(Buffer *b, const void *p, size_t n) {
  if (n > SIZE_MAX - b->len - 1) {
    fputs("buffer overflow\n", stderr);
    exit(70);
  }
  size_t need = b->len + n + 1;
  if (need > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (cap < need) {
      if (cap > SIZE_MAX / 2) {
        cap = need;
        break;
      }
      cap *= 2;
    }
    char *q = realloc(b->data, cap);
    if (!q)
      exit(70);
    b->data = q;
    b->cap = cap;
  }
  if (n)
    memcpy(b->data + b->len, p, n);
  b->len += n;
  b->data[b->len] = 0;
}
void buf_puts(Buffer *b, const char *s) { buf_add(b, s, strlen(s)); }
void buf_reset(Buffer *b) {
  b->len = 0;
  if (b->data)
    b->data[0] = 0;
}
void buf_free(Buffer *b) {
  free(b->data);
  memset(b, 0, sizeof *b);
}
uint64_t mono_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
void iso_now(char out[32]) {
  time_t t = time(NULL);
  struct tm tm;
  gmtime_r(&t, &tm);
  strftime(out, 32, "%Y-%m-%dT%H:%M:%SZ", &tm);
}
char *random_hex(size_t bytes) {
  if (bytes > 128)
    return NULL;
  unsigned char raw[128];
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0)
    return NULL;
  size_t n = 0;
  while (n < bytes) {
    ssize_t k = read(fd, raw + n, bytes - n);
    if (k < 0 && errno == EINTR)
      continue;
    if (k <= 0) {
      close(fd);
      return NULL;
    }
    n += (size_t)k;
  }
  close(fd);
  char *out = xmalloc(bytes * 2 + 1);
  for (size_t i = 0; i < bytes; i++)
    snprintf(out + i * 2, 3, "%02x", raw[i]);
  return out;
}
int mkdir_private(const char *path) {
  char *s = xstrdup(path);
  for (char *p = s + 1; *p; p++)
    if (*p == '/') {
      *p = 0;
      if (mkdir(s, 0700) && errno != EEXIST) {
        free(s);
        return -1;
      }
      *p = '/';
    }
  int rc = mkdir(s, 0700);
  if (rc && errno == EEXIST)
    rc = 0;
  free(s);
  return rc;
}
char *read_file(const char *path, size_t max, size_t *length) {
  FILE *f = fopen(path, "rb");
  if (!f)
    return NULL;
  Buffer b = {0};
  char chunk[8192];
  size_t n;
  while ((n = fread(chunk, 1, sizeof chunk, f))) {
    if (b.len + n > max) {
      buf_free(&b);
      fclose(f);
      errno = EFBIG;
      return NULL;
    }
    buf_add(&b, chunk, n);
  }
  if (ferror(f)) {
    buf_free(&b);
    fclose(f);
    return NULL;
  }
  fclose(f);
  if (!b.data)
    buf_add(&b, "", 0);
  if (length)
    *length = b.len;
  return b.data;
}
int write_atomic(const char *path, const char *text, size_t n) {
  char *tmp = format("%s.tmp-XXXXXX", path);
  int fd = mkstemp(tmp);
  if (fd < 0) {
    free(tmp);
    return -1;
  }
  fchmod(fd, 0600);
  size_t off = 0;
  int rc = 0;
  while (off < n) {
    ssize_t k = write(fd, text + off, n - off);
    if (k < 0 && errno == EINTR)
      continue;
    if (k <= 0) {
      rc = -1;
      break;
    }
    off += (size_t)k;
  }
  if (!rc && fsync(fd))
    rc = -1;
  if (close(fd))
    rc = -1;
  if (!rc && rename(tmp, path))
    rc = -1;
  if (rc)
    unlink(tmp);
  free(tmp);
  return rc;
}
json_object *json_read(const char *path) {
  char *s = read_file(path, DITO_MAX_BODY, NULL);
  if (!s)
    return NULL;
  json_object *j = json_tokener_parse(s);
  free(s);
  return j;
}
json_object *json_copy(json_object *j) {
  if (!j)
    return NULL;
  return json_tokener_parse(
      json_object_to_json_string_ext(j, JSON_C_TO_STRING_PLAIN));
}
json_object *jget(json_object *j, const char *key) {
  json_object *v = NULL;
  if (j && json_object_is_type(j, json_type_object))
    json_object_object_get_ex(j, key, &v);
  return v;
}
size_t jlen(json_object *j) {
  return j && json_object_is_type(j, json_type_array)
             ? json_object_array_length(j)
             : 0;
}
json_object *jat(json_object *j, size_t i) {
  return j && json_object_is_type(j, json_type_array)
             ? json_object_array_get_idx(j, i)
             : NULL;
}
const char *jstr(json_object *j, const char *key, const char *fallback) {
  json_object *v = jget(j, key);
  return v && json_object_is_type(v, json_type_string)
             ? json_object_get_string(v)
             : fallback;
}
int jint(json_object *j, const char *key, int d) {
  json_object *v = jget(j, key);
  return v ? json_object_get_int(v) : d;
}
bool jbool(json_object *j, const char *key, bool d) {
  json_object *v = jget(j, key);
  return v ? json_object_get_boolean(v) : d;
}
json_object *jpath(json_object *j, const char *path) {
  char *s = xstrdup(path), *save = NULL;
  for (char *k = strtok_r(s, ".", &save); k && j;
       k = strtok_r(NULL, ".", &save)) {
    if (json_object_is_type(j, json_type_array)) {
      char *end = NULL;
      long i = strtol(k, &end, 10);
      j = *end || i < 0 ? NULL : jat(j, (size_t)i);
    } else
      j = jget(j, k);
  }
  free(s);
  return j;
}
char *json_text(json_object *j) {
  return xstrdup(j ? json_object_to_json_string_ext(j, JSON_C_TO_STRING_PLAIN)
                   : "null");
}
bool secret_key(const char *key) {
  size_t n = strlen(key);
  return (n >= 3 && !strcasecmp(key + n - 3, "key")) ||
         (n >= 4 && !strcasecmp(key + n - 4, "keys")) ||
         strcasestr(key, "token") || strcasestr(key, "password") ||
         strcasestr(key, "secret") || strcasestr(key, "credential") ||
         strcasestr(key, "authorization") || strcasestr(key, "cookie") ||
         !strcasecmp(key, "env");
}
static void mask_secrets(json_object *j) {
  if (json_object_is_type(j, json_type_object)) {
    json_object_object_foreach(j, key, value) {
      if (secret_key(key))
        json_object_object_add(j, key, json_object_new_string("[hidden]"));
      else
        mask_secrets(value);
    }
  } else if (json_object_is_type(j, json_type_array))
    for (size_t i = 0; i < jlen(j); i++)
      mask_secrets(jat(j, i));
}
json_object *json_redacted(json_object *j) {
  json_object *copy = json_copy(j);
  mask_secrets(copy);
  return copy;
}
void event(Events *e, const char *kind, const char *text, json_object *data) {
  if (e && e->emit)
    e->emit(e->opaque, kind, text ? text : "", data);
}

int process_run_with_events(char *const argv[], const char *cwd,
                            unsigned timeout, volatile sig_atomic_t *cancel,
                            Buffer *out, Events *events) {
  int p[2];
  if (pipe2(p, O_CLOEXEC))
    return -1;
  pid_t pid = fork();
  if (pid < 0) {
    close(p[0]);
    close(p[1]);
    return -1;
  }
  if (pid == 0) {
    setpgid(0, 0);
    if (cwd && chdir(cwd))
      _exit(126);
    dup2(p[1], STDOUT_FILENO);
    dup2(p[1], STDERR_FILENO);
    close(p[0]);
    close(p[1]);
    execvp(argv[0], argv);
    _exit(127);
  }
  close(p[1]);
  setpgid(pid, pid);
  fcntl(p[0], F_SETFL, O_NONBLOCK);
  uint64_t start = mono_ms();
  bool done = false, stop = false;
  int status = 0;
  uint64_t last_output = 0;
  size_t emitted_output = 0;
  while (!done) {
    event(events, "tick", "", NULL);
    struct pollfd f = {p[0], POLLIN, 0};
    poll(&f, 1, 30);
    char chunk[8192];
    ssize_t n;
    while ((n = read(p[0], chunk, sizeof chunk)) > 0) {
      size_t room = DITO_MAX_TOOL > out->len ? DITO_MAX_TOOL - out->len : 0;
      if (room)
        buf_add(out, chunk, (size_t)n < room ? (size_t)n : room);
    }
    if (out->len != emitted_output &&
        mono_ms() - last_output >= DITO_FRAME_MS) {
      event(events, "tool_output", out->data, NULL);
      last_output = mono_ms();
      emitted_output = out->len;
    }
    if ((cancel && *cancel) || dito_exit_requested ||
        mono_ms() - start > timeout) {
      kill(-pid, SIGTERM);
      stop = true;
      break;
    }
    pid_t w = waitpid(pid, &status, WNOHANG);
    if (w == pid)
      done = true;
    else if (w < 0 && errno != EINTR) {
      done = true;
      status = 1 << 8;
    }
  }
  if (stop) {
    uint64_t until = mono_ms() + 300;
    while (waitpid(pid, &status, WNOHANG) == 0 && mono_ms() < until) {
      struct timespec ts = {0, 10000000};
      nanosleep(&ts, NULL);
    }
    kill(-pid, SIGKILL);
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    buf_puts(out, "\n[命令已中断或超时]");
  } else {
    char tail[8192];
    ssize_t n;
    while ((n = read(p[0], tail, sizeof tail)) > 0) {
      size_t room = out->len < DITO_MAX_TOOL ? DITO_MAX_TOOL - out->len : 0;
      if (room)
        buf_add(out, tail, (size_t)n < room ? (size_t)n : room);
    }
  }
  close(p[0]);
  return stop                ? 124
         : WIFEXITED(status) ? WEXITSTATUS(status)
                             : 128 + WTERMSIG(status);
}
int process_run(char *const argv[], const char *cwd, unsigned timeout,
                volatile sig_atomic_t *cancel, Buffer *out) {
  return process_run_with_events(argv, cwd, timeout, cancel, out, NULL);
}
static size_t collect(char *p, size_t s, size_t n, void *arg) {
  Buffer *b = arg;
  size_t z = s * n;
  if (z > DITO_MAX_BODY - b->len)
    return 0;
  buf_add(b, p, z);
  return z;
}
static bool public_ipv4(uint32_t value) {
  unsigned a = value >> 24, b = (value >> 16) & 255;
  return a != 0 && a != 10 && a != 127 && a < 224 && !(a == 169 && b == 254) &&
         !(a == 172 && b >= 16 && b <= 31) &&
         !(a == 192 && (b == 168 || b == 0)) &&
         !(a == 100 && b >= 64 && b <= 127) &&
         !(a == 198 && (b == 18 || b == 19));
}
static curl_socket_t public_socket(void *opaque, curlsocktype purpose,
                                   struct curl_sockaddr *address) {
  (void)opaque;
  (void)purpose;
  bool allowed = false;
  if (address->family == AF_INET) {
    struct sockaddr_in *v = (struct sockaddr_in *)&address->addr;
    allowed = public_ipv4(ntohl(v->sin_addr.s_addr));
  } else if (address->family == AF_INET6) {
    struct sockaddr_in6 *v = (struct sockaddr_in6 *)&address->addr;
    const unsigned char *b = v->sin6_addr.s6_addr;
    bool mapped = true;
    for (int i = 0; i < 10; i++)
      if (b[i])
        mapped = false;
    if (mapped && b[10] == 255 && b[11] == 255) {
      uint32_t ipv4;
      memcpy(&ipv4, b + 12, 4);
      allowed = public_ipv4(ntohl(ipv4));
    } else
      allowed = (b[0] & 0xe0) == 0x20;
  }
  return allowed ? socket(address->family, address->socktype | SOCK_CLOEXEC,
                          address->protocol)
                 : CURL_SOCKET_BAD;
}
static int http_request(const char *method, const char *url, const char *key,
                        json_object *body, Buffer *out, long *status,
                        unsigned timeout, bool public_only, const char *extra,
                        Session *session, Events *events) {
  if (status)
    *status = 0;
  CURL *c = curl_easy_init();
  if (!c)
    return -1;
  struct curl_slist *h = NULL;
  h = curl_slist_append(h, "Content-Type: application/json");
  h = curl_slist_append(h, "Accept: application/json");
  if (extra && !strpbrk(extra, "\r\n"))
    h = curl_slist_append(h, extra);
  char *auth = NULL;
  if (key && *key) {
    if (strpbrk(key, "\r\n")) {
      curl_easy_cleanup(c);
      curl_slist_free_all(h);
      return -1;
    }
    auth = format("Authorization: Bearer %s", key);
    h = curl_slist_append(h, auth);
  }
  char *payload = body ? json_text(body) : NULL;
  curl_easy_setopt(c, CURLOPT_URL, url);
  curl_easy_setopt(c, CURLOPT_PROTOCOLS_STR, "http,https");
  if (!strcmp(method, "GET") && (!key || !*key) && !extra) {
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_MAXREDIRS, 5L);
    curl_easy_setopt(c, CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
  }
  curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method);
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
  curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, (long)timeout);
  curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
  curl_easy_setopt(c, CURLOPT_USERAGENT, "Dito/" DITO_VERSION " (C)");
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, collect);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, out);
  if (public_only) {
    curl_easy_setopt(c, CURLOPT_OPENSOCKETFUNCTION, public_socket);
    curl_easy_setopt(c, CURLOPT_PROXY, "");
  }
  if (payload) {
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, payload);
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)strlen(payload));
  }
  CURLcode rc = CURLE_FAILED_INIT;
  if (!session)
    rc = curl_easy_perform(c);
  else {
    CURLM *multi = curl_multi_init();
    if (multi && curl_multi_add_handle(multi, c) == CURLM_OK) {
      int running = 0;
      CURLMcode mc = curl_multi_perform(multi, &running);
      while (mc == CURLM_OK && running && !session->cancelled &&
             !dito_exit_requested) {
        event(events, "tick", "", NULL);
        curl_multi_poll(multi, NULL, 0, DITO_FRAME_MS, NULL);
        mc = curl_multi_perform(multi, &running);
      }
      int left;
      CURLMsg *msg;
      while ((msg = curl_multi_info_read(multi, &left)))
        if (msg->msg == CURLMSG_DONE)
          rc = msg->data.result;
      if (session->cancelled || dito_exit_requested)
        rc = CURLE_ABORTED_BY_CALLBACK;
      curl_multi_remove_handle(multi, c);
    }
    if (multi)
      curl_multi_cleanup(multi);
  }
  long code = 0;
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
  if (status)
    *status = code;
  free(payload);
  free(auth);
  curl_slist_free_all(h);
  curl_easy_cleanup(c);
  return rc == CURLE_OK && code >= 200 && code < 300 ? 0 : -1;
}
int http_json(const char *method, const char *url, const char *key,
              json_object *body, Buffer *out, long *status, unsigned timeout) {
  return http_request(method, url, key, body, out, status, timeout, false, NULL,
                      NULL, NULL);
}
int http_json_public(const char *method, const char *url, json_object *body,
                     Buffer *out, long *status, unsigned timeout) {
  return http_request(method, url, NULL, body, out, status, timeout, true, NULL,
                      NULL, NULL);
}
int http_json_header(const char *method, const char *url, const char *header,
                     json_object *body, Buffer *out, long *status,
                     unsigned timeout) {
  if (!header || strpbrk(header, "\r\n"))
    return -1;
  return http_request(method, url, NULL, body, out, status, timeout, false,
                      header, NULL, NULL);
}
int http_session(Session *s, Events *events, const char *method,
                 const char *url, const char *key, const char *header,
                 json_object *body, Buffer *out, long *status, unsigned timeout,
                 bool public_only) {
  if (header && strpbrk(header, "\r\n"))
    return -1;
  return http_request(method, url, key, body, out, status, timeout, public_only,
                      header, s, events);
}
