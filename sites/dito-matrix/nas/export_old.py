#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""备份 Synapse 数据库并把可读聊天记录导出成纯文本"""
import json
import os
import sqlite3
import time

SRC = "/volume1/matrix/homeserver.db"
COPY = "/tmp/hs-copy.db"
OUT = "/volume1/backups/matrix-chat-export.txt"

# 1) 用 sqlite 官方 backup API 做一致性快照（在线库也安全）
if os.path.exists(COPY):
    os.remove(COPY)
src = sqlite3.connect(SRC, timeout=30)
dst = sqlite3.connect(COPY)
src.backup(dst)
dst.close()
src.close()
print("快照完成：%s (%.1f MB)" % (COPY, os.path.getsize(COPY) / 1048576))

c = sqlite3.connect(COPY)

# 2) 房间名
names = {}
for rid, nm in c.execute("select room_id, name from room_stats_state where name is not null"):
    names[rid] = nm

lines = []
lines.append("dito Matrix 旧服务器聊天记录导出")
lines.append("server_name: %s" % os.environ.get("DITO_MATRIX_SERVER_NAME", "未指定"))
lines.append("导出时间: %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
lines.append("")
lines.append("=" * 60)

total = 0
for rid, name in sorted(names.items(), key=lambda x: x[1]):
    rows = list(
        c.execute(
            """select ej.json, e.origin_server_ts, e.sender
               from events e join event_json ej on ej.event_id = e.event_id
               where e.room_id = ? and e.type = 'm.room.message'
               order by e.stream_ordering""",
            (rid,),
        )
    )
    if not rows:
        continue
    lines.append("")
    lines.append("【%s】 共 %d 条" % (name, len(rows)))
    lines.append("-" * 60)
    for js, ts, sender in rows:
        try:
            d = json.loads(js)
            body = d.get("content", {}).get("body")
        except Exception:
            body = None
        if body is None:
            continue
        who = sender.split(":")[0].lstrip("@")
        when = time.strftime("%m-%d %H:%M", time.localtime(ts / 1000))
        body = str(body).replace("\n", " ⏎ ")
        if len(body) > 800:
            body = body[:800] + " …[截断]"
        lines.append("[%s] %s: %s" % (when, who, body))
        total += 1
    lines.append("")

lines.append("=" * 60)
lines.append("合计可读消息 %d 条" % total)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

print("导出完成：%s（%d 条消息）" % (OUT, total))

# 3) 顺带统计
print("用户数：", c.execute("select count(*) from users").fetchone()[0])
print("房间数：", c.execute("select count(*) from rooms").fetchone()[0])
c.close()
