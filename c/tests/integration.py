#!/usr/bin/env python3
"""Native executable contracts against local mock providers; no real model calls."""
import base64
import contextlib
import http.server
import json
import os
import re
from pathlib import Path
import signal
import select
import socket
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(os.environ.get("DITO_C_BINARY", ROOT / "c/build/dito"))
REQUESTS = []
REQUEST_HEADERS = []
REQUEST_TIMES = []
WS_REPLIES = []


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/v1/models":
            raw = json.dumps({"data": [{"id": "test", "context_window": 128000, "max_output_tokens": 300}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if self.path.startswith("/search?"):
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)["q"][0]
            raw = json.dumps({"results": [{"title": "搜索测试你好😀", "url": "https://example.com/reference", "content": query}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if self.path == "/page":
            raw = '<html><body><h1>网页你好😀</h1><script>隐藏脚本</script><p>正文内容</p></body></html>'.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if self.path not in ("/onebot", "/onebot-tool"):
            self.send_error(404)
            return
        import hashlib
        import struct
        accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.connection.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").encode())
        self.connection.settimeout(4)
        def frame(data, first=0x81):
            n = len(data)
            return bytes([first, n]) + data if n < 126 else bytes([first, 126]) + struct.pack("!H", n) + data
        payload = json.dumps({"post_type": "message", "message_type": "private", "user_id": 123,
                              "raw_message": "restricted"}).encode()
        split = len(payload) // 2
        if self.path == "/onebot":
            self.connection.sendall(frame(payload[:split], 0x01) + frame(payload[split:], 0x80))
        def receive(n):
            out = bytearray()
            while len(out) < n:
                part = self.connection.recv(n-len(out))
                if not part:
                    raise ConnectionError("closed")
                out.extend(part)
            return out
        try:
            first, length = receive(2)
            masked, length = bool(length & 128), length & 127
            if length == 126:
                length = struct.unpack("!H", receive(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", receive(8))[0]
            mask = receive(4) if masked else bytes(4)
            body = receive(length)
            if masked:
                body = bytes(value ^ mask[i % 4] for i, value in enumerate(body))
            request = json.loads(body)
            WS_REPLIES.append(request)
            if self.path == "/onebot-tool":
                self.connection.sendall(frame(json.dumps({"status": "ok", "retcode": 0,
                    "data": {"nickname": "mock-qq-tool", "user_id": 456}, "echo": request.get("echo")}).encode()))
            self.connection.sendall(b"\x88\x02\x03\xe8")
        except (OSError, ValueError):
            pass

    def do_POST(self):
        REQUEST_HEADERS.append(dict(self.headers))
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        REQUESTS.append((self.path, body))
        REQUEST_TIMES.append(time.monotonic())
        if self.path == "/mcp":
            method = body["method"]
            if method == "notifications/initialized":
                self.send_response(202)
                self.end_headers()
                return
            result = {}
            if method == "initialize":
                result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "fixture", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": [{"name": "echo", "description": "Fixture echo", "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}}}]}
            elif method == "tools/call":
                result = {"content": [{"type": "text", "text": "C native MCP echo"}]}
            raw = json.dumps({"jsonrpc": "2.0", "id": body.get("id"), "result": result}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Mcp-Session-Id", "fixture-session")
            self.end_headers()
            self.wfile.write(raw)
            return
        if len(body.get("tools", [])) > 128:
            raw = json.dumps({"error": {"message": "tools must contain at most 128 function definitions"}}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        messages = body.get("messages", body.get("input", []))
        users = [m for m in messages if m.get("role") == "user" and not any(p.get("type") == "tool_result" for p in m.get("content", []) if isinstance(p, dict))]
        content = users[-1].get("content", "") if users else ""
        prompt = content if isinstance(content, str) else ("image-test" if any(p.get("type") in ("image_url", "input_image", "image") for p in content) else "".join(p.get("text", "") for p in content))
        if prompt == "overflow-retry" and any("overflow-history" in str(m.get("content", "")) for m in messages):
            raw = json.dumps({"error": {"message": "maximum context length exceeded", "code": "context_length_exceeded"}}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()

        def send(data, event=None):
            value = json.dumps(data, ensure_ascii=False) if not isinstance(data, str) else data
            encoded = ((f"event: {event}\r\n" if event else "") + f"data: {value}\r\n\r\n").encode()
            # Force JSON, CRLF and multibyte UTF-8 across receive boundaries.
            for offset in range(0, len(encoded), 7):
                self.wfile.write(encoded[offset:offset + 7])
                self.wfile.flush()

        try:
            if messages and "将以下对话记录压缩" in str(messages[0].get("content", "")):
                send({"choices": [{"delta": {"content": "摘要：保留用户目标与已完成的 C 实现。"}, "finish_reason": "stop"}]})
                send("[DONE]")
                return
            if prompt in ("wait", "wait-other") or "compat-wait-child" in prompt:
                time.sleep(2)
            if self.path.endswith("/messages"):
                send({"type": "message_start", "message": {"usage": {"input_tokens": 8}}})
                if prompt == "tool" and not any(p.get("type") == "tool_result" for p in messages[-1].get("content", []) if isinstance(p, dict)):
                    send({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "claude-call", "name": "get_system_info", "input": {}}})
                    send({"type": "message_stop"})
                    return
                send({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "推理"}})
                send({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Anthropic你好😀"}})
                send({"type": "message_stop"})
                return
            if self.path.endswith("/responses"):
                if prompt == "tool" and not any(m.get("type") == "function_call_output" for m in messages):
                    send({"type": "response.output_item.added", "output_index": 0, "item": {"type": "function_call", "id": "item-1", "call_id": "response-call", "name": "get_system_info", "arguments": ""}})
                    send({"type": "response.function_call_arguments.delta", "output_index": 0, "delta": "{}"})
                    send({"type": "response.completed", "response": {"usage": {"input_tokens": 8, "output_tokens": 4}}})
                    return
                send({"type": "response.output_text.delta", "delta": "Responses你好😀"})
                send({"type": "response.completed", "response": {"usage": {"input_tokens": 7, "output_tokens": 3}}})
                return
            if (prompt.startswith("tool-json:") or prompt in ("ask-options", "ask-invalid")) and messages[-1].get("role") != "tool":
                if prompt == "ask-options":
                    name, args = "ask_question", {"question": "选择执行方式", "options": ["仅查看", "开始执行"]}
                elif prompt == "ask-invalid":
                    name, args = "ask_question", {"question": "不应弹窗", "options": [123]}
                else:
                    name, args = json.loads(prompt[len("tool-json:"):])
                call = {"index": 0, "id": "restored", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                send({"choices": [{"delta": {"tool_calls": [call]}, "finish_reason": "tool_calls"}]})
                send("[DONE]")
                return
            if prompt in ("tool", "deny", "write", "mcp", "restricted", "search", "fetch", "ask") and messages[-1].get("role") != "tool":
                name, args = {
                    "tool": ("get_system_info", {}),
                    "deny": ("bash", {"command": "rm -rf /"}),
                    "write": ("memory_remember", {"content": "用户喜欢 C 语言"}),
                    "mcp": ("mcp_fixture_echo", {"value": "native"}),
                    "restricted": ("get_system_info", {}),
                    "search": ("web_search", {"query": "中文 搜索😀", "provider": "searxng"}),
                    "fetch": ("web_fetch", {"url": f"http://127.0.0.1:{self.server.server_port}/page"}),
                    "ask": ("ask_question", {"question": "请输入第一会话的答案"}),
                }[prompt]
                call = {"index": 0, "id": "call-1", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                send({"choices": [{"delta": {"tool_calls": [call]}, "finish_reason": "tool_calls"}]})
                send("[DONE]")
                return
            if prompt == "malformed":
                send("{invalid}")
                return
            if prompt == "image-test":
                assert any(p.get("type") == "image_url" for p in content), content
            if prompt.startswith("file:"):
                path = prompt[5:]
                count = sum(m.get("role") == "tool" for m in messages)
                steps = [("write", {"path": path, "content": "first value"}),
                         ("edit", {"path": path, "oldText": "first value", "newText": "second value"}),
                         ("read", {"path": path})]
                if count < len(steps):
                    name, params = steps[count]
                    send({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": f"file-{count}", "type": "function", "function": {"name": name, "arguments": json.dumps(params)}}]}, "finish_reason": "tool_calls"}]})
                    send("[DONE]")
                    return
            if prompt.startswith("cancel-tools:") and messages[-1].get("role") != "tool":
                calls = [{"index": 0, "id": "sleep", "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": "sleep 30"})}},
                         {"index": 1, "id": "write", "type": "function", "function": {"name": "write", "arguments": json.dumps({"path": prompt[len("cancel-tools:"):], "content": "should not run"})}}]
                send({"choices": [{"delta": {"tool_calls": calls}, "finish_reason": "tool_calls"}]})
                send("[DONE]")
                return
            if prompt.startswith("invalid-write:") and messages[-1].get("role") != "tool":
                call = {"index": 0, "id": "invalid", "type": "function", "function": {"name": "write", "arguments": json.dumps({"path": prompt[len("invalid-write:"):]})}}
                send({"choices": [{"delta": {"tool_calls": [call]}, "finish_reason": "tool_calls"}]})
                send("[DONE]")
                return
            if prompt == "live-bash" and messages[-1].get("role") != "tool":
                call = {"index": 0, "id": "live", "type": "function", "function": {
                    "name": "bash", "arguments": json.dumps({"command": "printf 'LIVE-OUTPUT\\n'; sleep 0.8; printf 'DONE-OUTPUT\\n'"})}}
                send({"choices": [{"delta": {"tool_calls": [call]}, "finish_reason": "tool_calls"}]})
                send("[DONE]")
                return
            if prompt in ("compat-parallel", "compat-cancel") and messages[-1].get("role") != "tool":
                tasks = [{"task": "compat-wait-child" if prompt == "compat-cancel" else "compat-child-a", "model": "mock/test"}, {"task": "compat-child-b", "model": "mock/test"}]
                call = {"index": 0, "id": "compat", "type": "function", "function": {"name": "subagent", "arguments": json.dumps({"tasks": tasks})}}
                send({"choices": [{"delta": {"tool_calls": [call]}, "finish_reason": "tool_calls"}]})
                send("[DONE]")
                return
            if prompt == "deny":
                text = messages[-1]["content"]
                assert "禁止" in text or "权限" in text, text
            send({"choices": [{"delta": {"reasoning_content": "思考测试"}}]})
            reply = "slow-session-complete" if prompt == "wait" else "other-session-complete" if prompt == "wait-other" else "fast-session-complete" if prompt == "parallel-second" else "原生 C 回复你好😀"
            send({"choices": [{"delta": {"content": reply}}]})
            if prompt != "truncate":
                send({"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 6}})
                send("[DONE]")
        except (BrokenPipeError, ConnectionResetError):
            pass


class NativeContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dito-c-contract-")
        self.dir = Path(self.temp.name)
        self.config = self.dir / "config.json"
        self.env = dict(os.environ, PI_CODING_AGENT_DIR=str(self.dir / "agent"),
                        DITO_USER_DIR=str(self.dir / "private"), DITO_RESOURCE_DIR=str(ROOT), TERM="dumb", DITO_DISABLE_LEGACY="1")
        self.value = {
            "model": {"provider": "mock", "chat": "test"},
            "providers": [{"id": "mock", "baseUrl": f"http://127.0.0.1:{self.server.server_port}/v1",
                           "apiKey": "test-secret", "api": "openai-completions", "models": [{"id": "test", "maxTokens": 300}]}],
            "unrelated": {"keep": [1, 2, 3]},
        }
        self.save()
        self.request_start = len(REQUESTS)

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.config.write_text(json.dumps(self.value))

    def run_c(self, *args, stdin=None, ok=True):
        result = subprocess.run([str(BINARY), "--config", str(self.config), *args], env=self.env,
                                input=stdin, capture_output=True, text=True, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("test-secret", result.stdout + result.stderr)
        return result

    def test_01_native_startup_and_config_preserves_unknown_keys(self):
        self.assertIn("C", self.run_c("--version").stdout)
        self.assertIn("本地运行时通过", self.run_c("doctor").stdout)
        (self.dir / "agent/dito/sessions").mkdir(parents=True)
        self.assertEqual(json.loads(self.run_c("sessions").stdout), [])
        self.run_c("config", "set", "model.chat", '"new-test"')
        saved = json.loads(self.config.read_text())
        self.assertEqual(saved["unrelated"], {"keep": [1, 2, 3]})
        self.assertEqual(saved["model"]["chat"], "new-test")
        self.assertEqual(len(REQUESTS), self.request_start)

    def test_02_fragmented_sse_and_utf8(self):
        result = self.run_c("send", "--fresh", "hello")
        self.assertIn("原生 C 回复你好😀", result.stdout)
        self.assertNotIn("\x1b", result.stdout)
        self.assertNotIn("�", result.stdout)

    def test_03_tool_round_trip_and_persisted_history(self):
        self.run_c("send", "--fresh", "tool")
        requests = REQUESTS[self.request_start:]
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[-1][1]["messages"][-1]["role"], "tool")
        self.assertIn("Linux", requests[-1][1]["messages"][-1]["content"])
        self.run_c("send", "continue")
        last = REQUESTS[-1][1]["messages"]
        self.assertTrue(any(m.get("role") == "tool" for m in last))
        sessions = json.loads(self.run_c("sessions").stdout)
        self.assertEqual(len(sessions), 1)
        lines = [json.loads(line) for line in Path(sessions[0]["path"]).read_text().splitlines()]
        self.assertEqual(lines[0]["type"], "session")
        self.assertTrue(all(e["parentId"] is None or isinstance(e["parentId"], str) for e in lines[1:]))
        self.assertTrue(any(e.get("message", {}).get("role") == "toolResult" for e in lines))

    def test_04_permissions_block_destructive_shell(self):
        self.run_c("send", "--fresh", "deny")
        self.assertIn("权限门", REQUESTS[-1][1]["messages"][-1]["content"])

    def test_05_memory_is_scope_isolated(self):
        self.run_c("send", "--fresh", "--scope", "alice", "write")
        self.run_c("send", "--fresh", "--scope", "bob", "hello")
        import sqlite3
        path = self.dir / "agent/dito/memory-alice.db"
        with contextlib.closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("select content from facts").fetchone()[0], "用户喜欢 C 语言")
        with contextlib.closing(sqlite3.connect(self.dir / "agent/dito/memory-bob.db")) as db:
            self.assertEqual(db.execute("select count(*) from facts").fetchone()[0], 0)

    def test_06_anthropic_sse(self):
        self.value["providers"][0]["api"] = "anthropic-messages"
        self.save()
        self.assertIn("Anthropic你好😀", self.run_c("send", "--fresh", "hello").stdout)
        request = REQUESTS[-1][1]
        self.assertIsInstance(request["system"], str)
        self.assertIn("input_schema", request["tools"][0])

    def test_07_responses_sse(self):
        self.value["providers"][0]["api"] = "openai-responses"
        self.save()
        self.assertIn("Responses你好😀", self.run_c("send", "--fresh", "hello").stdout)
        self.assertIn("input", REQUESTS[-1][1])

    def test_08_truncated_and_malformed_streams_are_errors(self):
        for prompt in ("truncate", "malformed"):
            result = self.run_c("send", "--fresh", prompt, ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Dito C", result.stderr)

    def test_09_images_survive_transport(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=")
        path = self.dir / "image.png"
        path.write_bytes(png)
        self.run_c("send", "--fresh", "--image", str(path), "describe")
        messages = REQUESTS[-1][1]["messages"]
        content = messages[-1]["content"]
        self.assertTrue(any(p.get("type") == "image_url" for p in content))

    def test_10_cancellation_stops_network_wait(self):
        child = subprocess.Popen([str(BINARY), "--config", str(self.config), "send", "--fresh", "wait"],
                                 env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(0.2)
            start = time.monotonic()
            child.send_signal(signal.SIGINT)
            out, err = child.communicate(timeout=2)
            self.assertLess(time.monotonic() - start, 1)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn("取消", err)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_22_image_model_capabilities_and_binary_input_fail_before_network(self):
        path = self.dir / "image.png"
        path.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII="))
        self.value["providers"][0]["models"][0]["input"] = ["text"]
        self.save()
        self.assertNotEqual(self.run_c("send", "--image", str(path), "describe", ok=False).returncode, 0)
        self.assertNotEqual(self.run_c("send", stdin="a\x00b", ok=False).returncode, 0)
        self.assertEqual(len(REQUESTS), self.request_start)

    def test_23_search_config_and_html_text_extraction(self):
        self.value["plugins"] = {"web_search": {"searxngUrl": f"http://127.0.0.1:{self.server.server_port}"}}
        self.save()
        self.run_c("send", "--fresh", "search")
        tool = REQUESTS[-1][1]["messages"][-1]["content"]
        self.assertIn("搜索测试你好😀", tool)
        self.assertIn("中文 搜索😀", tool)
        self.run_c("send", "--fresh", "fetch")
        tool = REQUESTS[-1][1]["messages"][-1]["content"]
        self.assertIn("网页你好😀", tool)
        self.assertIn("正文内容", tool)
        self.assertNotIn("隐藏脚本", tool)
        self.assertNotIn("<h1>", tool)

    def test_24_memory_organizer_chinese_recall_and_decay(self):
        import sqlite3
        self.run_c("send", "--fresh", "我喜欢快速动画")
        path = self.dir / "agent/dito/memory.db"
        with contextlib.closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("select content from facts").fetchone()[0], "我喜欢快速动画")
            self.assertEqual(db.execute("select retention from episodes").fetchone()[0], "long_term")
        self.run_c("send", "--fresh", "动画怎么实现")
        system = REQUESTS[-1][1]["messages"][0]["content"]
        self.assertIn("我喜欢快速动画", system)
        with contextlib.closing(sqlite3.connect(path)) as db:
            self.assertGreater(db.execute("select recall_count from facts").fetchone()[0], 0)
            db.execute("update facts set strength=1,updated_at=1,last_recalled_at=1,decayed_at=1")
            db.execute("update episodes set status='forgotten'")
            db.commit()
        self.run_c("send", "--fresh", "动画怎么实现")
        system = REQUESTS[-1][1]["messages"][0]["content"]
        self.assertNotIn("我喜欢快速动画", system)
        with contextlib.closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("select status from facts").fetchone()[0], "forgotten")
        self.run_c("send", "--fresh", "请记住我的密码 abc123")
        with contextlib.closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("select count(*) from facts where content like '%abc123%'").fetchone()[0], 0)

    def test_25_corrupt_private_channel_config_is_not_silently_ignored(self):
        private = self.dir / "private/qq/config.json"
        private.parent.mkdir(parents=True)
        private.write_text('{broken')
        result = self.run_c("doctor", ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("私有配置", result.stderr)
        self.assertEqual(private.read_text(), '{broken')

    def test_26_context_compaction_preserves_full_log_and_reloads_summary(self):
        self.value["providers"][0]["models"][0]["contextWindow"] = 800
        self.value["contextCompaction"] = {"minReservedTokens": 50, "compactTailTokens": 40}
        self.save()
        self.run_c("send", "--fresh", "old goal " + "history " * 120)
        self.run_c("send", "latest goal")
        session = json.loads(self.run_c("sessions").stdout)[0]["path"]
        entries = [json.loads(v) for v in Path(session).read_text().splitlines()]
        compactions = [e for e in entries if e["type"] == "compaction"]
        self.assertEqual(len(compactions), 1)
        kept = compactions[0]["firstKeptEntryId"]
        self.assertTrue(any(e.get("id") == kept and e.get("message", {}).get("role") == "user" for e in entries))
        self.assertTrue(any("old goal" in str(e.get("message", {})) for e in entries))
        self.run_c("send", "continue")
        messages = REQUESTS[-1][1]["messages"]
        self.assertTrue(any("摘要：保留用户目标" in str(m.get("content", "")) for m in messages))
        self.assertFalse(any("history " * 20 in str(m.get("content", "")) for m in messages))

    def test_27_blank_keys_and_braced_environment_references(self):
        self.value["providers"][0]["apiKey"] = "   "
        self.save()
        self.run_c("send", "--fresh", "hello")
        self.assertNotIn("Authorization", REQUEST_HEADERS[-1])
        self.assertTrue(REQUEST_HEADERS[-1]["User-Agent"].startswith("dito-agent/"))
        self.value["providers"][0]["apiKey"] = "${DITO_TEST_PROVIDER_KEY}"
        self.env["DITO_TEST_PROVIDER_KEY"] = "test-secret"
        self.save()
        self.run_c("send", "--fresh", "hello")
        self.assertEqual(REQUEST_HEADERS[-1]["Authorization"], "Bearer test-secret")

    def test_28_context_overflow_recovers_without_inventing_window(self):
        self.run_c("send", "--fresh", "overflow-history")
        self.run_c("send", "overflow-retry")
        messages = REQUESTS[-1][1]["messages"]
        self.assertTrue(any("摘要：保留用户目标" in str(m.get("content", "")) for m in messages))
        self.assertFalse(any("overflow-history" in str(m.get("content", "")) for m in messages))

    def test_29_cancellation_stops_tool_process_and_suppresses_remaining_calls(self):
        target = self.dir / "not-written.txt"
        child = subprocess.Popen([str(BINARY), "--config", str(self.config), "send", "--fresh", "cancel-tools:" + str(target)],
                                 env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(100):
                if len(REQUESTS) > self.request_start:
                    break
                time.sleep(.01)
            time.sleep(.15)
            start = time.monotonic()
            child.send_signal(signal.SIGINT)
            out, err = child.communicate(timeout=2)
            self.assertLess(time.monotonic() - start, 1)
            self.assertNotEqual(child.returncode, 0)
            self.assertFalse(target.exists())
            path = json.loads(self.run_c("sessions").stdout)[0]["path"]
            entries = [json.loads(v) for v in Path(path).read_text().splitlines()]
            results = [e["message"] for e in entries if e.get("message", {}).get("role") == "toolResult"]
            self.assertEqual(len(results), 2)
            self.assertTrue(all(r["isError"] for r in results))
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_30_invalid_tool_arguments_do_not_write_files(self):
        path = self.dir / "keep.txt"
        path.write_text("preserved")
        self.run_c("send", "--fresh", "invalid-write:" + str(path))
        self.assertEqual(path.read_text(), "preserved")
        self.assertIn("参数缺失", REQUESTS[-1][1]["messages"][-1]["content"])

    def test_11_mcp_server_native_tools_and_redaction(self):
        self.value["plugins"] = {"web_search": {"tavilyKeys": ["search-private-secret"]}}
        self.save()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        child = subprocess.Popen([str(BINARY), "--config", str(self.config), "mcp", "--port", str(port)],
                                 env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.2) as r:
                        self.assertEqual(json.load(r)["runtime"], "C17")
                    break
                except OSError:
                    time.sleep(0.02)
            else:
                self.fail("MCP did not listen")
            def rpc(method, params=None):
                data = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
                req = urllib.request.Request(f"http://127.0.0.1:{port}/mcp", data, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=2) as r:
                    return json.load(r)
            self.assertEqual(rpc("initialize")["result"]["serverInfo"]["name"], "dito")
            tools = rpc("tools/list")["result"]["tools"]
            self.assertTrue(any(t["name"] == "memory_search" for t in tools))
            self.assertFalse(any(t["name"] in ("bash", "write", "read") for t in tools))
            denied = rpc("tools/call", {"name": "bash", "arguments": {"command": "echo blocked"}})
            self.assertIn("error", denied)
            result = rpc("tools/call", {"name": "memory_remember", "arguments": {"content": "native-mcp-test"}})
            self.assertFalse(result["result"]["isError"])
            legacy_recall = rpc("tools/call", {"name": "memory_recall", "arguments": {"query": "native-mcp-test", "max": 1}})
            self.assertFalse(legacy_recall["result"]["isError"])
            self.assertIn("native-mcp-test", str(legacy_recall))
            self.assertFalse(rpc("tools/call", {"name": "system_info", "arguments": {}})["result"]["isError"])
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/config") as r:
                raw = r.read().decode()
                self.assertNotIn("test-secret", raw)
                self.assertNotIn("search-private-secret", raw)
            attack = urllib.request.Request(f"http://127.0.0.1:{port}/mcp", b'{}',
                                            headers={"Content-Type": "application/json", "Origin": "https://untrusted.example"})
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(attack, timeout=2)
            self.assertEqual(denied.exception.code, 403)
            denied.exception.close()
        finally:
            child.terminate()
            try:
                child.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()

    def test_12_unmigrated_features_fail_closed(self):
        capabilities = json.loads(self.run_c("capabilities").stdout)
        self.assertFalse(capabilities["migrationComplete"])
        result = self.run_c("matrix", ok=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("拒绝降级", result.stderr)

    def test_13_stdio_mcp_client_calls_real_child_process(self):
        import sys
        server = self.dir / "mcp.py"
        server.write_text('''import json,sys
for line in sys.stdin:
 r=json.loads(line); method=r["method"]
 if "id" not in r: continue
 result={}
 if method=="initialize": result={"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}
 elif method=="tools/list": result={"tools":[{"name":"echo","description":"echo fixture","inputSchema":{"type":"object","properties":{"value":{"type":"string"}}}}]}
 elif method=="tools/call": result={"content":[{"type":"text","text":"C native MCP echo"}]}
 print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":result}),flush=True)
''')
        self.value["plugins"] = {"mcp": {"enabled": True, "clients": [{"name": "fixture", "transport": "stdio", "command": sys.executable, "args": [str(server)]}]}}
        self.save()
        self.run_c("send", "--fresh", "mcp")
        self.assertIn("C native MCP echo", REQUESTS[-1][1]["messages"][-1]["content"])

    def test_14_http_mcp_client_calls_real_local_server(self):
        self.value["plugins"] = {"mcp": {"enabled": True, "clients": [{"name": "fixture", "transport": "http", "url": f"http://127.0.0.1:{self.server.server_port}/mcp"}]}}
        self.save()
        self.run_c("send", "--fresh", "mcp")
        self.assertIn("C native MCP echo", REQUESTS[-1][1]["messages"][-1]["content"])

    def pty_process(self, args, actions, size=(24, 100), snapshots=None):
        import pty
        import termios
        import fcntl
        import struct
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", *size, 0, 0))
        env = dict(self.env, TERM="xterm-256color")
        child = subprocess.Popen([str(BINARY), "--config", str(self.config), *args], env=env,
                                 stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        output = bytearray()
        def drain(duration):
            waiting = callable(duration)
            end = time.monotonic() + (5 if waiting else duration)
            while time.monotonic() < end:
                if waiting and duration(output.decode(errors="replace")):
                    return
                if select.select([master], [], [], 0.01)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
            if waiting:
                self.assertTrue(duration(output.decode(errors="replace")), "PTY condition did not become ready")
        try:
            drain(0.15)
            if snapshots is not None:
                snapshots.append(output.decode(errors="replace"))
            for action in actions:
                if callable(action):
                    action = action(output.decode(errors="replace"), slave)
                data, duration = action if isinstance(action, tuple) else (action, .2)
                start = len(output)
                os.write(master, data)
                drain(duration)
                if snapshots is not None:
                    snapshots.append(output[start:].decode(errors="replace"))
            drain(0.2)
            child.wait(timeout=3)
            self.assertEqual(child.returncode, 0, output.decode(errors="replace"))
            self.assertNotIn("AddressSanitizer", output.decode(errors="replace"))
            self.assertNotIn("runtime error:", output.decode(errors="replace"))
            self.assertEqual(termios.tcgetattr(slave), original, "terminal settings must be restored")
            return output.decode(errors="replace")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
            os.close(slave)

    def test_15_native_fullscreen_chat_and_mode_keys(self):
        output = self.pty_process([], [b"\t", b"\t", b"\t", b"hello\r", b"\x03"])
        self.assertIn("DITO", output)
        self.assertIn("历史", output)
        self.assertIn("上下文", output)
        self.assertIn("闲聊", output)
        self.assertIn("计划", output)
        self.assertIn("原生 C 回复你好😀", output)
        self.assertIn("\x1b[?2026h", output)

    def test_16_native_configuration_tui_edits_and_saves(self):
        # Root: version, model. Model: provider, chat.
        output = self.pty_process(["config"], [b"j\r", b"j\r", b"changed-by-curses\n", b"s", b"q"])
        self.assertIn("Dito C", output)
        self.assertNotIn("test-secret", output)
        self.assertEqual(json.loads(self.config.read_text())["model"]["chat"], "changed-by-curses")
        self.assertEqual(json.loads(self.config.read_text())["unrelated"], {"keep": [1, 2, 3]})

    def test_31_two_native_sessions_run_concurrently_with_separate_histories(self):
        output = self.pty_process([], [(b"wait\r", .15), (b"\x1b2", .05),
                                      (b"parallel-second\r", .3), (b"\x1b1", 2.1), b"\x03"])
        requests = REQUESTS[self.request_start:]
        self.assertEqual(len(requests), 2)
        self.assertLess(REQUEST_TIMES[self.request_start + 1] - REQUEST_TIMES[self.request_start], .7)
        self.assertIn("fast-session-complete", output)
        self.assertIn("slow-session-complete", output)
        sessions = json.loads(self.run_c("sessions").stdout)
        self.assertEqual(len(sessions), 2)
        users = []
        for session in sessions:
            entries = [json.loads(v) for v in Path(session["path"]).read_text().splitlines()]
            users.append([e["message"]["content"] for e in entries if e.get("message", {}).get("role") == "user"])
        self.assertIn(["wait"], users)
        self.assertIn(["parallel-second"], users)

    def test_32_cancel_one_native_session_keeps_other_running(self):
        output = self.pty_process([], [(b"wait\r", .15), (b"\x1b2", .05), (b"wait-other\r", .15),
                                      (b"\x1b1", .05), (b"\x1b", .2), (b"\x1b2", 2.1), b"\x03"])
        self.assertIn("当前会话任务已取消", output)
        self.assertIn("other-session-complete", output)
        self.assertNotIn("slow-session-complete", output)

    def test_33_questions_stay_with_their_native_session(self):
        output = self.pty_process([], [(b"ask\r", .25), (b"\x1b2", .05), (b"parallel-second\r", .25),
                                      (b"\x1b1", .05), (b"first-session-answer\r", .3), b"\x03"])
        requests = REQUESTS[self.request_start:]
        self.assertEqual(len(requests), 3)
        answered = requests[-1][1]["messages"][-1]
        self.assertEqual(answered["role"], "tool")
        self.assertEqual(answered["content"], "first-session-answer")
        self.assertIn("请输入第一会话的答案", output)
        self.assertIn("fast-session-complete", output)

    def test_34_queued_follow_up_and_drafts_survive_session_switches(self):
        self.pty_process([], [(b"wait\r", .1), (b"follow-up\r", .1), (b"\x1b2", .05),
                              (b"second-draft", .05), (b"\x1b1", 2.4), (b"\x1b2", .05),
                              (b"\r", .4), b"\x03"])
        requests = REQUESTS[self.request_start:]
        self.assertEqual(len(requests), 3)
        self.assertGreater(REQUEST_TIMES[self.request_start + 1] - REQUEST_TIMES[self.request_start], 1.9)
        self.assertEqual(requests[1][1]["messages"][-1]["content"], "follow-up")
        self.assertEqual(requests[2][1]["messages"][-1]["content"], "second-draft")

    def test_35_resume_uses_last_active_session_instead_of_newest_creation(self):
        self.run_c("send", "--fresh", "old-active")
        first = json.loads(self.run_c("sessions").stdout)[0]["path"]
        self.run_c("send", "--fresh", "new-creation")
        future = time.time() + 60
        os.utime(first, (future, future))
        empty = Path(first).parent / "unused-tab.jsonl"
        empty.write_text(json.dumps({"type": "session", "version": 3, "id": "empty", "timestamp": "2026-10-17T00:00:00Z"}) + '\n')
        os.utime(empty, (future + 60, future + 60))
        self.run_c("send", "continued")
        users = [m["content"] for m in REQUESTS[-1][1]["messages"] if m["role"] == "user"]
        self.assertEqual(users, ["old-active", "continued"])

    @staticmethod
    def screen_rows(output):
        rows = {}
        for match in re.finditer(r"\x1b\[(\d+);1H(.*?)(?=\x1b\[\d+;\d+H|\Z)", output, re.S):
            rows[int(match[1])] = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", match[2])
        return rows

    def write_ui_history(self, name, title, messages):
        path = self.dir / f"agent/dito/sessions/{name}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        records = [{"type": "session", "version": 3, "id": name,
                    "timestamp": "2026-10-17T00:00:00Z", "cwd": str(self.dir)}]
        parent = None
        for i, message in enumerate([{"role": "user", "content": title}, *messages]):
            entry_id = f"{name}-{i}"
            records.append({"type": "message", "id": entry_id, "parentId": parent, "message": message})
            parent = entry_id
        path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records))
        return path

    def test_38_original_history_mouse_disclosures_and_bash_layout(self):
        messages = [
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "hidden-thinking-你好😀"},
             {"type": "toolCall", "name": "bash", "id": "bash-1", "arguments": {"command": "printf fixture"}}]},
            {"role": "toolResult", "toolCallId": "bash-1", "content": [{"type": "text", "text": "restored-bash-output"}]},
            {"role": "assistant", "content": []},
            {"role": "assistant", "content": [{"type": "toolCall", "name": "read", "id": "read-1", "arguments": {"path": "/tmp/fixture"}}]},
            {"role": "toolResult", "toolCallId": "read-1", "content": [{"type": "text", "text": "hidden-tool-result"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "visible-answer"}]},
        ]
        path = self.write_ui_history("original", "original-ui-history", messages)
        original = path.read_bytes()
        def click(label):
            def action(output, _):
                row = next(row for row, text in self.screen_rows(output).items() if label in text)
                return f"\x1b[<0;4;{row}M".encode(), .1
            return action
        frames = []
        output = self.pty_process([], [click("思考"), click("思考"), click("◇ read"),
                                       b"\x1b[66;6u", b"\x1b", b"\x03"], size=(32, 150), snapshots=frames)
        initial = '\n'.join(self.screen_rows(frames[0]).values())
        self.assertIn("restored-bash-output", initial)
        self.assertNotIn("hidden-thinking", initial)
        self.assertNotIn("hidden-tool-result", initial)
        self.assertEqual(sum(text.lstrip().startswith("Dito") for row, text in self.screen_rows(frames[0]).items() if row > 2),
                         1, "tool-only assistant records must not create empty labels")
        self.assertIn("hidden-thinking-你好😀", frames[1])
        self.assertNotIn("hidden-thinking", frames[2])
        self.assertIn("hidden-tool-result", frames[3])
        self.assertIn("Bash", frames[4])
        self.assertIn("\x1b[?1006h", output)
        self.assertIn("\x1b[?1006l", output)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(len(REQUESTS), self.request_start)

    def test_39_history_picker_restores_evicted_draft_and_original_context(self):
        old = self.write_ui_history("older", "older-context", [{"role": "assistant", "content": "old-answer"}])
        current = self.write_ui_history("current", "current-context", [{"role": "assistant", "content": "current-answer"}])
        os.utime(old, (time.time() - 10, time.time() - 10))
        output = self.pty_process([], [b"retained-draft", b"\x1bw", b"j\r", b"\x1bw", b"j\r", b"\r", b"\x03"])
        self.assertIn("历史会话", output)
        self.assertEqual(len(REQUESTS), self.request_start + 1)
        users = [m["content"] for m in REQUESTS[-1][1]["messages"] if m["role"] == "user"]
        self.assertEqual(users, ["current-context", "retained-draft"])
        self.assertNotIn("retained-draft", old.read_text())
        self.assertIn("retained-draft", current.read_text())

    def test_40_mouse_new_tab_and_bracketed_paste_preserve_old_history(self):
        old = self.write_ui_history("existing", "keep-existing", [{"role": "assistant", "content": "kept"}])
        original = old.read_bytes()
        pasted = "多行输入😀\n第二行"
        self.pty_process([], [b"\x1b[<0;146;1M", (b"\x1b[200~" + pasted.encode() + b"\x1b[201~", .1),
                              b"\r", b"\x03"], size=(32, 150))
        self.assertEqual(old.read_bytes(), original)
        self.assertEqual(len(json.loads(self.run_c("sessions").stdout)), 2)
        self.assertEqual(REQUESTS[-1][1]["messages"][-1]["content"], pasted)

    def test_41_bash_output_arrives_while_tool_runs_and_resize_preserves_ui(self):
        import termios
        import fcntl
        import struct
        frames = []
        def resize(_, slave):
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 90, 0, 0))
            return b"", .1
        self.pty_process([], [(b"live-bash\r", .3), resize, (b"\x02", .8), b"\x03"],
                         size=(32, 150), snapshots=frames)
        during = self.screen_rows(frames[1])
        self.assertTrue(any(text.rstrip().endswith("LIVE-OUTPUT") for text in during.values()), during)
        self.assertTrue(any("Bash  ● 运行中" in text for text in during.values()))
        self.assertFalse(any("✓ 完成" in text for text in during.values()))
        self.assertIn("DONE-OUTPUT", frames[3])
        self.assertEqual(len(REQUESTS), self.request_start + 2)

    def fake_legacy_node(self):
        resource = self.dir / "bridge-resources"
        (resource / "config").mkdir(parents=True)
        (resource / "config/dito.json").write_text(json.dumps({**self.value, 'channels': {}}))
        (resource / "legacy").mkdir()
        (resource / "legacy/entry.mjs").write_text("// fixture")
        (resource / "legacy/register-loader.mjs").write_text("// fixture")
        fake = self.dir / "fake-bin"
        fake.mkdir()
        node = fake / "node"
        node.write_text("#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps({'argv':sys.argv[1:], 'config':os.environ.get('DITO_CONFIG_FILE'), 'agent':os.environ.get('PI_CODING_AGENT_DIR'), 'user':os.environ.get('DITO_USER_DIR'), 'session':os.environ.get('DITO_SESSION_FILE'), 'startup':os.environ.get('DITO_STARTUP_COMMAND'), 'clipboard':os.environ.get('DITO_STARTUP_CLIPBOARD'), 'draft':os.environ.get('DITO_STARTUP_DRAFT')}))\n")
        node.chmod(0o755)
        self.env.update(DITO_DISABLE_LEGACY="0", DITO_RESOURCE_DIR=str(resource), PATH=str(fake) + os.pathsep + self.env['PATH'])

    def test_42_native_entry_routes_legacy_commands_without_shell_expansion(self):
        self.fake_legacy_node()
        literal = 'literal; $(touch SHOULD-NOT-EXIST) "quoted"'
        for command in ("qq", "qqadmin", "matrix", "mobile", "bridge", "relay", "voice", "plugins"):
            result = json.loads(self.run_c(command, literal).stdout)
            self.assertEqual(result['argv'][3:], [command, literal])
            self.assertEqual(result['config'], str(self.config))
            self.assertEqual(result['agent'], str(self.dir / "agent"))
            self.assertEqual(result['user'], str(self.dir / "private"))
        self.assertEqual(json.loads(self.run_c("config").stdout)['argv'][-1], "config")
        self.assertFalse((ROOT / "SHOULD-NOT-EXIST").exists())
        self.assertEqual(len(REQUESTS), self.request_start)

    def test_43_native_only_and_explicit_compatibility_entry(self):
        self.fake_legacy_node()
        self.assertIn("本地运行时通过", self.run_c("--native", "doctor").stdout)
        explicit = json.loads(self.run_c("legacy", "--version").stdout)
        self.assertEqual(explicit['argv'][-1], "--version")
        self.env['PATH'] = str(self.dir / "missing-node")
        self.assertIn("本地运行时通过", self.run_c("doctor").stdout)
        result = self.run_c("legacy", "--version", ok=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Node", result.stderr)

    def test_44_real_compatibility_modules_load_without_typescript(self):
        if not shutil.which('node') or not (ROOT / 'legacy/node_modules').exists():
            self.skipTest("Optional legacy dependencies not installed")
        self.env['DITO_DISABLE_LEGACY'] = '0'
        result = self.run_c("legacy", "--check")
        self.assertIn("Legacy JavaScript modules loaded", result.stdout)
        self.assertEqual(len(REQUESTS), self.request_start)

    def test_45_relay_command_starts_existing_javascript_server(self):
        if not shutil.which('node') or not (ROOT / 'legacy/node_modules').exists():
            self.skipTest("Optional legacy dependencies not installed")
        self.env['DITO_DISABLE_LEGACY'] = '0'
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        child = subprocess.Popen([str(BINARY), '--config', str(self.config), 'relay', '--host', '127.0.0.1', '--port', str(port)], env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=.1) as response:
                        health = json.load(response)
                    break
                except OSError:
                    if child.poll() is not None:
                        self.fail(child.communicate()[1])
                    time.sleep(.03)
            else:
                self.fail("legacy relay did not start")
            self.assertTrue(health['ok'])
            self.assertEqual(health['rooms'], 0)
            self.assertEqual(len(REQUESTS), self.request_start)
        finally:
            child.terminate()
            child.communicate(timeout=3)

    def compat_subagent_fixture(self):
        if not shutil.which('node') or not (ROOT / 'legacy/node_modules').exists():
            self.skipTest("Optional legacy dependencies not installed")
        self.env['DITO_DISABLE_LEGACY'] = '0'
        self.value['providers'][0]['models'][0].update(name='Fixture', reasoning=False, input=['text'], contextWindow=128000)
        self.value['plugins'] = {'subagent': {'enabled': True, 'maxAgents': 8, 'maxConcurrency': 2}, 'mcp': {'enabled': False}, 'snowluma': {'enabled': False}}
        self.save()

    def test_46_complex_subagent_uses_real_legacy_scheduler_and_ephemeral_workers(self):
        self.compat_subagent_fixture()
        result = subprocess.run([str(BINARY), '--config', str(self.config), 'send', '--fresh', 'compat-parallel'], env=self.env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        requests = REQUESTS[self.request_start:]
        self.assertEqual(len(requests), 4, result.stdout + result.stderr)
        self.assertTrue(all(path.endswith('/chat/completions') for path, _ in requests))
        self.assertIn('compat-child-a', str(requests[1:3]))
        self.assertIn('compat-child-b', str(requests[1:3]))
        self.assertLess(abs(REQUEST_TIMES[self.request_start+1] - REQUEST_TIMES[self.request_start+2]), 2)
        self.assertIn('原生 C 回复', requests[-1][1]['messages'][-1]['content'])
        self.assertEqual(len(json.loads(self.run_c('sessions').stdout)), 1)

    def test_47_cancelling_compatibility_subagent_cleans_request_and_workers(self):
        self.compat_subagent_fixture()
        requests_dir = self.dir / 'private-requests'
        requests_dir.mkdir(mode=0o700)
        self.env['TMPDIR'] = str(requests_dir)
        child = subprocess.Popen([str(BINARY), '--config', str(self.config), 'send', '--fresh', 'compat-cancel'], env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 15
            while len(REQUESTS) < self.request_start + 2 and time.monotonic() < deadline:
                time.sleep(.03)
            self.assertGreaterEqual(len(REQUESTS), self.request_start + 2)
            started = time.monotonic()
            child.send_signal(signal.SIGINT)
            out, err = child.communicate(timeout=3)
            self.assertLess(time.monotonic() - started, 2)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn('取消', out + err)
            self.assertEqual(list(requests_dir.glob('dito-compat-subagent-*')), [])
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_48_tui_handoff_restores_terminal_and_keeps_selected_history(self):
        history = self.write_ui_history('handoff', 'retained-context', [{'role':'assistant','content':'previous-answer'}])
        original = history.read_bytes()
        self.fake_legacy_node()
        output = self.pty_process([], [b'/legacy\r'])
        handoff = json.loads(re.search(r'(\{"argv":.*\})', output)[1])
        self.assertEqual(handoff['session'], str(history))
        self.assertEqual(len(handoff['argv']), 3, 'handoff opens old TUI without sending a model prompt')
        self.assertEqual(history.read_bytes(), original)
        self.env['DITO_RESOURCE_DIR'] = str(ROOT)
        output = self.pty_process([], [(b'wait\r', .15), (b'\x1b2', .05), b'/legacy\r',
                                      b'\x1b1', b'\x1b', b'\x03'])
        self.assertIn('请先完成或取消运行中的任务', output)

    def test_49_unsupported_model_and_stored_oauth_use_compatibility(self):
        self.fake_legacy_node()
        self.value['providers'][0]['api'] = 'google-generative-ai'
        self.save()
        routed = json.loads(self.run_c('send', 'literal-model-prompt').stdout)
        self.assertEqual(routed['argv'][-2:], ['send', 'literal-model-prompt'])
        self.value['providers'][0]['api'] = 'openai-completions'
        self.value['providers'][0]['apiKey'] = ''
        self.save()
        auth = self.dir / 'agent/auth.json'
        auth.parent.mkdir(exist_ok=True)
        auth.write_text(json.dumps({'mock': {'type': 'oauth', 'access': 'fixture-access', 'refresh': 'fixture-refresh', 'expires': 9999999999999}}))
        routed = json.loads(self.run_c('send', 'stored-oauth-prompt').stdout)
        self.assertEqual(routed['argv'][-1], 'stored-oauth-prompt')
        self.assertEqual(len(REQUESTS), self.request_start)

    def test_50_encrypted_prompt_bundle_is_delegated_instead_of_ignored(self):
        self.fake_legacy_node()
        bundle = self.dir / 'private-prompts.bin'
        bundle.write_bytes(b'fixture encrypted bundle')
        self.env['DITO_PROMPT_BUNDLE'] = str(bundle)
        routed = json.loads(self.run_c('send', 'encrypted-prompt-test').stdout)
        self.assertEqual(routed['argv'][-1], 'encrypted-prompt-test')
        self.assertEqual(len(REQUESTS), self.request_start)

    def test_36_qq_reuses_existing_chat_index_and_legacy_memory_database(self):
        import sqlite3
        channel = self.dir / "private/qq"
        channel.mkdir(parents=True)
        history = channel / "qq-sessions/previous.jsonl"
        history.parent.mkdir()
        records = [{"type": "session", "version": 3, "id": "legacy", "timestamp": "2026-01-01T00:00:00Z", "cwd": str(self.dir)},
                   {"type": "message", "id": "old-user", "parentId": None, "message": {"role": "user", "content": "legacy-qq-context"}},
                   {"type": "message", "id": "old-assistant", "parentId": "old-user", "message": {"role": "assistant", "content": [{"type": "text", "text": "previous-answer"}]}}]
        original = ''.join(json.dumps(r) + '\n' for r in records)
        history.write_text(original)
        index = channel / "qq-chats.json"
        index.write_text(json.dumps({"qq-private-123": str(history), "preserve-other-chat": "/unchanged"}))
        legacy_db = self.dir / "agent/dito/memory-qq-private-123.db"
        legacy_db.parent.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(legacy_db)) as db:
            db.execute("CREATE TABLE facts(id INTEGER PRIMARY KEY,content TEXT,source TEXT,confidence REAL,recall_count INTEGER DEFAULT 0,created_at INTEGER,updated_at INTEGER)")
            db.execute("INSERT INTO facts(content,source,created_at,updated_at) VALUES(?,?,?,?)", ("restricted channel legacy fact", "user", int(time.time()*1000), int(time.time()*1000)))
            db.commit()
        self.value["channels"] = {"qq": {"url": f"ws://127.0.0.1:{self.server.server_port}/onebot", "owners": ["999"]}}
        self.save()
        self.assertEqual(self.run_c("qq", ok=False).returncode, 1)
        messages = REQUESTS[-1][1]["messages"]
        self.assertTrue(any(m.get("content") == "legacy-qq-context" for m in messages))
        self.assertIn("restricted channel legacy fact", messages[0]["content"])
        self.assertTrue(history.read_text().startswith(original))
        self.assertEqual(json.loads(index.read_text())["preserve-other-chat"], "/unchanged")
        self.assertFalse((channel / "memory-qq-private-123.db").exists())
        with contextlib.closing(sqlite3.connect(legacy_db)) as db:
            self.assertEqual(db.execute("select content from facts where id=1").fetchone()[0], "restricted channel legacy fact")

    def test_37_private_backup_includes_committed_sqlite_wal_records(self):
        import sqlite3
        import sys
        root = self.dir / "original-data"
        root.mkdir()
        session = root / "dialog.jsonl"
        session.write_text('{"kept":"original history"}\n')
        original = session.read_bytes()
        destination = self.dir / "backup"
        with contextlib.closing(sqlite3.connect(root / "memory.db")) as source:
            source.execute("PRAGMA journal_mode=WAL")
            source.execute("CREATE TABLE facts(content TEXT)")
            source.execute("INSERT INTO facts VALUES('retained WAL memory')")
            source.commit()
            result = subprocess.run([sys.executable, str(ROOT / "packaging/backup-user-data.py"), "--data-dir", str(root), "--destination", str(destination)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["complete"])
            with contextlib.closing(sqlite3.connect(destination / "memory.db")) as snapshot:
                self.assertEqual(snapshot.execute("select content from facts").fetchone()[0], 'retained WAL memory')
        self.assertEqual(session.read_bytes(), original)
        self.assertEqual((destination / session.name).read_bytes(), original)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o700)

    def test_17_anthropic_and_responses_tool_round_trips(self):
        for api in ("anthropic-messages", "openai-responses"):
            self.value["providers"][0]["api"] = api
            self.save()
            result = self.run_c("send", "--fresh", "tool")
            self.assertIn("你好😀", result.stdout)
            last = REQUESTS[-1][1]
            if api == "anthropic-messages":
                self.assertEqual(last["messages"][-1]["content"][0]["type"], "tool_result")
            else:
                self.assertTrue(any(m.get("type") == "function_call_output" for m in last["input"]))

    def test_18_file_tools_round_trip_preserves_permissions_and_symlinks(self):
        target = self.dir / "script.sh"
        target.write_text("original")
        target.chmod(0o755)
        link = self.dir / "script-link.sh"
        link.symlink_to(target)
        self.run_c("send", "--fresh", "file:" + str(link))
        self.assertTrue(link.is_symlink())
        self.assertEqual(target.read_text(), "second value")
        self.assertEqual(target.stat().st_mode & 0o777, 0o755)
        self.assertIn("second value", REQUESTS[-1][1]["messages"][-1]["content"])

    def test_19_sessions_are_readable_by_existing_pi_sdk(self):
        self.run_c("send", "--fresh", "tool")
        sessions = json.loads(self.run_c("sessions").stdout)
        script = '''import { SessionManager } from "@earendil-works/pi-coding-agent";
const session=SessionManager.open(process.argv[1]); const context=session.buildSessionContext();
if(!context.messages.some(m=>m.role==="toolResult"&&Array.isArray(m.content)))throw new Error("missing tool content");
if(!context.messages.some(m=>m.role==="assistant"&&m.usage&&Number.isFinite(m.usage.totalTokens)))throw new Error("missing usage");
console.log("pi-compatible");'''
        if not (ROOT / "legacy/node_modules/@earendil-works/pi-coding-agent").exists():
            self.skipTest("Optional legacy SDK not installed")
        result = subprocess.run(["node", "--input-type=module", "-e", script, sessions[0]["path"]],
                                cwd=ROOT / "legacy", env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("pi-compatible", result.stdout)

    def test_20_private_channel_credentials_are_saved_separately(self):
        self.run_c("config", "set", "channels.qq.accessToken", '"private-only-token"')
        saved = json.loads(self.config.read_text())
        self.assertNotIn("qq", saved.get("channels", {}))
        private = self.dir / "private/qq/config.json"
        self.assertEqual(json.loads(private.read_text())["accessToken"], "private-only-token")
        self.assertEqual(private.stat().st_mode & 0o777, 0o600)

    def test_21_onebot_fragmented_messages_and_non_owner_policy(self):
        self.value["channels"] = {"qq": {"url": f"ws://127.0.0.1:{self.server.server_port}/onebot",
                                         "owners": ["999"], "accessToken": "fixture-qq-token"}}
        self.save()
        start = len(WS_REPLIES)
        result = self.run_c("qq", ok=False)
        self.assertEqual(result.returncode, 1)  # Mock server closes the channel after its reply.
        self.assertEqual(len(WS_REPLIES), start + 1, result.stderr)
        reply = WS_REPLIES[-1]
        self.assertEqual(reply["action"], "send_private_msg")
        self.assertEqual(reply["params"]["user_id"], 123)
        self.assertIn("原生 C 回复", reply["params"]["message"])
        self.assertNotIn("思考测试", reply["params"]["message"])
        self.assertIn("无权", REQUESTS[-1][1]["messages"][-1]["content"])

    def test_51_question_options_and_custom_answer(self):
        for keys, expected in [(b"\x1b[B\r", "开始执行"), ("自定义答案😀\r".encode(), "自定义答案😀")]:
            with self.subTest(expected=expected):
                frames = []
                output = self.pty_process([], [(b"ask-options\r", .3), (keys, .35), b"\x03"], snapshots=frames)
                self.assertIn("向用户提问", output)
                self.assertIn("仅查看", output)
                self.assertIn("开始执行", output)
                self.assertEqual(REQUESTS[-1][1]["messages"][-1]["content"], expected)

    def test_52_question_skip_and_separate_session_drafts(self):
        output = self.pty_process([], [(b"ask-options\r", .25), (b"\x1b2", .05),
            (b"parallel-second\r", .25), (b"second-draft", .05), (b"\x1b1", .05),
            (b"\x1b", .3), (b"\x1b2", .05), (b"\r", .3), b"\x03"])
        requests = REQUESTS[self.request_start:]
        self.assertTrue(any(request[1]["messages"][-1].get("content") == "用户未作答" for request in requests))
        self.assertEqual(requests[-1][1]["messages"][-1]["content"], "second-draft")
        self.assertIn("fast-session-complete", output)

    def test_53_question_text_fallback_invalid_options_and_plugin_switch(self):
        self.run_c("send", "--fresh", "ask-options")
        text = REQUESTS[-1][1]["messages"][-1]["content"]
        self.assertIn("请回答", text)
        self.assertIn("开始执行", text)
        tools = {tool["function"]["name"]: tool["function"] for tool in REQUESTS[-1][1]["tools"]}
        self.assertIn("options", tools["ask_question"]["parameters"]["properties"])
        self.run_c("send", "--fresh", "ask-invalid")
        self.assertIn("参数", REQUESTS[-1][1]["messages"][-1]["content"])
        self.value["plugins"] = {"ask": {"enabled": False}, "subagent": {"enabled": False}}
        self.save()
        self.run_c("send", "--fresh", "ask-options")
        self.assertIn("无权", REQUESTS[-1][1]["messages"][-1]["content"])
        names = [tool["function"]["name"] for tool in REQUESTS[-1][1]["tools"]]
        self.assertNotIn("ask_question", names)
        self.assertNotIn("subagent", names)

    def test_54_legacy_names_visible_and_native_kb_upload_title_optional(self):
        payload = "tool-json:" + json.dumps(["upload_to_knowledge_base", {"content": "旧工具名测试", "name": "legacy-note.md"}])
        self.run_c("send", "--fresh", payload)
        self.assertIn("已保存", REQUESTS[-1][1]["messages"][-1]["content"])
        names = [tool["function"]["name"] for tool in REQUESTS[-1][1]["tools"]]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue({"remember_fact", "recall_memories", "recall_past_events", "search_knowledge_base", "read_knowledge_base",
            "list_knowledge_base", "upload_to_knowledge_base", "remove_knowledge_base"}.issubset(names))

    def test_55_compat_file_tools_real_calls_and_private_payload_cleanup(self):
        self.env.pop("DITO_DISABLE_LEGACY")
        self.env["TMPDIR"] = str(self.dir)
        original_config = self.config.read_bytes()
        directory = self.dir / "files with spaces $(literal)"
        directory.mkdir()
        (directory / "note.txt").write_text("compat-needle你好😀\n")
        for name, args in [("ls", {"path": str(directory)}), ("grep", {"pattern": "compat-needle", "path": str(directory)}),
                           ("find", {"pattern": "*.txt", "path": str(directory)})]:
            with self.subTest(name=name):
                self.run_c("send", "--fresh", "tool-json:" + json.dumps([name, args]))
                self.assertIn("note.txt", REQUESTS[-1][1]["messages"][-1]["content"])
                self.assertEqual(list(self.dir.glob("dito-compat-subagent-*")), [])
                self.assertEqual(self.config.read_bytes(), original_config)
        names = [tool["function"]["name"] for tool in REQUESTS[-1][1]["tools"]]
        self.assertTrue({"grep", "find", "ls", "aur_search", "aur_review", "aur_install", "copr_search", "copr_install"}.issubset(names))
        self.assertFalse(any(name.startswith("snowluma_") for name in names))
        self.run_c("send", "--fresh", "tool-json:" + json.dumps(["grep", {"pattern": 123}]))
        self.assertIn("参数", REQUESTS[-1][1]["messages"][-1]["content"])

    def test_56_compat_qq_catalog_and_onebot_call_are_gated(self):
        self.env.pop("DITO_DISABLE_LEGACY")
        self.value["channels"] = {"qq": {"enabled": True, "url": f"ws://127.0.0.1:{self.server.server_port}/onebot-tool"}}
        self.save()
        original_config = self.config.read_bytes()
        self.run_c("send", "--fresh", "tool-json:" + json.dumps(["snowluma_get_login_info", {}]))
        self.assertEqual(self.config.read_bytes(), original_config)
        self.assertIn("mock-qq-tool", REQUESTS[-1][1]["messages"][-1]["content"])
        names = [tool["function"]["name"] for tool in REQUESTS[-1][1]["tools"]]
        self.assertIn("qq_react", names)
        self.assertIn("qq_meme_list", names)
        self.assertEqual(len(names), len(set(names)))
        self.value["plugins"] = {"snowluma": {"enabled": False}, "system": {"enabled": False}}
        self.save()
        self.run_c("send", "--fresh", "tool-json:" + json.dumps(["snowluma_get_login_info", {}]))
        self.assertIn("无权", REQUESTS[-1][1]["messages"][-1]["content"])
        names = [tool["function"]["name"] for tool in REQUESTS[-1][1]["tools"]]
        self.assertNotIn("aur_search", names)
        self.assertNotIn("get_system_info", names)
        self.assertNotIn("qq_react", names)

    def test_57_question_mouse_selection_and_many_options(self):
        options = [f"选项 {i}" for i in range(20)]
        prompt = "tool-json:" + json.dumps(["ask_question", {"question": "滚动选项", "options": options}])
        def click(output, _):
            row = next(row for row, text in self.screen_rows(output).items() if "选项 1 " in text)
            return f"\x1b[<0;20;{row}M".encode(), .35
        ready = lambda output: "向用户提问 · ask_question" in output
        output = self.pty_process([], [(prompt.encode() + b"\r", ready), click, b"\x03"])
        self.assertEqual(REQUESTS[-1][1]["messages"][-1]["content"], "选项 1")
        prompt = "tool-json:" + json.dumps(["ask_question", {"question": "滚动选项", "options": options}])
        answered = lambda _: REQUESTS[-1][1]["messages"][-1].get("content") == "选项 19"
        output = self.pty_process([], [(prompt.encode() + b"\r", ready), (b"\x1b[A\x1b[A\r", answered), b"\x03"])
        self.assertEqual(REQUESTS[-1][1]["messages"][-1]["content"], "选项 19")

    def test_58_readme_alt_w_a_d_and_history_cycling(self):
        old = self.write_ui_history("readme-old", "older-context", [{"role": "assistant", "content": "old-answer"}])
        newest = self.write_ui_history("readme-new", "newer-context", [{"role": "assistant", "content": "new-answer"}])
        old.write_text(old.read_text().replace("2026-10-17T00:00:00Z", "2025-01-01T00:00:00Z"))
        os.utime(old, (time.time() - 100, time.time() - 100))
        old_original = old.read_bytes()
        frames = []
        self.pty_process([], [(b"draft-new", .05), (b"\x1bw", .05), (b"j\r", .05),
            (b"old-follow-up\r", .3), (b"\x1b2", .05), (b"\r", .3), b"\x03"], snapshots=frames)
        requests = REQUESTS[self.request_start:]
        self.assertEqual(len(requests), 2)
        self.assertIn("older-context", str(requests[0][1]["messages"]))
        self.assertIn("draft-new", str(requests[1][1]["messages"]))
        self.assertIn("历史会话", ''.join(frames))
        self.assertTrue(old.read_bytes().startswith(old_original))
        self.pty_process([], [(b"\x1ba", .1), (b"previous-shortcut\r", .3), (b"\x1bd", .1),
                              (b"fresh-shortcut\r", .3), b"\x03"])
        self.assertIn("older-context", str(REQUESTS[-2][1]["messages"]))
        self.assertNotIn("older-context", str(REQUESTS[-1][1]["messages"]))
        self.assertNotIn("newer-context", str(REQUESTS[-1][1]["messages"]))

    def test_59_native_slash_commands_never_become_model_prompts(self):
        output = self.pty_process([], [b"/mod\t plan\r", b"/memory-stats\r", b"/compact\r",
                                      b"/unknown-command\r", b"/new\r", b"/sessions\r", b"\x1b", b"\x03"])
        self.assertEqual(len(REQUESTS), self.request_start)
        self.assertIn("当前无需压缩", output)
        self.assertIn("未知命令", output)
        self.assertIn("计划", output)
        self.assertIn("历史会话", output)

    def test_60_old_slash_and_clipboard_handoff_keep_selected_history_and_draft(self):
        history = self.write_ui_history("slash-handoff", "preserved", [{"role": "assistant", "content": "history"}])
        original = history.read_bytes()
        self.fake_legacy_node()
        output = self.pty_process([], [b"/model\r"])
        result = json.loads(re.search(r'(\{"argv":.*\})', output)[1])
        self.assertEqual(result["startup"], "/model")
        self.assertEqual(result["session"], str(history))
        output = self.pty_process([], [b"clipboard-draft", b"\x16"])
        result = json.loads(re.search(r'(\{"argv":.*\})', output)[1])
        self.assertEqual(result["clipboard"], "1")
        self.assertEqual(result["draft"], "clipboard-draft")
        self.assertEqual(history.read_bytes(), original)
        self.assertEqual(len(REQUESTS), self.request_start)

    def test_61_manual_compaction_keeps_log_and_does_not_submit_slash_as_user(self):
        self.value["contextCompaction"] = {"enabled": True, "compactTailTokens": 40}
        self.save()
        history = self.write_ui_history("manual-compact", "old goal " + "history " * 120,
            [{"role": "assistant", "content": "old-response"}, {"role": "user", "content": "latest goal"},
             {"role": "assistant", "content": "latest-response"}])
        original = history.read_bytes()
        ready = lambda output: "上下文已压缩" in output
        output = self.pty_process([], [(b"/compact\r", ready), (b"continued\r", .35), b"\x03"])
        self.assertIn("上下文已压缩", output)
        self.assertTrue(history.read_bytes().startswith(original))
        entries = [json.loads(line) for line in history.read_text().splitlines()]
        self.assertTrue(any(entry["type"] == "compaction" for entry in entries))
        self.assertFalse(any(entry.get("message", {}).get("content") == "/compact" for entry in entries))
        self.assertTrue(any("摘要：保留用户目标" in str(message.get("content", "")) for message in REQUESTS[-1][1]["messages"]))

    def test_62_history_cycle_visits_more_than_two_tabs_and_respects_nonempty_draft(self):
        for i in range(3):
            path = self.write_ui_history(f"cycle-{i}", f"cycle-context-{i}", [{"role": "assistant", "content": "past"}])
            path.write_text(path.read_text().replace("2026-10-17T00:00:00Z", f"2025-01-0{i+1}T00:00:00Z"))
            os.utime(path, (time.time() - 100 + i, time.time() - 100 + i))
        self.pty_process([], [(b"\x1b[9;5u", .1), (b"cycle-first\r", .3),
            (b"\x1b[9;5u", .1), (b"cycle-second\r", .3), (b"\x1b[9;6u", .1),
            (b"cycle-third\r", .3), (b"retained-draft\x1b[1;3C\r", .3), b"\x03"])
        requests = REQUESTS[self.request_start:]
        self.assertEqual(len(requests), 4)
        for request, expected in zip(requests, [1, 0, 1, 1]):
            self.assertEqual([m["content"] for m in request[1]["messages"] if m["role"] == "user"][0], f"cycle-context-{expected}")

    def test_63_old_affinity_tool_and_mcp_memory_name_share_existing_data(self):
        self.env.pop("DITO_DISABLE_LEGACY")
        self.value["channels"] = {"qq": {"enabled": True}}
        self.save()
        for args, expected in [({"group_id": 1, "user_id": 2}, "50/100"),
                               ({"group_id": 1, "user_id": 2, "delta": 20}, "70/100")]:
            self.run_c("send", "--fresh", "tool-json:" + json.dumps(["qq_affinity", args]))
            self.assertIn(expected, REQUESTS[-1][1]["messages"][-1]["content"])
        scores = self.dir / "private/qq/affinity.json"
        self.assertEqual(json.loads(scores.read_text()), {"1:2": 70})
        self.run_c("send", "--fresh", "tool-json:" + json.dumps(["remember_fact", {"content": "测试偏好是原生 C 工具"}]))
        self.run_c("send", "--fresh", "tool-json:" + json.dumps(["memory_recall", {"query": "原生", "max": 1}]))
        self.assertIn("测试偏好", REQUESTS[-1][1]["messages"][-1]["content"])

    def test_64_tool_limit_retains_overflow_discovery_and_execution(self):
        self.env.pop("DITO_DISABLE_LEGACY")
        self.value["channels"] = {"qq": {"enabled": True, "url": f"ws://127.0.0.1:{self.server.server_port}/onebot-tool"}}
        self.save()
        self.run_c("send", "--fresh", "hello")
        names = [tool["function"]["name"] for tool in REQUESTS[-1][1]["tools"]]
        self.assertEqual(len(names), 128)
        self.assertIn("tool_search", names)
        self.assertIn("tool_call", names)
        self.assertIn("qq_affinity", names)
        self.assertNotIn("snowluma_get_version_info", names)
        self.run_c("send", "--fresh", "tool-json:" + json.dumps(["tool_search", {"query": "snowluma_get_version_info"}]))
        definition = json.loads(REQUESTS[-1][1]["messages"][-1]["content"])["tools"][0]
        self.assertEqual(definition["name"], "snowluma_get_version_info")
        self.assertEqual(definition["parameters"]["type"], "object")
        self.run_c("send", "--fresh", "tool-json:" + json.dumps(["tool_call", {"name": "snowluma_get_version_info", "arguments": {}}]))
        self.assertIn("mock-qq-tool", REQUESTS[-1][1]["messages"][-1]["content"])
        for api in ["openai-responses", "anthropic-messages"]:
            self.value["providers"][0]["api"] = api
            self.save()
            self.run_c("send", "--fresh", "hello")
            self.assertEqual(len(REQUESTS[-1][1]["tools"]), 128)
            self.assertIn("tool_call", [tool["name"] for tool in REQUESTS[-1][1]["tools"]])

    def test_65_copy_mode_freezes_redraw_while_background_work_continues(self):
        frames = []
        ready = lambda output: "复制模式" in output
        output = self.pty_process([], [(b"wait\r", .15), (b"\x1b[12~", ready), (b"", 2.3),
                                      (b"\x1b", .2), b"\x03"], snapshots=frames)
        self.assertIn("\x1b[?1000l\x1b[?1006l", frames[2])
        self.assertEqual(frames[3], "", "background output must not destroy terminal selection")
        self.assertIn("slow-session-complete", frames[4])
        self.assertIn("\x1b[?1000h\x1b[?1006h", frames[4])
        self.assertEqual(len(REQUESTS), self.request_start + 1)

    def test_66_copy_reply_uses_literal_utf8_clipboard_and_terminal_fallback(self):
        fake = self.dir / "clipboard-bin"
        fake.mkdir()
        clipboard = self.dir / "clipboard.txt"
        self.env["DITO_TEST_CLIPBOARD"] = str(clipboard)
        import sys
        program = fake / "wl-copy"
        program.write_text(f"#!{sys.executable}\nimport os,sys\nfrom pathlib import Path\nPath(os.environ['DITO_TEST_CLIPBOARD']).write_bytes(sys.stdin.buffer.read())\n")
        program.chmod(0o755)
        self.env["PATH"] = str(fake)
        output = self.pty_process([], [(b"hello\r", .3), b"/copy\r", b"\x03"])
        self.assertEqual(clipboard.read_text(), "原生 C 回复你好😀")
        self.assertNotIn("思考测试", clipboard.read_text())
        self.assertIn("已复制到剪贴板", output)
        program.unlink()
        output = self.pty_process([], [b"/copy\r", b"\x03"])
        encoded = re.search(r"\x1b]52;c;([A-Za-z0-9+/=]+)\x07", output)[1]
        self.assertEqual(base64.b64decode(encoded).decode(), "原生 C 回复你好😀")
        self.assertIn("已请求终端复制", output)

    def test_67_legacy_sdk_provider_limit_and_overflow_round_trip(self):
        self.compat_subagent_fixture()
        self.env["DITO_CONFIG_FILE"] = str(self.config)
        self.value["plugins"]["snowluma"] = {"enabled": True}
        self.value["channels"] = {"qq": {"enabled": True, "url": f"ws://127.0.0.1:{self.server.server_port}/onebot-tool"}}
        self.save()
        script = "const {createSession}=await import(" + json.dumps((ROOT / "legacy/bin/session.js").as_uri()) + ");" +             "const {loadConfig}=await import(" + json.dumps((ROOT / "legacy/extensions/util.js").as_uri()) + ");" +             "if(loadConfig().model.provider!=='mock')throw new Error('Refusing non-fixture provider');" +             "const {session}=await createSession({fresh:true});try{await session.prompt(" +             json.dumps("tool-json:" + json.dumps(["tool_call", {"name": "snowluma_get_version_info", "arguments": {}}])) +             ");}finally{session.dispose();}process.exit(0);"
        result = subprocess.run(["node", "--import", str(ROOT / "legacy/register-loader.mjs"), "--input-type=module", "--eval", script],
                                env=self.env, capture_output=True, text=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        models = [body for path, body in REQUESTS[self.request_start:] if path.endswith("chat/completions")]
        self.assertEqual(len(models), 2, result.stdout + result.stderr)
        self.assertTrue(all(len(body["tools"]) <= 128 for body in models))
        self.assertIn("mock-qq-tool", models[-1]["messages"][-1]["content"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
