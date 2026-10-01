import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DitoReEngine,
  DEFAULT_DITO_RE_CONFIG,
  looksLikeDitoConversation,
  resolveDitoReConfig,
} from "../extensions/plugins/dito-re.js";

test("dito-re recognizes direct Dito conversations and follow-ups", () => {
  assert.equal(looksLikeDitoConversation("蒂特，在吗"), true);
  assert.equal(looksLikeDitoConversation("你觉得 Arch 好用吗"), true);
  assert.equal(looksLikeDitoConversation("群里有人问猫粮吗"), false);

  let now = 1000;
  const engine = new DitoReEngine({ config: { directReplyChance: 1 }, random: () => 0.99, now: () => now });
  engine.markBotReply(123, "我在");
  assert.equal(engine.hasRecentBotReply(123), true);
  assert.equal(engine.decide({ groupId: 123, userId: 1, name: "甲", text: "那你呢", replyToDito: true }).shouldReply, true);
  now += DEFAULT_DITO_RE_CONFIG.followUpWindowSeconds * 1000 + 1;
  assert.equal(engine.hasRecentBotReply(123), false);
});

test("dito-re uses the matched hobby probability and preserves wake-only semantics", () => {
  const config = resolveDitoReConfig({
    defaultReplyChance: 0.2,
    topics: [{ id: "cats", name: "猫", keywords: ["猫"], replyChance: 0.7 }],
  });
  const hit = new DitoReEngine({ config, random: () => 0.69 });
  assert.equal(hit.decide({ groupId: 1, userId: 2, name: "甲", text: "今天看到一只猫", wakeOnly: false }).shouldReply, true);
  const miss = new DitoReEngine({ config, random: () => 0.7 });
  assert.equal(miss.decide({ groupId: 1, userId: 2, name: "甲", text: "今天看到一只猫", wakeOnly: false }).shouldReply, false);
  assert.equal(hit.decide({ groupId: 1, userId: 2, name: "甲", text: "今天看到一只猫", wakeOnly: true }).reason, "wake-only");
  assert.equal(hit.decide({ groupId: 1, userId: 2, name: "甲", text: "蒂特你看猫", wakeOnly: true, atMe: true }).shouldReply, true);
});

test("dito-re includes non-triggering group messages in the prompt context and persists it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dito-re-test-"));
  const file = join(dir, "context.json");
  try {
    const engine = new DitoReEngine({ historyFile: file, config: { contextMessages: 10, contextChars: 1000 } });
    engine.remember({ messageId: 1, groupId: 42, userId: 11, name: "甲", text: "大家在聊城市规划" });
    engine.remember({ messageId: 2, groupId: 42, userId: 12, name: "乙", text: "这个路口要堵了" });
    engine.remember({ messageId: 3, groupId: 42, userId: 13, name: "丙", text: "蒂特你怎么看" });
    engine.markBotReply(42, "我看看");
    engine.flush();
    const raw = JSON.parse(readFileSync(file, "utf8")) as { groups: Record<string, { messages: unknown[] }> };
    assert.equal(raw.groups["42"].messages.length, 4);
    const prompt = engine.promptContext(42, "蒂特你怎么看");
    assert.match(prompt, /城市规划/);
    assert.match(prompt, /路口要堵/);
    assert.match(prompt, /我看看/);
    assert.match(prompt, /当前需要回应/);

    const restored = new DitoReEngine({ historyFile: file, config: { contextMessages: 10, contextChars: 1000 } });
    assert.match(restored.context(42), /城市规划/);
    assert.match(restored.context(42), /蒂特你怎么看/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dito-re allows explicitly empty hobby topics", () => {
  const config = resolveDitoReConfig({ topics: [] });
  assert.deepEqual(config.topics, []);
  assert.equal(config.defaultReplyChance, DEFAULT_DITO_RE_CONFIG.defaultReplyChance);
});
