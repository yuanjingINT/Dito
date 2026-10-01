/** 离线验证私有配置拆分、旧数据迁移与会话路径兼容。 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ditoChannelDir, ditoDataDir, ditoUserDir, defaultConfig, loadConfig, saveConfig, scopedDataDir } from "../extensions/util.js";
import { migrateChannelData } from "../extensions/user-data.js";

function fixture(run: () => void, customDir = false): void {
  const root = mkdtempSync(join(tmpdir(), "dito-user-test-"));
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const prevUser = process.env.DITO_USER_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  if (customDir) process.env.DITO_USER_DIR = join(root, "private");
  else delete process.env.DITO_USER_DIR;
  try { run(); }
  finally {
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (prevUser === undefined) delete process.env.DITO_USER_DIR;
    else process.env.DITO_USER_DIR = prevUser;
    rmSync(root, { recursive: true, force: true });
  }
}

test("legacy channel settings migrate, split on save, and reload without losing credentials", () => fixture(() => {
  const original = defaultConfig();
  original.channels.qq.owners = [12345];
  original.channels.qq.groups = [54321];
  original.channels.qq.accessToken = "fixture-qq-token";
  original.channels.matrix.owners = ["@alice:example.org"];
  original.channels.matrix.accessToken = "fixture-matrix-token";
  original.channels.mobile.room = "r-fixture";
  mkdirSync(ditoDataDir(), { recursive: true });
  writeFileSync(join(ditoDataDir(), "config.json"), JSON.stringify(original));
  const loaded = loadConfig();
  assert.deepEqual(loaded.channels, original.channels);
  saveConfig(loaded);
  const general = JSON.parse(readFileSync(join(ditoDataDir(), "config.json"), "utf-8"));
  assert.equal(general.channels.qq, undefined);
  assert.equal(general.channels.matrix, undefined);
  assert.equal(general.channels.mobile.room, "r-fixture");
  assert.ok(!JSON.stringify(general).includes("fixture-qq-token"));
  assert.ok(!JSON.stringify(general).includes("fixture-matrix-token"));
  assert.deepEqual(JSON.parse(readFileSync(join(ditoChannelDir("qq"), "config.json"), "utf-8")).owners, [12345]);
  assert.deepEqual(JSON.parse(readFileSync(join(ditoChannelDir("matrix"), "config.json"), "utf-8")).owners, ["@alice:example.org"]);
  assert.deepEqual(loadConfig().channels, original.channels);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(ditoChannelDir("qq"), "config.json")).mode & 0o777, 0o600);
  }
}));

test("legacy sessions, indexes, crypto keys, scoped databases and memes are copied intact", () => fixture(() => {
  const old = ditoDataDir();
  for (const channel of ["qq", "matrix"] as const) {
    const sessions = join(old, `${channel}-sessions`);
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "conversation.jsonl");
    writeFileSync(file, '{"type":"session","id":"fixture-session"}\n');
    writeFileSync(join(old, `${channel}-chats.json`), JSON.stringify({ fixture: file }));
    writeFileSync(join(old, `memory-${channel}-fixture.db`), "memory-bytes");
    writeFileSync(join(old, `kb-${channel}-fixture.db`), "kb-bytes");
  }
  mkdirSync(join(old, "matrix-crypto-store"));
  writeFileSync(join(old, "matrix-crypto-store", "keys"), "crypto-bytes");
  mkdirSync(join(old, "memes"));
  writeFileSync(join(old, "memes", "memes.json"), "[]");
  writeFileSync(join(old, "affinity.json"), '{"fixture":75}');
  migrateChannelData(old);
  for (const channel of ["qq", "matrix"] as const) {
    const dir = ditoChannelDir(channel);
    const index = JSON.parse(readFileSync(join(dir, `${channel}-chats.json`), "utf-8"));
    assert.equal(index.fixture, join(dir, `${channel}-sessions`, "conversation.jsonl"));
    assert.equal(readFileSync(index.fixture, "utf-8"), '{"type":"session","id":"fixture-session"}\n');
    assert.equal(readFileSync(join(dir, `memory-${channel}-fixture.db`), "utf-8"), "memory-bytes");
    assert.equal(readFileSync(join(dir, `kb-${channel}-fixture.db`), "utf-8"), "kb-bytes");
    assert.ok(existsSync(join(old, `${channel}-sessions`, "conversation.jsonl")), "legacy backup remains");
  }
  assert.equal(readFileSync(join(ditoChannelDir("matrix"), "matrix-crypto-store", "keys"), "utf-8"), "crypto-bytes");
  assert.ok(existsSync(join(ditoChannelDir("qq"), "memes", "memes.json")));
  assert.equal(readFileSync(join(ditoChannelDir("qq"), "affinity.json"), "utf-8"), '{"fixture":75}');
}));

test("existing private files take precedence and migration does not overwrite them", () => fixture(() => {
  const old = ditoDataDir();
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "affinity.json"), "legacy");
  mkdirSync(ditoChannelDir("qq"), { recursive: true });
  writeFileSync(join(ditoChannelDir("qq"), "affinity.json"), "current");
  writeFileSync(join(ditoChannelDir("qq"), "config.json"), '{"owners":[12345]}');
  migrateChannelData(old);
  assert.equal(readFileSync(join(ditoChannelDir("qq"), "affinity.json"), "utf-8"), "current");
  assert.deepEqual(loadConfig().channels.qq.owners, [12345]);
}));

test("custom user directory and channel scopes isolate private databases", () => fixture(() => {
  assert.equal(ditoUserDir(), join(process.env.PI_CODING_AGENT_DIR!, "private"));
  assert.equal(scopedDataDir("qq-private-fixture"), ditoChannelDir("qq"));
  assert.equal(scopedDataDir("matrix-fixture"), ditoChannelDir("matrix"));
  assert.equal(scopedDataDir("mobile-fixture"), ditoDataDir());
  assert.equal(scopedDataDir(), ditoDataDir());
}, true));

test("malformed private config fails clearly instead of silently changing account permissions", () => fixture(() => {
  mkdirSync(ditoChannelDir("qq"), { recursive: true });
  writeFileSync(join(ditoChannelDir("qq"), "config.json"), "invalid-json");
  assert.throws(() => loadConfig(), SyntaxError);
}));

test("public defaults contain no preconfigured QQ owner or group", () => {
  assert.deepEqual(defaultConfig().channels.qq.owners, []);
  assert.deepEqual(defaultConfig().channels.qq.groups, []);
});
