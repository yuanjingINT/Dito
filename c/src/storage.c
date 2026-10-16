#include "dito.h"
#include <ctype.h>
#include <dirent.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int seed_directory(sqlite3_stmt *insert, const char *root,
                          const char *relative, int depth) {
  if (depth > 32)
    return -1;
  char *dir = *relative ? format("%s/%s", root, relative) : xstrdup(root);
  DIR *d = opendir(dir);
  if (!d) {
    free(dir);
    return 0;
  }
  int rc = 0;
  struct dirent *entry;
  while ((entry = readdir(d))) {
    if (entry->d_name[0] == '.')
      continue;
    char *name = *relative ? format("%s/%s", relative, entry->d_name)
                           : xstrdup(entry->d_name);
    char *path = format("%s/%s", root, name);
    struct stat st;
    if (lstat(path, &st)) {
      free(name);
      free(path);
      continue;
    }
    if (S_ISDIR(st.st_mode)) {
      if (seed_directory(insert, root, name, depth + 1))
        rc = -1;
    } else if (S_ISREG(st.st_mode)) {
      size_t n = strlen(name);
      if (n > 3 && !strcmp(name + n - 3, ".md")) {
        char *content = read_file(path, DITO_MAX_BODY, NULL);
        if (content) {
          char *title = xstrdup(entry->d_name);
          title[strlen(title) - 3] = 0;
          sqlite3_reset(insert);
          sqlite3_clear_bindings(insert);
          sqlite3_bind_text(insert, 1, name, -1, SQLITE_TRANSIENT);
          sqlite3_bind_text(insert, 2, title, -1, SQLITE_TRANSIENT);
          sqlite3_bind_text(insert, 3, content, -1, SQLITE_TRANSIENT);
          sqlite3_bind_int64(insert, 4, (int64_t)time(NULL) * 1000);
          if (sqlite3_step(insert) != SQLITE_DONE)
            rc = -1;
          free(title);
          free(content);
        }
      }
    }
    free(name);
    free(path);
    if (rc)
      break;
  }
  closedir(d);
  free(dir);
  return rc;
}
static sqlite3 *database(Session *s, bool kb) {
  char *dir = NULL;
  if (!strncmp(s->scope, "qq-", 3))
    dir = format("%s/qq", s->config->user_dir);
  else if (!strncmp(s->scope, "matrix-", 7))
    dir = format("%s/matrix", s->config->user_dir);
  else
    dir = xstrdup(s->config->data_dir);
  if (mkdir_private(dir)) {
    free(dir);
    return NULL;
  }
  char *path = *s->scope
                   ? format("%s/%s-%s.db", dir, kb ? "kb" : "memory", s->scope)
                   : format("%s/%s.db", dir, kb ? "kb" : "memory");
  free(dir);
  if (*s->scope && access(path, F_OK) &&
      (!strncmp(s->scope, "qq-", 3) || !strncmp(s->scope, "matrix-", 7))) {
    char *legacy = format("%s/%s-%s.db", s->config->data_dir,
                          kb ? "kb" : "memory", s->scope);
    if (!access(legacy, F_OK)) {
      free(path);
      path = legacy;
    } else
      free(legacy);
  }
  sqlite3 *db = NULL;
  if (sqlite3_open_v2(path, &db,
                      SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
                          SQLITE_OPEN_FULLMUTEX,
                      NULL) != SQLITE_OK) {
    if (db)
      sqlite3_close(db);
    free(path);
    return NULL;
  }
  free(path);
  sqlite3_busy_timeout(db, 5000);
  sqlite3_exec(db, "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;", NULL,
               NULL, NULL);
  const char *schema =
      kb ? "CREATE TABLE IF NOT EXISTS kb_entries(id INTEGER PRIMARY KEY "
           "AUTOINCREMENT,name TEXT NOT NULL UNIQUE,title TEXT NOT "
           "NULL,content TEXT NOT NULL,source TEXT NOT NULL DEFAULT "
           "'user',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);"
         : "CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY "
           "AUTOINCREMENT,content TEXT NOT NULL,source TEXT DEFAULT "
           "'user',confidence REAL DEFAULT 1.0,recall_count INTEGER DEFAULT "
           "0,strength REAL NOT NULL DEFAULT 1.0,status TEXT NOT NULL DEFAULT "
           "'active',last_recalled_at INTEGER,created_at INTEGER NOT "
           "NULL,updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS "
           "episodes(id INTEGER PRIMARY KEY AUTOINCREMENT,content TEXT NOT "
           "NULL,user_message TEXT NOT NULL DEFAULT '',assistant_message TEXT "
           "NOT NULL DEFAULT '',retention TEXT NOT NULL DEFAULT "
           "'short_term',created_at INTEGER NOT NULL,expires_at "
           "INTEGER,updated_at INTEGER NOT NULL DEFAULT 0,strength REAL NOT "
           "NULL DEFAULT 1.0,status TEXT NOT NULL DEFAULT "
           "'active',recall_count INTEGER NOT NULL DEFAULT 0,last_recalled_at "
           "INTEGER,promotion_pending INTEGER NOT NULL DEFAULT 0,promoted_at "
           "INTEGER,consolidated_at INTEGER);";
  if (sqlite3_exec(db, schema, NULL, NULL, NULL) != SQLITE_OK) {
    sqlite3_close(db);
    return NULL;
  }
  if (!kb) {
    const char *migrations[] = {
        "ALTER TABLE facts ADD COLUMN strength REAL NOT NULL DEFAULT 1.0",
        "ALTER TABLE facts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
        "ALTER TABLE facts ADD COLUMN last_recalled_at INTEGER",
        "ALTER TABLE episodes ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE episodes ADD COLUMN strength REAL NOT NULL DEFAULT 1.0",
        "ALTER TABLE episodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
        "ALTER TABLE episodes ADD COLUMN recall_count INTEGER NOT NULL DEFAULT "
        "0",
        "ALTER TABLE episodes ADD COLUMN last_recalled_at INTEGER",
        "ALTER TABLE episodes ADD COLUMN promotion_pending INTEGER NOT NULL "
        "DEFAULT 0",
        "ALTER TABLE episodes ADD COLUMN promoted_at INTEGER",
        "ALTER TABLE episodes ADD COLUMN consolidated_at INTEGER"};
    for (size_t i = 0; i < sizeof migrations / sizeof *migrations; i++)
      sqlite3_exec(db, migrations[i], NULL, NULL, NULL);
    sqlite3_exec(db, "ALTER TABLE facts ADD COLUMN decayed_at INTEGER", NULL,
                 NULL, NULL);
    sqlite3_exec(db, "ALTER TABLE episodes ADD COLUMN decayed_at INTEGER", NULL,
                 NULL, NULL);
    sqlite3_exec(db,
                 "UPDATE episodes SET updated_at=created_at WHERE updated_at=0",
                 NULL, NULL, NULL);
  }
  if (kb) {
    sqlite3_stmt *count = NULL;
    bool empty = false;
    if (sqlite3_prepare_v2(db, "SELECT count(*) FROM kb_entries", -1, &count,
                           NULL) == SQLITE_OK &&
        sqlite3_step(count) == SQLITE_ROW)
      empty = sqlite3_column_int64(count, 0) == 0;
    sqlite3_finalize(count);
    if (empty) {
      sqlite3_stmt *insert = NULL;
      if (sqlite3_prepare_v2(db,
                             "INSERT OR IGNORE INTO "
                             "kb_entries(name,title,content,source,created_at,"
                             "updated_at) VALUES(?1,?2,?3,'default',?4,?4)",
                             -1, &insert, NULL) == SQLITE_OK) {
        char *root = format("%s/kb", s->config->resource);
        if (sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) ==
            SQLITE_OK) {
          int rc = seed_directory(insert, root, "", 0);
          sqlite3_exec(db, rc ? "ROLLBACK" : "COMMIT", NULL, NULL, NULL);
        }
        free(root);
      }
      sqlite3_finalize(insert);
    }
  }
  return db;
}
static json_object *rows(sqlite3_stmt *st) {
  json_object *out = json_object_new_array();
  while (sqlite3_step(st) == SQLITE_ROW) {
    json_object *row = json_object_new_object();
    for (int i = 0; i < sqlite3_column_count(st); i++) {
      const char *name = sqlite3_column_name(st, i);
      json_object *v =
          sqlite3_column_type(st, i) == SQLITE_INTEGER
              ? json_object_new_int64(sqlite3_column_int64(st, i))
          : sqlite3_column_type(st, i) == SQLITE_FLOAT
              ? json_object_new_double(sqlite3_column_double(st, i))
              : json_object_new_string(
                    (const char *)(sqlite3_column_text(st, i)
                                       ? sqlite3_column_text(st, i)
                                       : (const unsigned char *)""));
      json_object_object_add(row, name, v);
    }
    json_object_array_add(out, row);
  }
  return out;
}
static double setting(Session *s, const char *key, double fallback, double min,
                      double max) {
  json_object *v = jget(jpath(s->config->json, "plugins.memory"), key);
  double n = v && (json_object_is_type(v, json_type_double) ||
                   json_object_is_type(v, json_type_int))
                 ? json_object_get_double(v)
                 : fallback;
  if (!isfinite(n))
    n = fallback;
  return fmin(max, fmax(min, n));
}
static char *lower_text(const char *text) {
  char *out = xstrdup(text);
  for (unsigned char *p = (unsigned char *)out; *p; p++)
    if (*p < 128)
      *p = (unsigned char)tolower(*p);
  return out;
}
static void token_add(json_object *tokens, const char *p, size_t n) {
  if (jlen(tokens) >= 256 || n < 2)
    return;
  for (size_t i = 0; i < jlen(tokens); i++) {
    const char *old = json_object_get_string(jat(tokens, i));
    if (strlen(old) == n && !memcmp(old, p, n))
      return;
  }
  json_object_array_add(tokens, json_object_new_string_len(p, (int)n));
}
static bool han(const unsigned char *p, const unsigned char *end) {
  if (end - p < 3 || (p[0] & 0xf0) != 0xe0 || (p[1] & 0xc0) != 0x80 ||
      (p[2] & 0xc0) != 0x80)
    return false;
  unsigned cp = ((p[0] & 15u) << 12) | ((p[1] & 63u) << 6) | (p[2] & 63u);
  return cp >= 0x4e00 && cp <= 0x9fff;
}
static json_object *tokens_for(const char *query) {
  char *text = lower_text(query);
  const unsigned char *p = (unsigned char *)text, *end = p + strlen(text);
  json_object *tokens = json_object_new_array();
  while (p < end) {
    const unsigned char *start = p;
    if (han(p, end)) {
      while (han(p, end))
        p += 3;
      token_add(tokens, (const char *)start, (size_t)(p - start));
      for (const unsigned char *k = start; k + 6 <= p; k += 3)
        token_add(tokens, (const char *)k, 6);
    } else if (*p < 128 && (isalnum(*p) || strchr("_+#.%-", *p))) {
      while (p < end && *p < 128 && (isalnum(*p) || strchr("_+#.%-", *p)))
        p++;
      token_add(tokens, (const char *)start, (size_t)(p - start));
    } else
      p++;
  }
  free(text);
  return tokens;
}
static void decay(Session *s, sqlite3 *db) {
  json_object *cfg = jpath(s->config->json, "plugins.memory");
  if (!jbool(cfg, "forgettingEnabled", true))
    return;
  const char *tables[] = {"facts", "episodes"};
  int64_t now = (int64_t)time(NULL) * 1000;
  double half = setting(s, "forgettingHalfLifeDays", 7, .1, 3650),
         min = setting(s, "forgettingMinStrength", .15, 0, 1);
  for (size_t i = 0; i < 2; i++) {
    char *migration =
        format("ALTER TABLE %s ADD COLUMN decayed_at INTEGER", tables[i]);
    sqlite3_exec(db, migration, NULL, NULL, NULL);
    free(migration);
    char *sql =
        format("SELECT "
               "id,strength,COALESCE(decayed_at,last_recalled_at,updated_at,"
               "created_at) AS anchor FROM %s WHERE status='active'",
               tables[i]);
    sqlite3_stmt *st = NULL;
    json_object *items = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) == SQLITE_OK)
      items = rows(st);
    free(sql);
    sqlite3_finalize(st);
    sql =
        format("UPDATE %s SET strength=?1,status=?2,decayed_at=?3 WHERE id=?4",
               tables[i]);
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) == SQLITE_OK)
      for (size_t k = 0; k < jlen(items); k++) {
        json_object *v = jat(items, k);
        double days =
            fmax(0, (double)(now - json_object_get_int64(jget(v, "anchor"))) /
                        86400000);
        if (days < .25)
          continue;
        double strength =
            json_object_get_double(jget(v, "strength")) * exp2(-days / half);
        sqlite3_reset(st);
        sqlite3_bind_double(st, 1, strength);
        sqlite3_bind_text(st, 2, strength < min ? "forgotten" : "active", -1,
                          SQLITE_STATIC);
        sqlite3_bind_int64(st, 3, now);
        sqlite3_bind_int64(st, 4, json_object_get_int64(jget(v, "id")));
        sqlite3_step(st);
      }
    free(sql);
    sqlite3_finalize(st);
    if (items)
      json_object_put(items);
  }
}
static int compare_hits(const void *a, const void *b) {
  double x = json_object_get_double(jget(*(json_object *const *)a, "score"));
  double y = json_object_get_double(jget(*(json_object *const *)b, "score"));
  return x > y ? -1 : x < y ? 1 : 0;
}
static json_object *recall(Session *s, sqlite3 *db, const char *query,
                           int limit, bool events_only) {
  decay(s, db);
  json_object *tokens = tokens_for(query), *hits = json_object_new_array();
  if (!jlen(tokens)) {
    json_object_put(tokens);
    return hits;
  }
  char *phrase = lower_text(query);
  sqlite3_stmt *st = NULL;
  const char *sql =
      events_only
          ? "SELECT id,content,'diary' AS source,created_at,strength,'episode' "
            "AS kind,retention FROM episodes WHERE status='active' AND "
            "(retention='long_term' OR expires_at IS NULL OR expires_at>?1)"
          : "SELECT id,content,source,created_at,strength,'fact' AS kind,'' AS "
            "retention FROM facts WHERE status='active' UNION ALL SELECT "
            "id,content,'diary',created_at,strength,'episode',retention FROM "
            "episodes WHERE status='active' AND (retention='long_term' OR "
            "expires_at IS NULL OR expires_at>?1)";
  json_object *all = NULL;
  if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) == SQLITE_OK) {
    sqlite3_bind_int64(st, 1, (int64_t)time(NULL) * 1000);
    all = rows(st);
  }
  sqlite3_finalize(st);
  json_object **ranked = xmalloc((jlen(all) + 1) * sizeof *ranked);
  size_t count = 0;
  for (size_t i = 0; i < jlen(all); i++) {
    json_object *row = jat(all, i);
    const char *content = jstr(row, "content", "");
    char *text = lower_text(content);
    double score = *phrase && strstr(text, phrase) ? 90 : 0;
    size_t matched = 0;
    const char *first = NULL;
    for (size_t k = 0; k < jlen(tokens); k++) {
      const char *token = json_object_get_string(jat(tokens, k));
      const char *p = text;
      int occurrences = 0;
      while ((p = strstr(p, token)) && occurrences < 10) {
        if (!first || p < first)
          first = p;
        occurrences++;
        p += strlen(token);
      }
      if (occurrences) {
        matched++;
        score += 20 + occurrences * 2;
      }
    }
    score += (double)matched / (double)jlen(tokens) * 55;
    double strength =
        fmax(0, fmin(1, json_object_get_double(jget(row, "strength"))));
    score *= .65 + .35 * strength;
    if (score > 0) {
      size_t start =
          first && first - text > 150 ? (size_t)(first - text) - 150 : 0;
      size_t n = strlen(content), end = start + 600;
      while (start < n && ((unsigned char)content[start] & 0xc0) == 0x80)
        start++;
      if (end > n)
        end = n;
      while (end < n && end > start &&
             ((unsigned char)content[end] & 0xc0) == 0x80)
        end--;
      json_object *hit = json_copy(row);
      json_object_object_del(hit, "content");
      json_object_object_add(
          hit, "snippet",
          json_object_new_string_len(content + start, (int)(end - start)));
      json_object_object_add(hit, "score",
                             json_object_new_double(round(score * 10) / 10));
      ranked[count++] = hit;
    }
    free(text);
  }
  qsort(ranked, count, sizeof *ranked, compare_hits);
  if (limit < 1)
    limit = 1;
  if (limit > 20)
    limit = 20;
  for (size_t i = 0; i < count; i++) {
    if (i >= (size_t)limit) {
      json_object_put(ranked[i]);
      continue;
    }
    json_object *hit = ranked[i];
    bool episode = !strcmp(jstr(hit, "kind", ""), "episode");
    const char *update =
        episode ? "UPDATE episodes SET "
                  "recall_count=recall_count+1,strength=MIN(1,strength+?1),"
                  "last_recalled_at=?2,updated_at=?2,decayed_at=?2,retention="
                  "CASE WHEN "
                  "retention='short_term' AND recall_count+1>=?4 THEN "
                  "'long_term' ELSE retention END,expires_at=CASE WHEN "
                  "recall_count+1>=?4 THEN NULL ELSE expires_at "
                  "END,promoted_at=CASE WHEN recall_count+1>=?4 THEN "
                  "COALESCE(promoted_at,?2) ELSE promoted_at END WHERE id=?3"
                : "UPDATE facts SET "
                  "recall_count=recall_count+1,strength=MIN(1,strength+?1),"
                  "last_recalled_at=?2,updated_at=?2,decayed_at=?2 WHERE id=?3";
    if (sqlite3_prepare_v2(db, update, -1, &st, NULL) == SQLITE_OK) {
      sqlite3_bind_double(st, 1,
                          setting(s, "forgettingReviewBoost", .35, 0, 1));
      sqlite3_bind_int64(st, 2, (int64_t)time(NULL) * 1000);
      sqlite3_bind_int64(st, 3, json_object_get_int64(jget(hit, "id")));
      if (episode)
        sqlite3_bind_int(st, 4,
                         (int)setting(s, "diaryPromotionRecalls", 3, 1, 100));
      sqlite3_step(st);
    }
    sqlite3_finalize(st);
    st = NULL;
    json_object_array_add(hits, hit);
  }
  free(ranked);
  free(phrase);
  json_object_put(tokens);
  if (all)
    json_object_put(all);
  return hits;
}
static int remember(Session *s, sqlite3 *db, const char *content,
                    const char *source) {
  if (!*content)
    return -1;
  sqlite3_stmt *st = NULL;
  int64_t now = (int64_t)time(NULL) * 1000;
  int64_t existing = 0;
  if (sqlite3_prepare_v2(db,
                         "SELECT id FROM facts WHERE lower(content)=lower(?1) "
                         "AND status='active' LIMIT 1",
                         -1, &st, NULL) == SQLITE_OK) {
    sqlite3_bind_text(st, 1, content, -1, SQLITE_TRANSIENT);
    if (sqlite3_step(st) == SQLITE_ROW)
      existing = sqlite3_column_int64(st, 0);
  }
  sqlite3_finalize(st);
  st = NULL;
  const char *sql =
      existing ? "UPDATE facts SET "
                 "recall_count=recall_count+1,strength=MIN(1,strength+?1),"
                 "updated_at=?2,last_recalled_at=?2,decayed_at=?2 WHERE id=?3"
               : "INSERT INTO facts(content,source,created_at,updated_at) "
                 "VALUES(?1,?2,?3,?3)";
  int rc = sqlite3_prepare_v2(db, sql, -1, &st, NULL);
  if (rc == SQLITE_OK) {
    if (existing) {
      sqlite3_bind_double(st, 1,
                          setting(s, "forgettingReviewBoost", .35, 0, 1));
      sqlite3_bind_int64(st, 2, now);
      sqlite3_bind_int64(st, 3, existing);
    } else {
      sqlite3_bind_text(st, 1, content, -1, SQLITE_TRANSIENT);
      sqlite3_bind_text(st, 2, *source ? source : "user", -1, SQLITE_TRANSIENT);
      sqlite3_bind_int64(st, 3, now);
    }
    rc = sqlite3_step(st) == SQLITE_DONE ? 0 : -1;
  }
  sqlite3_finalize(st);
  return rc;
}
static bool durable(const char *text) {
  const char *cues[] = {"请记住", "记住",     "长期",     "以后",    "从今以后",
                        "我叫",   "我的名字", "我是",     "我喜欢",  "我偏好",
                        "我习惯", "我的生日", "我的项目", "我的目标"};
  for (size_t i = 0; i < sizeof cues / sizeof *cues; i++)
    if (strstr(text, cues[i]))
      return true;
  return false;
}
static void organize(Session *s, sqlite3 *db) {
  json_object *cfg = jpath(s->config->json, "plugins.memory");
  sqlite3_stmt *st = NULL;
  json_object *pending = NULL;
  if (sqlite3_prepare_v2(
          db,
          "SELECT id,user_message FROM episodes WHERE retention='short_term' "
          "AND consolidated_at IS NULL ORDER BY id LIMIT ?1",
          -1, &st, NULL) == SQLITE_OK) {
    sqlite3_bind_int(st, 1, (int)setting(s, "diaryBatchSize", 14, 1, 50));
    pending = rows(st);
  }
  sqlite3_finalize(st);
  st = NULL;
  int64_t now = (int64_t)time(NULL) * 1000;
  for (size_t i = 0; i < jlen(pending); i++) {
    json_object *row = jat(pending, i);
    const char *user = jstr(row, "user_message", "");
    bool cue = durable(user);
    if (cue && jbool(cfg, "autoFact", true)) {
      char *lower = lower_text(user);
      const char *secrets[] = {"password",   "密码",      "token",   "令牌",
                               "密钥",       "api-key",   "api key", "secret",
                               "access-key", "access key"};
      bool sensitive = false;
      for (size_t k = 0; k < sizeof secrets / sizeof *secrets; k++)
        if (strstr(lower, secrets[k]))
          sensitive = true;
      free(lower);
      if (!sensitive) {
        const char *fact = user;
        const char *prefixes[] = {"请你记住", "请记住", "记住"};
        for (size_t k = 0; k < 3; k++)
          if (!strncmp(fact, prefixes[k], strlen(prefixes[k]))) {
            fact += strlen(prefixes[k]);
            break;
          }
        while (*fact &&
               (isspace((unsigned char)*fact) || *fact == ':' || *fact == ','))
          fact++;
        if (!strncmp(fact, "：", 3) || !strncmp(fact, "，", 3))
          fact += 3;
        char *value = xstrdup(fact);
        if (strlen(value) > 1500) {
          size_t end = 1500;
          while (end && ((unsigned char)value[end] & 0xc0) == 0x80)
            end--;
          value[end] = 0;
        }
        remember(s, db, value, "自动整理");
        free(value);
      }
    }
    int similar = 0;
    json_object *tokens = tokens_for(user);
    size_t token_count = jlen(tokens) > 8 ? 8 : jlen(tokens);
    if (token_count &&
        sqlite3_prepare_v2(db, "SELECT user_message FROM episodes", -1, &st,
                           NULL) == SQLITE_OK)
      while (sqlite3_step(st) == SQLITE_ROW) {
        char *text = lower_text((const char *)sqlite3_column_text(st, 0));
        size_t matched = 0;
        for (size_t k = 0; k < token_count; k++)
          if (strstr(text, json_object_get_string(jat(tokens, k))))
            matched++;
        free(text);
        if (matched >= 2 && matched * 2 >= token_count)
          similar++;
      }
    sqlite3_finalize(st);
    st = NULL;
    json_object_put(tokens);
    const char *sql =
        cue || similar >= 2
            ? "UPDATE episodes SET "
              "retention='long_term',expires_at=NULL,promoted_at=COALESCE("
              "promoted_at,?1),updated_at=?1,consolidated_at=?1 WHERE id=?2"
            : "UPDATE episodes SET updated_at=?1,consolidated_at=?1 WHERE "
              "id=?2";
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) == SQLITE_OK) {
      sqlite3_bind_int64(st, 1, now);
      sqlite3_bind_int64(st, 2, json_object_get_int64(jget(row, "id")));
      sqlite3_step(st);
    }
    sqlite3_finalize(st);
    st = NULL;
  }
  if (pending)
    json_object_put(pending);
  if (sqlite3_prepare_v2(db,
                         "DELETE FROM episodes WHERE retention='short_term' "
                         "AND expires_at<=?1 AND promotion_pending=0",
                         -1, &st, NULL) == SQLITE_OK) {
    sqlite3_bind_int64(st, 1, now);
    sqlite3_step(st);
  }
  sqlite3_finalize(st);
}
char *storage_tool(Session *s, const char *name, json_object *a, bool *failed) {
  bool kb = !strncmp(name, "kb_", 3) || strstr(name, "knowledge_base");
  sqlite3 *db = database(s, kb);
  if (!db) {
    *failed = true;
    return xstrdup("无法打开知识库或记忆数据库");
  }
  sqlite3_stmt *st = NULL;
  const char *query = jstr(a, "query", jstr(a, "keyword", ""));
  char *like = format("%%%s%%", query);
  int limit = jint(a, "max_results", jint(a, "limit", 5));
  if (limit < 1)
    limit = 1;
  if (limit > 100)
    limit = 100;
  char *out = NULL;
  int64_t now = (int64_t)time(NULL) * 1000;
  if (!strcmp(name, "kb_search") || !strcmp(name, "search_knowledge_base")) {
    sqlite3_prepare_v2(
        db,
        "SELECT id,name,title,substr(content,1,600) AS snippet,source FROM "
        "kb_entries WHERE instr(lower(content),lower(?1))>0 OR "
        "instr(lower(title),lower(?1))>0 OR instr(lower(name),lower(?1))>0 "
        "ORDER BY updated_at DESC LIMIT ?2",
        -1, &st, NULL);
    if (st) {
      sqlite3_bind_text(st, 1, query, -1, SQLITE_TRANSIENT);
      sqlite3_bind_int(st, 2, limit);
    }
  } else if (!strcmp(name, "kb_list") || !strcmp(name, "list_knowledge_base")) {
    sqlite3_prepare_v2(db,
                       "SELECT id,name,title,source FROM kb_entries WHERE name "
                       "LIKE ?1 OR title LIKE ?1 ORDER BY name LIMIT 1000",
                       -1, &st, NULL);
    if (st)
      sqlite3_bind_text(st, 1, like, -1, SQLITE_TRANSIENT);
  } else if (!strcmp(name, "kb_read") || !strcmp(name, "read_knowledge_base")) {
    sqlite3_prepare_v2(db,
                       "SELECT title,content FROM kb_entries WHERE name=?1 OR "
                       "title=?1 OR CAST(id AS TEXT)=?1 LIMIT 1",
                       -1, &st, NULL);
    if (st) {
      sqlite3_bind_text(st, 1, jstr(a, "entry", jstr(a, "name", "")), -1,
                        SQLITE_TRANSIENT);
      if (sqlite3_step(st) == SQLITE_ROW) {
        const char *title = (const char *)sqlite3_column_text(st, 0),
                   *text = (const char *)sqlite3_column_text(st, 1);
        int start = jint(a, "start_line", 1), max = jint(a, "max_lines", 200);
        if (start < 1)
          start = 1;
        if (max < 1)
          max = 1;
        if (max > 1000)
          max = 1000;
        Buffer b = {0};
        buf_puts(&b, title);
        buf_puts(&b, "\n");
        int line = 1;
        const char *p = text;
        while (*p && line < start) {
          if (*p++ == '\n')
            line++;
        }
        const char *q = p;
        while (*q && line < start + max) {
          if (*q++ == '\n')
            line++;
        }
        buf_add(&b, p, (size_t)(q - p));
        out = b.data;
      } else
        out = xstrdup("未找到知识库条目");
    }
    sqlite3_finalize(st);
    st = NULL;
  } else if (!strcmp(name, "kb_upload") ||
             !strcmp(name, "upload_to_knowledge_base")) {
    const char *title = jstr(a, "title", "");
    const char *text = jstr(a, "content", "");
    char *generated =
        format("%lld-%s.md", (long long)now, *title ? title : "note");
    const char *entry = jstr(a, "name", generated);
    sqlite3_prepare_v2(
        db,
        "INSERT INTO "
        "kb_entries(name,title,content,source,created_at,updated_at) "
        "VALUES(?1,?2,?3,'user',?4,?4) ON CONFLICT(name) DO UPDATE SET "
        "title=excluded.title,content=excluded.content,updated_at=excluded."
        "updated_at",
        -1, &st, NULL);
    if (st) {
      sqlite3_bind_text(st, 1, entry, -1, SQLITE_TRANSIENT);
      sqlite3_bind_text(st, 2, title, -1, SQLITE_TRANSIENT);
      sqlite3_bind_text(st, 3, text, -1, SQLITE_TRANSIENT);
      sqlite3_bind_int64(st, 4, now);
      if (sqlite3_step(st) != SQLITE_DONE)
        *failed = true;
    }
    out = format(*failed ? "保存失败：%s" : "已保存：%s", entry);
    free(generated);
    sqlite3_finalize(st);
    st = NULL;
  } else if (!strcmp(name, "kb_remove") ||
             !strcmp(name, "remove_knowledge_base")) {
    sqlite3_prepare_v2(db, "DELETE FROM kb_entries WHERE name=?1", -1, &st,
                       NULL);
    if (st) {
      sqlite3_bind_text(st, 1, jstr(a, "entry", jstr(a, "name", "")), -1,
                        SQLITE_TRANSIENT);
      if (sqlite3_step(st) != SQLITE_DONE)
        *failed = true;
    }
    out = xstrdup(*failed ? "删除失败" : "已删除知识库条目");
    sqlite3_finalize(st);
    st = NULL;
  } else if (!strcmp(name, "memory_remember") ||
             !strcmp(name, "remember_fact")) {
    *failed =
        remember(s, db, jstr(a, "content", ""), jstr(a, "source", "user")) != 0;
    out = xstrdup(*failed ? "记忆保存失败" : "已记住");
  } else if (!strcmp(name, "memory_search") ||
             !strcmp(name, "memory_search_events") ||
             !strcmp(name, "search_memory")) {
    json_object *result =
        recall(s, db, query, limit, !strcmp(name, "memory_search_events"));
    out = json_text(result);
    json_object_put(result);
  } else if (!strcmp(name, "memory_stats")) {
    sqlite3_prepare_v2(
        db,
        "SELECT (SELECT count(*) FROM facts WHERE status='active') AS "
        "facts,(SELECT "
        "count(*) FROM episodes WHERE status='active') AS episodes",
        -1, &st, NULL);
  } else if (!strcmp(name, "memory_forget")) {
    sqlite3_prepare_v2(
        db, "UPDATE facts SET status='forgotten',updated_at=?2 WHERE id=?1", -1,
        &st, NULL);
    if (st) {
      sqlite3_bind_int(st, 1, jint(a, "id", 0));
      sqlite3_bind_int64(st, 2, now);
      if (sqlite3_step(st) != SQLITE_DONE)
        *failed = true;
    }
    out = xstrdup("记忆已标记为遗忘");
    sqlite3_finalize(st);
    st = NULL;
  } else {
    *failed = true;
    out = xstrdup("存储工具尚未实现");
  }
  if (st) {
    json_object *result = rows(st);
    out = json_text(result);
    json_object_put(result);
    sqlite3_finalize(st);
  }
  if (!out) {
    *failed = true;
    out = xstrdup(sqlite3_errmsg(db));
  }
  free(like);
  sqlite3_close(db);
  return out;
}
char *storage_context(Session *s, const char *query) {
  if (!jbool(jpath(s->config->json, "plugins.memory"), "enabled", true) ||
      !jbool(jpath(s->config->json, "plugins.memory"), "associationEnabled",
             true))
    return xstrdup("");
  sqlite3 *db = database(s, false);
  if (!db)
    return xstrdup("");
  Buffer out = {0};
  int count = (int)setting(s, "associationFacts", 5, 0, 20) +
              (int)setting(s, "associationEpisodes", 3, 0, 20);
  json_object *hits =
      count ? recall(s, db, query, count, false) : json_object_new_array();
  size_t max = (size_t)setting(s, "associationMaxChars", 1800, 200, 10000) * 3;
  for (size_t i = 0; i < jlen(hits) && out.len < max; i++) {
    json_object *hit = jat(hits, i);
    buf_puts(&out, !strcmp(jstr(hit, "kind", ""), "fact") ? "- [知识] "
                                                          : "- [经历] ");
    buf_puts(&out, jstr(hit, "snippet", ""));
    buf_puts(&out, "\n");
  }
  json_object_put(hits);
  sqlite3_close(db);
  if (!out.data)
    buf_puts(&out, "");
  return out.data;
}
int storage_diary(Session *s, const char *user, const char *assistant) {
  if (!jbool(jpath(s->config->json, "plugins.memory"), "enabled", true) ||
      !jbool(jpath(s->config->json, "plugins.memory"), "autoDiary", true) ||
      !*assistant)
    return 0;
  sqlite3 *db = database(s, false);
  if (!db)
    return -1;
  int64_t now = (int64_t)time(NULL) * 1000;
  int days = (int)setting(s, "shortDiaryRetentionDays", 14, 1, 365);
  sqlite3_stmt *st = NULL;
  char *content = format("用户：%s\nDito：%s", user, assistant);
  int rc = sqlite3_prepare_v2(
      db,
      "INSERT INTO "
      "episodes(content,user_message,assistant_message,retention,created_at,"
      "expires_at,updated_at) VALUES(?1,?2,?3,'short_term',?4,?5,?4)",
      -1, &st, NULL);
  if (rc == SQLITE_OK) {
    sqlite3_bind_text(st, 1, content, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 2, user, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 3, assistant, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(st, 4, now);
    sqlite3_bind_int64(st, 5, now + (int64_t)days * 86400000);
    rc = sqlite3_step(st) == SQLITE_DONE ? 0 : -1;
  }
  sqlite3_finalize(st);
  free(content);
  if (!rc)
    organize(s, db);
  sqlite3_close(db);
  return rc;
}
