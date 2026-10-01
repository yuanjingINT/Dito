#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dito-mail 开号轮询
从 get.dito.asia 拉取已审核通过的申请，在 dms-mail 容器里建邮箱账号，然后回执。

由 systemd timer 每 2 分钟触发一次。令牌放 /etc/dito-mail/poller.env。
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

BASE = os.environ.get("DITO_MAIL_BASE", "https://get.dito.asia")
TOKEN = os.environ.get("DITO_MAIL_TOKEN", "")
CONTAINER = os.environ.get("DITO_MAIL_CONTAINER", "dms-mail")
SETUP = "/usr/local/bin/setup"

EMAIL_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]@dito\.asia$")
PASS_RE = re.compile(r"^[^\s]{8,64}$")


def log(msg):
    print(msg, flush=True)


def api(path, data=None, method="GET"):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "content-type": "application/json",
            "user-agent": "dito-mail-poller/1.0",
        },
    )
    if data is not None:
        req.data = json.dumps(data).encode("utf-8")
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def docker_exec(args, timeout=180):
    return subprocess.run(
        ["docker", "exec", CONTAINER] + args,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def create_account(email, password):
    """返回 (是否成功, 说明)"""
    if not EMAIL_RE.match(email):
        return False, "邮箱格式不合法，已拒绝"
    if not PASS_RE.match(password):
        return False, "密码格式不合法，已拒绝"

    # 先看账号是否已存在
    try:
        chk = docker_exec([SETUP, "email", "list"], timeout=60)
        if chk.returncode == 0 and email in chk.stdout:
            return True, "账号已存在，跳过"
    except Exception:
        pass

    try:
        p = docker_exec([SETUP, "email", "add", email, password], timeout=180)
    except subprocess.TimeoutExpired:
        return False, "创建超时"
    except Exception as e:
        return False, "执行异常：%s" % e

    out = ((p.stdout or "") + (p.stderr or "")).strip()
    out = re.sub(r"\s+", " ", out)[-180:]

    if p.returncode == 0:
        log("  建号成功：%s" % email)
        return True, out or "ok"

    log("  建号失败：%s -> %s" % (email, out))
    return False, out or "未知错误"


def main():
    if not TOKEN:
        log("缺少 DITO_MAIL_TOKEN，退出")
        return 1

    try:
        q = api("/api/admin/queue")
    except Exception as e:
        log("拉取队列失败：%s" % e)
        return 1

    jobs = q.get("jobs") or []
    if not jobs:
        return 0

    log("待开通 %d 个" % len(jobs))
    for job in jobs:
        code = job.get("code", "")
        email = (job.get("email") or "").lower()
        password = job.get("password") or ""
        log("处理 %s (%s)" % (email, code))

        ok, note = create_account(email, password)
        try:
            api("/api/admin/ack", {"code": code, "ok": ok, "note": note}, "POST")
            log("  回执已发送：%s" % ("成功" if ok else "失败"))
        except Exception as e:
            log("  回执失败：%s" % e)

    return 0


if __name__ == "__main__":
    sys.exit(main())
